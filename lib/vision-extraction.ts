import Anthropic from '@anthropic-ai/sdk';
import type { ImageTile } from '@/lib/image-tiling';
import type { ExtractedPerson, ExtractionResult } from '@/lib/extraction';
import { cachedSystemText, withToolCache } from '@/lib/anthropic-cache';
import { AnthropicUsageCollector } from '@/lib/anthropic-pricing';
import { assertLiveExtractionAllowed, EXTRACTION_MODEL } from '@/lib/models';
import { normalizeName } from '@/lib/name-standard';

export type ImageLayout = 'list' | 'grid' | 'table' | 'profile' | 'other' | 'none';

export type RawExtractedPerson = {
  full_name: string;
  title?: string;
  company?: string;
  location?: string;
  email?: string;
  phone?: string;
  linkedin_url?: string;
  confidence: 'high' | 'low';
  truncated: boolean;
};

/** Injectable seam so tests exercise tiling/reconcile/dedupe plumbing with a canned
 *  tool response instead of the live model (08 §8 / CLAUDE.md Rule 1). */
export type VisionCaller = {
  count(tile: ImageTile): Promise<{ count: number; layout: ImageLayout }>;
  extract(tile: ImageTile, expectedCount: number): Promise<{ people: RawExtractedPerson[] }>;
};

const COUNT_PROMPT = `You are counting people entries in a screenshot. Look at the image and count
how many distinct person entries (rows/cards/list items showing an
individual person) are FULLY or PARTIALLY visible. Do not list them. Reply
with a tool call only.`;

function extractPrompt() {
  return `Transcribe every person entry visible in this screenshot into structured
rows. Rules:
- One entry per distinct person, top to bottom (left-to-right first if grid).
- Copy text EXACTLY as written. Do not expand abbreviations, do not fix
  typos, do not translate. If a field is not visible for a person, omit it.
- A row cut off at the image edge: transcribe what is visible and set
  truncated=true.
- If any text is too blurry/small to read with certainty, omit that field
  and set confidence="low" for that person.
- Include a LinkedIn profile URL only if visible. Do NOT record connection
  degree (1st/2nd/3rd) — we do not store it.`;
}

function extractCountHint(count: number) {
  return `Expected entry count from a prior pass: ${count}. If you see a different number, extract what you actually see — do not pad or trim to match.`;
}

const reportCountTool: Anthropic.Tool = {
  name: 'report_count',
  description: 'Report the count of distinct person entries visible in the image.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['count', 'layout'],
    properties: {
      count: { type: 'integer', minimum: 0 },
      layout: { type: 'string', enum: ['list', 'grid', 'table', 'profile', 'other', 'none'] },
    },
  },
};

const extractPeopleTool: Anthropic.Tool = {
  name: 'extract_people',
  description: 'Report every person entry transcribed from the image.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['people'],
    properties: {
      people: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['full_name', 'confidence', 'truncated'],
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
          },
        },
      },
    },
  },
};

/** Mismatch ≥3 or >20% needs one retry (08 §2.2 Reconcile). */
export function needsRetry(counted: number, extractedLength: number): boolean {
  const diff = Math.abs(extractedLength - counted);
  const pct = counted > 0 ? diff / counted : (extractedLength > 0 ? 1 : 0);
  return diff >= 3 || pct > 0.2;
}

export function mismatchWarning(counted: number, extractedLength: number): string | null {
  if (extractedLength === counted) return null;
  const diff = Math.abs(extractedLength - counted);
  if (diff <= 2) {
    return `count close (saw ${counted}, extracted ${extractedLength}) — accepted`;
  }
  return `count mismatch (saw ${counted}, extracted ${extractedLength})`;
}

/** Retry keeps whichever attempt's length is closer to the count pass (08 §2.2). */
export function chooseRetryAttempt<T>(
  counted: number,
  first: T[],
  second: T[],
): T[] {
  const firstDiff = Math.abs(first.length - counted);
  const secondDiff = Math.abs(second.length - counted);
  return secondDiff <= firstDiff ? second : first;
}

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

function toolInput<T>(message: Anthropic.Message, toolName: string): T | null {
  const block = message.content.find(
    (item): item is Anthropic.ToolUseBlock => item.type === 'tool_use' && item.name === toolName,
  );
  return (block?.input as T) ?? null;
}

export function createLiveVisionCaller(collector?: AnthropicUsageCollector): VisionCaller {
  assertLiveExtractionAllowed();
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not configured');
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 0 });

  return {
    async count(tile) {
      const message = await callWithRetry(() => client.messages.create({
        model: EXTRACTION_MODEL,
        max_tokens: 200,
        system: cachedSystemText(COUNT_PROMPT),
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: tile.mediaType, data: tile.bytes.toString('base64') } },
          ],
        }],
        tools: [withToolCache(reportCountTool)],
        tool_choice: { type: 'tool', name: 'report_count' },
      }));
      collector?.record(message);
      const result = toolInput<{ count: number; layout: ImageLayout }>(message, 'report_count');
      if (!result) throw new Error('Vision count pass finished without report_count output');
      return result;
    },
    async extract(tile, expectedCount) {
      const message = await callWithRetry(() => client.messages.create({
        model: EXTRACTION_MODEL,
        max_tokens: expectedCount * 120 + 500,
        system: cachedSystemText(extractPrompt()),
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: tile.mediaType, data: tile.bytes.toString('base64') } },
            { type: 'text', text: extractCountHint(expectedCount) },
          ],
        }],
        tools: [withToolCache(extractPeopleTool)],
        tool_choice: { type: 'tool', name: 'extract_people' },
      }));
      collector?.record(message);
      const result = toolInput<{ people: RawExtractedPerson[] }>(message, 'extract_people');
      if (!result) throw new Error('Vision extract pass finished without extract_people output');
      return result;
    },
  };
}

function rawToExtracted(raw: RawExtractedPerson, uploadId: string, locator: string): ExtractedPerson | null {
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
    provenance: { upload_id: uploadId, locator },
  };
}

/** Runs the two-pass count → extract → reconcile protocol on a single tile (08 §2.2). */
export async function extractFromTile(
  tile: ImageTile,
  caller: VisionCaller,
  uploadId: string,
): Promise<{ people: ExtractedPerson[]; warnings: string[]; counted: number }> {
  const locatorPrefix = tile.total > 1 ? `image:tile:${tile.index + 1}` : 'image';
  const counted = await caller.count(tile);
  if (counted.layout === 'none' || counted.count === 0) {
    return { people: [], warnings: [], counted: 0 };
  }

  let attempt = await caller.extract(tile, counted.count);
  const warnings: string[] = [];
  if (needsRetry(counted.count, attempt.people.length)) {
    const retry = await caller.extract(tile, counted.count);
    const chosen = chooseRetryAttempt(counted.count, attempt.people, retry.people);
    attempt = { people: chosen };
    const warning = mismatchWarning(counted.count, attempt.people.length);
    if (warning) warnings.push(warning);
  } else {
    const warning = mismatchWarning(counted.count, attempt.people.length);
    if (warning) warnings.push(warning);
  }

  const people: ExtractedPerson[] = [];
  attempt.people.forEach((raw, index) => {
    const person = rawToExtracted(raw, uploadId, `${locatorPrefix}/row:${index + 1}`);
    if (person) {
      people.push(person);
    } else {
      warnings.push(`${locatorPrefix}/row:${index + 1}: unreadable name, entry skipped`);
    }
  });
  return { people, warnings, counted: counted.count };
}

/**
 * Keyed on name alone (not name+company): within one image's tiles, a repeated
 * name is overwhelmingly the same physical row split by tile overlap, and a
 * duplicate mention often omits fields (e.g. company) the other mention has —
 * requiring company agreement would defeat the richest-field-wins merge below.
 * Cross-upload/cross-document disambiguation (where company matters) is Stage
 * D's job (`lib/identity.ts`), not this within-image dedupe.
 */
function dedupeKey(person: ExtractedPerson) {
  return normalizeName(person.full_name).fullName.toLowerCase();
}

/** Richest-field-wins union for the same person recurring across overlapping tiles (08 §2.3). */
function mergePerson(existing: ExtractedPerson, next: ExtractedPerson): ExtractedPerson {
  return {
    ...existing,
    title: existing.title ?? next.title,
    company: existing.company ?? next.company,
    location: existing.location ?? next.location,
    email: existing.email ?? next.email,
    email_alt_1: existing.email_alt_1 ?? next.email_alt_1,
    email_alt_2: existing.email_alt_2 ?? next.email_alt_2,
    phone: existing.phone ?? next.phone,
    linkedin_url: existing.linkedin_url ?? next.linkedin_url,
    confidence: existing.confidence === 'high' || next.confidence === 'high' ? 'high' : 'low',
    truncated: existing.truncated && next.truncated,
  };
}

export function dedupeExtractedPeople(people: ExtractedPerson[]): ExtractedPerson[] {
  const byKey = new Map<string, ExtractedPerson>();
  const order: string[] = [];
  for (const person of people) {
    const key = dedupeKey(person);
    const existing = byKey.get(key);
    if (existing) {
      byKey.set(key, mergePerson(existing, person));
    } else {
      byKey.set(key, person);
      order.push(key);
    }
  }
  return order.map((key) => byKey.get(key)!);
}

export async function extractPeopleFromTiles(
  tiles: ImageTile[],
  uploadId: string,
  caller: VisionCaller,
): Promise<ExtractionResult> {
  const allPeople: ExtractedPerson[] = [];
  const warnings: string[] = [];
  let totalCounted = 0;
  for (const tile of tiles) {
    const result = await extractFromTile(tile, caller, uploadId);
    allPeople.push(...result.people);
    warnings.push(...result.warnings);
    totalCounted += result.counted;
  }
  const deduped = dedupeExtractedPeople(allPeople);

  const lowConfidenceOnlyName = deduped.filter((person) =>
    person.confidence === 'low' && !person.title && !person.company && !person.location && !person.email,
  );
  if (deduped.length > 0 && lowConfidenceOnlyName.length / deduped.length > 0.5) {
    return {
      people: [],
      counted: totalCounted || null,
      warnings: ['image too low-resolution to transcribe reliably — re-screenshot at higher zoom'],
    };
  }

  return { people: deduped, counted: totalCounted || null, warnings };
}

