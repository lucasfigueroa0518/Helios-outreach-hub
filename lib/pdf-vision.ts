import Anthropic from '@anthropic-ai/sdk';
import { PDFDocument } from 'pdf-lib';
import type { ExtractedPerson, ExtractionResult } from '@/lib/extraction';
import { cachedSystemText, withToolCache } from '@/lib/anthropic-cache';
import { AnthropicUsageCollector } from '@/lib/anthropic-pricing';
import { assertLiveExtractionAllowed, EXTRACTION_MODEL } from '@/lib/models';

const MAX_PAGES_PER_CALL = 90;

export type RawPdfPerson = {
  full_name: string;
  title?: string;
  company?: string;
  location?: string;
  email?: string;
  phone?: string;
  linkedin_url?: string;
  confidence: 'high' | 'low';
  truncated: boolean;
  /** 1-indexed page WITHIN the bytes sent for this call. */
  page: number;
};

export type PdfCaller = {
  extract(pdfBytes: Buffer, pageCount: number): Promise<{ people: RawPdfPerson[]; pages_with_people: number[] }>;
};

export type PdfChunk = { bytes: Buffer; startPage: number; pageCount: number };

/** >90-page ingestion cap (Anthropic doc limit) → split into 90-page chunks (08 §3.1). */
export async function splitPdfIntoChunks(bytes: Buffer): Promise<PdfChunk[]> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const totalPages = doc.getPageCount();
  if (totalPages <= MAX_PAGES_PER_CALL) {
    return [{ bytes, startPage: 1, pageCount: totalPages }];
  }
  const chunks: PdfChunk[] = [];
  for (let start = 0; start < totalPages; start += MAX_PAGES_PER_CALL) {
    const end = Math.min(start + MAX_PAGES_PER_CALL, totalPages);
    const chunkDoc = await PDFDocument.create();
    const indices = Array.from({ length: end - start }, (_, i) => start + i);
    const pages = await chunkDoc.copyPages(doc, indices);
    pages.forEach((page) => chunkDoc.addPage(page));
    const chunkBytes = Buffer.from(await chunkDoc.save());
    chunks.push({ bytes: chunkBytes, startPage: start + 1, pageCount: end - start });
  }
  return chunks;
}

function extractDocumentPrompt() {
  return `Transcribe every person entry visible in this document into structured
rows. Rules:
- One entry per distinct person entry (attendee list row, LP entry, bio,
  etc.) — not authors, bylines, or people only mentioned in passing prose.
- Copy text EXACTLY as written. Do not expand abbreviations, do not fix
  typos, do not translate. If a field is not visible for a person, omit it.
- A row cut off / partially visible: transcribe what is visible and set
  truncated=true.
- If any text is too blurry/small to read with certainty, omit that field
  and set confidence="low" for that person.
- Include a LinkedIn profile URL only if visible. Do NOT record connection
  degree (1st/2nd/3rd) — we do not store it.
- Report the 1-indexed page number each person appears on via "page", and
  list every page containing at least one person in "pages_with_people".`;
}

const extractDocumentTool: Anthropic.Tool = {
  name: 'extract_people',
  description: 'Report every person entry transcribed from the document, with the page each appears on.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['people', 'pages_with_people'],
    properties: {
      people: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['full_name', 'confidence', 'truncated', 'page'],
          properties: {
            full_name: { type: 'string' },
            title: { type: 'string' },
            company: { type: 'string' },
            location: { type: 'string' },
            email: { type: 'string' },
            phone: { type: 'string' },
            linkedin_url: { type: 'string' },
            confidence: { type: 'string', enum: ['high', 'low'] },
            truncated: { type: 'boolean' },
            page: { type: 'integer', minimum: 1 },
          },
        },
      },
      pages_with_people: { type: 'array', items: { type: 'integer', minimum: 1 } },
    },
  },
};

function isRetryableApiError(error: unknown): boolean {
  if (error instanceof Anthropic.APIError) return error.status === undefined || error.status >= 500;
  return true;
}

async function callWithRetry<T>(fn: () => Promise<T>): Promise<T> {
  const backoffMs = [2000, 8000];
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= backoffMs.length || !isRetryableApiError(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, backoffMs[attempt]));
    }
  }
}

export function createLivePdfCaller(collector?: AnthropicUsageCollector): PdfCaller {
  assertLiveExtractionAllowed();
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not configured');
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 0 });

  return {
    async extract(pdfBytes, pageCount) {
      const message = await callWithRetry(() => client.messages.create({
        model: EXTRACTION_MODEL,
        max_tokens: Math.min(8000, pageCount * 200 + 500),
        system: cachedSystemText(extractDocumentPrompt()),
        messages: [{
          role: 'user',
          content: [
            { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBytes.toString('base64') } },
          ],
        }],
        tools: [withToolCache(extractDocumentTool)],
        tool_choice: { type: 'tool', name: 'extract_people' },
      }));
      collector?.record(message);
      const block = message.content.find(
        (item): item is Anthropic.ToolUseBlock => item.type === 'tool_use' && item.name === 'extract_people',
      );
      const result = block?.input as { people: RawPdfPerson[]; pages_with_people: number[] } | undefined;
      if (!result) throw new Error('PDF extraction finished without extract_people output');
      return result;
    },
  };
}

function rawToExtracted(raw: RawPdfPerson, uploadId: string, absolutePage: number): ExtractedPerson | null {
  if (!raw.full_name?.trim()) return null;
  return {
    full_name: raw.full_name.trim(),
    ...(raw.title ? { title: raw.title } : {}),
    ...(raw.company ? { company: raw.company } : {}),
    ...(raw.location ? { location: raw.location } : {}),
    ...(raw.email ? { email: raw.email } : {}),
    ...(raw.phone ? { phone: raw.phone } : {}),
    ...(raw.linkedin_url ? { linkedin_url: raw.linkedin_url } : {}),
    confidence: raw.confidence === 'high' ? 'high' : 'low',
    truncated: Boolean(raw.truncated),
    provenance: { upload_id: uploadId, locator: `pdf:p${absolutePage}` },
  };
}

export async function extractPeopleFromPdfChunks(
  chunks: PdfChunk[],
  uploadId: string,
  caller: PdfCaller,
): Promise<ExtractionResult> {
  const people: ExtractedPerson[] = [];
  const warnings: string[] = [];
  for (const chunk of chunks) {
    const result = await caller.extract(chunk.bytes, chunk.pageCount);
    for (const raw of result.people) {
      const person = rawToExtracted(raw, uploadId, chunk.startPage + raw.page - 1);
      if (person) {
        people.push(person);
      } else {
        warnings.push(`pdf:p${chunk.startPage + raw.page - 1}: unreadable name, entry skipped`);
      }
    }
  }
  return { people, counted: null, warnings };
}

export async function extractPeopleFromPdfBytes(
  bytes: Buffer,
  uploadId: string,
  caller?: PdfCaller,
): Promise<ExtractionResult> {
  const chunks = await splitPdfIntoChunks(bytes);
  const collector = caller ? undefined : new AnthropicUsageCollector();
  const resolvedCaller = caller ?? createLivePdfCaller(collector);
  const result = await extractPeopleFromPdfChunks(chunks, uploadId, resolvedCaller);
  const billed = collector?.price({ modelId: EXTRACTION_MODEL });
  if (billed) result.billedUsage = billed;
  return result;
}
