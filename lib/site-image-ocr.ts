import { createRequire } from 'node:module';

export type SiteOcr = (bytes: Buffer) => Promise<string>;

const require = createRequire(import.meta.url);
let workerPromise: Promise<{
  recognize: (image: Buffer) => Promise<{ data: { text?: string } }>;
}> | null = null;

function looksLikeImage(bytes: Buffer) {
  if (bytes.byteLength < 100) return false;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return true;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return true;
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return true;
  if (bytes.byteLength >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return true;
  return false;
}

async function localWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      const { createWorker } = await import('tesseract.js');
      const language = require('@tesseract.js-data/eng') as {
        code: string;
        langPath: string;
        gzip: boolean;
      };
      return createWorker(language.code, 1, {
        langPath: language.langPath,
        gzip: language.gzip,
        logger: () => undefined,
      });
    })();
  }
  return workerPromise;
}

/** Never throws — OCR is optional and must not take down enrichment. */
export async function readImageText(bytes: Buffer) {
  if (!looksLikeImage(bytes)) return '';
  try {
    const worker = await localWorker();
    const result = await worker.recognize(bytes);
    return result.data.text?.trim() ?? '';
  } catch {
    return '';
  }
}
