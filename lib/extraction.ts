import { createHash } from 'node:crypto';
import mammoth from 'mammoth';
import Papa from 'papaparse';
import { PDFDocument } from 'pdf-lib';
import * as XLSX from 'xlsx';
import JSZip from 'jszip';
import {
  assertLiveExtractionAllowed,
  isLinkedinRelationshipHeader,
  LINKEDIN_RELATIONSHIP_LABEL,
  mapColumnsOffline,
  type CanonicalField,
} from '@/lib/models';
import { sniffUpload } from '@/lib/upload-types';
import { extractPeopleFromPdfBytes } from '@/lib/pdf-vision';

export type ExtractedPerson = {
  full_name: string;
  title?: string;
  company?: string;
  location?: string;
  email?: string;
  email_alt_1?: string;
  email_alt_2?: string;
  phone?: string;
  linkedin_url?: string;
  /**
   * Non-canonical columns from a tabular upload, keyed by their (normalized) header.
   * Carries LinkedIn relationship status and any caller-added columns through to the
   * sheet and drafting input. Empty/absent for prose, image, and PDF extraction.
   */
  extra?: Record<string, string>;
  confidence: 'high' | 'low';
  truncated: boolean;
  provenance: { upload_id: string; locator: string };
};

export type ExtractionResult = {
  people: ExtractedPerson[];
  counted: number | null;
  warnings: string[];
};

const emailPattern = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const linkedInPattern = /https?:\/\/(?:www\.)?linkedin\.com\/in\/[^\s)>]+/gi;

export function sha256(bytes: Buffer) {
  return createHash('sha256').update(bytes).digest('hex');
}

function decodeText(bytes: Buffer) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString('utf16le');
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = Buffer.from(bytes.subarray(2)).swap16();
    return swapped.toString('utf16le');
  }
  return bytes.toString('utf8');
}

function validEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function personFromRow(
  row: Record<string, string>,
  mapping: Record<string, CanonicalField>,
  uploadId: string,
  locator: string,
): ExtractedPerson | null {
  const values: Partial<Record<CanonicalField, string>> = {};
  for (const [header, field] of Object.entries(mapping)) {
    const value = row[header]?.trim();
    if (value) values[field] = value;
  }
  const fullName = values.full_name
    ?? [values.first_name, values.last_name].filter(Boolean).join(' ').trim();
  if (!fullName) return null;
  const extra = collectExtraFields(row, mapping);
  return {
    full_name: fullName,
    ...(values.title ? { title: values.title } : {}),
    ...(values.company ? { company: values.company } : {}),
    ...(values.location ? { location: values.location } : {}),
    ...(values.email && validEmail(values.email) ? { email: values.email } : {}),
    ...(values.email_alt_1 && validEmail(values.email_alt_1) ? { email_alt_1: values.email_alt_1 } : {}),
    ...(values.email_alt_2 && validEmail(values.email_alt_2) ? { email_alt_2: values.email_alt_2 } : {}),
    ...(values.phone ? { phone: values.phone } : {}),
    ...(values.linkedin_url ? { linkedin_url: values.linkedin_url } : {}),
    ...(Object.keys(extra).length ? { extra } : {}),
    confidence: 'high',
    truncated: false,
    provenance: { upload_id: uploadId, locator },
  };
}

/**
 * Every non-empty column that did NOT map to a canonical field, keyed by its header
 * (LinkedIn relationship headers normalized to a stable label). This is what carries
 * arbitrary uploaded columns through to the review sheet and drafting input.
 */
function collectExtraFields(
  row: Record<string, string>,
  mapping: Record<string, CanonicalField>,
): Record<string, string> {
  const extra: Record<string, string> = {};
  for (const header of Object.keys(row)) {
    if (header in mapping) continue;
    const label = header.trim();
    if (!label) continue;
    const value = row[header]?.trim();
    if (!value) continue;
    const key = isLinkedinRelationshipHeader(header) ? LINKEDIN_RELATIONSHIP_LABEL : label;
    extra[key] = value;
  }
  return extra;
}

function tabularResult(
  rows: Record<string, string>[],
  headers: string[],
  uploadId: string,
  prefix: string,
): ExtractionResult {
  const warnings: string[] = [];
  const mapping = mapColumnsOffline(headers);
  const people = rows.flatMap((row, index) => {
    const person = personFromRow(row, mapping, uploadId, `${prefix}:row:${index + 2}`);
    if (!person) warnings.push(`row ${index + 2}: no recognizable name`);
    return person ? [person] : [];
  });
  return { people, counted: null, warnings };
}

function parseDelimited(bytes: Buffer, uploadId: string, prefix: 'csv' | 'tsv'): ExtractionResult {
  const text = decodeText(bytes);
  const delimiter = prefix === 'tsv' ? '\t' : undefined;
  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
    delimiter,
  });
  const headers = parsed.meta.fields ?? [];
  if (!headers.length) return { people: [], counted: null, warnings: ['File has no usable columns'] };
  const result = tabularResult(parsed.data, headers, uploadId, prefix);
  result.warnings.push(...parsed.errors.map((error) => `CSV parse: ${error.message}`));
  return result;
}

function parseXlsx(bytes: Buffer, uploadId: string): ExtractionResult {
  const workbook = XLSX.read(bytes, { type: 'buffer' });
  const combined: ExtractionResult = { people: [], counted: null, warnings: [] };
  for (const sheetName of workbook.SheetNames) {
    const rows = XLSX.utils.sheet_to_json<Record<string, string>>(workbook.Sheets[sheetName], { defval: '' });
    const headers = rows.length ? Object.keys(rows[0]) : [];
    if (rows.length < 1 || !headers.length) continue;
    const result = tabularResult(rows, headers, uploadId, `xlsx:${sheetName}`);
    combined.people.push(...result.people);
    combined.warnings.push(...result.warnings);
  }
  return combined;
}

function parsePlainText(text: string, uploadId: string, locator: string): ExtractionResult {
  const emails = text.match(emailPattern) ?? [];
  const linkedIn = text.match(linkedInPattern) ?? [];
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const people: ExtractedPerson[] = [];
  for (const [index, line] of lines.entries()) {
    const email = line.match(emailPattern)?.[0];
    // Offline mode only emits clear "Name — Title at Company" lines. Rich
    // prose/image extraction is handled by the live model after approval.
    const match = line.match(/^([A-Z][\p{L}' -]{2,})(?:\s+[—–,-]\s+)(.+)$/u);
    if (!match) continue;
    people.push({
      full_name: match[1].trim(),
      ...(email ? { email } : {}),
      title: match[2].replace(email ?? '', '').trim() || undefined,
      confidence: 'high',
      truncated: false,
      provenance: { upload_id: uploadId, locator: `${locator}:line:${index + 1}` },
    });
  }
  return {
    people,
    counted: null,
    warnings: people.length ? [] : ['No structured people entries found in text (live extraction is required for prose)'],
  };
}

export async function extractUpload(
  bytes: Buffer,
  fileName: string,
  uploadId: string,
): Promise<ExtractionResult> {
  const kind = sniffUpload(fileName, bytes);
  if (!kind) return { people: [], counted: null, warnings: ['Unsupported file type'] };

  if (kind.kind === 'csv') return parseDelimited(bytes, uploadId, fileName.endsWith('.tsv') ? 'tsv' : 'csv');
  if (kind.kind === 'xlsx') return parseXlsx(bytes, uploadId);
  if (kind.kind === 'text') return parsePlainText(decodeText(bytes), uploadId, 'text');
  if (kind.kind === 'docx') {
    const result = await mammoth.extractRawText({ buffer: bytes });
    return parsePlainText(result.value, uploadId, 'docx:body');
  }
  if (kind.kind === 'pptx') {
    const zip = await JSZip.loadAsync(bytes);
    const slides = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
    const text = (await Promise.all(slides.map(async (name) => (await zip.file(name)?.async('text')) ?? ''))).join('\n');
    return parsePlainText(text.replace(/<[^>]+>/g, ' '), uploadId, 'pptx:slide');
  }
  if (kind.kind === 'pdf') {
    if (!liveExtractionEnabled()) {
      const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true });
      return {
        people: [],
        counted: null,
        warnings: [`PDF has ${pdf.getPageCount()} pages; live document extraction is disabled in offline mode`],
      };
    }
    return extractPeopleFromPdfBytes(bytes, uploadId);
  }

  return extractImage(bytes, kind.mimeType, uploadId);
}

/** `EXTRACTION_MODE=live` gate (lib/models.ts) — offline dev/test runs never call the live model. */
function liveExtractionEnabled() {
  try {
    assertLiveExtractionAllowed();
    return true;
  } catch {
    return false;
  }
}

async function extractImage(bytes: Buffer, mimeType: string, uploadId: string): Promise<ExtractionResult> {
  if (bytes.byteLength < 10_000) {
    return { people: [], counted: null, warnings: ['image too low-resolution to transcribe reliably — re-screenshot at higher zoom'] };
  }
  if (!liveExtractionEnabled()) {
    return {
      people: [],
      counted: null,
      warnings: ['Image extraction is queued for live model mode; no model call was made in offline mode'],
    };
  }
  // Deferred: `lib/image-vision.ts` is only loaded when a live image is processed.
  try {
    const { extractPeopleFromImageBytes } = await import('@/lib/image-vision');
    return await extractPeopleFromImageBytes(bytes, mimeType, uploadId);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Image extraction failed';
    return { people: [], counted: null, warnings: [message] };
  }
}
