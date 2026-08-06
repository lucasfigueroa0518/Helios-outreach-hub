import { inflateSync } from 'node:zlib';

const MAX_PDF_BYTES = 8 * 1024 * 1024;
const MAX_STREAMS = 160;
const MAX_TEXT_CHARS = 2_000_000;
const MAX_STREAM_OUTPUT_BYTES = 1_000_000;
const MAX_TOTAL_DECOMPRESSED_BYTES = 8_000_000;

function decodePdfLiteral(value: string) {
  return value.replace(/\\([0-7]{1,3}|[nrtbf()\\]|\r?\n)/g, (_, escape: string) => {
    if (/^[0-7]/.test(escape)) return String.fromCharCode(Number.parseInt(escape, 8));
    if (escape === 'n') return '\n';
    if (escape === 'r') return '\r';
    if (escape === 't') return '\t';
    if (escape === 'b') return '\b';
    if (escape === 'f') return '\f';
    if (escape === '\n' || escape === '\r\n') return '';
    return escape;
  });
}

function extractTextOperators(content: string) {
  const blocks = content.match(/\bBT\b[\s\S]*?\bET\b/g) ?? [];
  const output: string[] = [];
  for (const block of blocks) {
    const blockOutput: string[] = [];
    for (const match of block.matchAll(/\(((?:\\.|[^\\()])*)\)\s*(?:Tj|'|")/g)) {
      blockOutput.push(decodePdfLiteral(match[1]));
    }
    for (const match of block.matchAll(/<([0-9a-fA-F]+)>\s*Tj/g)) {
      const hex = match[1].length % 2 ? `${match[1]}0` : match[1];
      blockOutput.push(Buffer.from(hex, 'hex').toString('latin1'));
    }
    for (const array of block.matchAll(/\[((?:.|\r|\n)*?)\]\s*TJ/g)) {
      for (const text of array[1].matchAll(/\(((?:\\.|[^\\()])*)\)/g)) {
        blockOutput.push(decodePdfLiteral(text[1]));
      }
      for (const hexText of array[1].matchAll(/<([0-9a-fA-F]+)>/g)) {
        blockOutput.push(Buffer.from(hexText[1], 'hex').toString('latin1'));
      }
    }
    if (blockOutput.length) output.push(blockOutput.join(' '));
  }
  return output.join('\n\f\n');
}

export function extractPdfText(bytes: Buffer) {
  if (!bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
    return { text: '', streamsRead: 0, error: 'not_pdf' as const };
  }
  if (bytes.byteLength > MAX_PDF_BYTES) {
    return { text: '', streamsRead: 0, error: 'pdf_too_large' as const };
  }

  const source = bytes.toString('latin1');
  const output: string[] = [];
  let streamsRead = 0;
  let decompressedBytes = 0;
  for (const match of source.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    if (streamsRead >= MAX_STREAMS || output.join(' ').length >= MAX_TEXT_CHARS) break;
    streamsRead++;
    const header = source.slice(Math.max(0, (match.index ?? 0) - 400), match.index);
    let stream = Buffer.from(match[1], 'latin1');
    if (/\/Filter\s*(?:\/FlateDecode|\[\s*\/FlateDecode)/.test(header)) {
      try {
        stream = inflateSync(stream, { maxOutputLength: MAX_STREAM_OUTPUT_BYTES });
      } catch {
        continue;
      }
    } else if (/\/Filter\b/.test(header)) {
      continue;
    }
    decompressedBytes += stream.byteLength;
    if (decompressedBytes > MAX_TOTAL_DECOMPRESSED_BYTES) {
      return { text: '', streamsRead, error: 'pdf_decompressed_too_large' as const };
    }
    const text = extractTextOperators(stream.toString('latin1'));
    if (text) output.push(text);
  }
  const text = output.join('\n\f\n')
    .replace(/[^\S\f]+/g, ' ')
    .trim()
    .slice(0, MAX_TEXT_CHARS);
  return {
    text,
    streamsRead,
    error: text ? null : 'no_extractable_text' as const,
  };
}
