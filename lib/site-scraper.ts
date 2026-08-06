// Zero-cost, bounded crawler for person-specific literal email evidence.
import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { extractPdfText } from '@/lib/pdf-text';
import {
  buildNameSearchVariants,
  firstNameAliases,
  normalizePersonToken,
  personNameParts,
} from '@/lib/person-name-aliases';
import { renderSitePage, type SiteRenderFetch } from '@/lib/site-browser-render';
import type { SiteOcr } from '@/lib/site-image-ocr';

export type SiteScraperPerson = {
  full_name: string;
  first_name?: string;
  last_name?: string;
};

export type SiteScraperFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type DirectEmailMatch = {
  email: string;
  source_url: string;
  content_hash: string;
  context: string;
  extraction_method?: 'html' | 'pdf' | 'rendered_html' | 'image_ocr';
  provisional?: boolean;
  refetch_outcome?: DirectEmailVerification['failure_class'];
  refetch_attempted_at?: string;
};

export type ScrapePageOutcome =
  | 'fetched_html'
  | 'fetched_rendered'
  | 'fetched_pdf'
  | 'fetched_image_ocr'
  | 'skipped_robots'
  | 'skipped_duplicate'
  | 'skipped_queue_full'
  | 'error_timeout'
  | 'error_dns'
  | 'error_http'
  | 'error_tls'
  | 'error_too_large'
  | 'error_blocked'
  | 'error_render_failed'
  | 'error_ocr_failed'
  | 'error_unsafe_url'
  | 'error_aborted_deadline'
  | 'error_unknown';

export type ScrapePathError = {
  url: string;
  path: string;
  error: string;
  status?: number;
  outcome?: ScrapePageOutcome;
  attempt?: number;
};

export type ScrapeDiagnostics = {
  pagesAttempted: number;
  pagesFetched: number;
  pathsAttempted: string[];
  pathsHit: string[];
  errors: ScrapePathError[];
  deadlineExceeded: boolean;
  outcomes: Partial<Record<ScrapePageOutcome, number>>;
  pageOutcomes: Array<{
    url: string;
    path: string;
    outcome: ScrapePageOutcome;
    attempt: number;
    durationMs: number;
    status?: number;
    error?: string;
  }>;
  retries: number;
  renderedPages: number;
  ocrImages: number;
  nicknameMatches: number;
  localPartMatches: number;
  throttled: number;
};

export type SiteScraperOptions = {
  fetch?: SiteScraperFetch;
  fetchImpl?: SiteScraperFetch;
  preferredCachedPaths?: string[];
  preferredPaths?: string[];
  additionalEvidenceUrls?: string[];
  concurrency?: number;
  deadlineMs?: number;
  maxPages?: number;
  maxRetries?: number;
  maxRenderedPages?: number;
  maxOcrImages?: number;
  renderFetch?: SiteRenderFetch;
  ocrImpl?: SiteOcr;
};

export type VerifyDirectEmailSourceInput = {
  source_url: string;
  email: string;
  person_name?: string;
  full_name?: string;
  domain?: string;
  source_quote?: string;
};

export type DirectEmailVerification = {
  verified: boolean;
  provisional?: boolean;
  refetch_attempted?: boolean;
  failure_class?: 'blocked' | 'timeout' | 'email_absent' | 'person_unbound' | 'invalid';
  source_url: string;
  email: string;
  person_name: string;
  content_hash?: string;
  context?: string;
  error?: string;
};

/**
 * Backwards-compatible Map result for enrichment.ts. New callers can use
 * `result.matches` and `result.diagnostics`.
 */
export class ScrapeDirectEmailResult extends Map<string, DirectEmailMatch> {
  readonly diagnostics: ScrapeDiagnostics;

  constructor(diagnostics: Omit<ScrapeDiagnostics,
    'outcomes' | 'pageOutcomes' | 'retries' | 'renderedPages' | 'ocrImages'
    | 'nicknameMatches' | 'localPartMatches' | 'throttled'>
    & Partial<Pick<ScrapeDiagnostics,
      'outcomes' | 'pageOutcomes' | 'retries' | 'renderedPages' | 'ocrImages'
      | 'nicknameMatches' | 'localPartMatches' | 'throttled'>>) {
    super();
    const normalized = diagnostics as ScrapeDiagnostics;
    normalized.outcomes ??= {};
    normalized.pageOutcomes ??= [];
    normalized.retries ??= 0;
    normalized.renderedPages ??= 0;
    normalized.ocrImages ??= 0;
    normalized.nicknameMatches ??= 0;
    normalized.localPartMatches ??= 0;
    normalized.throttled ??= 0;
    this.diagnostics = normalized;
  }

  get matches(): ReadonlyMap<string, DirectEmailMatch> {
    return this;
  }
}

type PageContent = {
  url: URL;
  decoded: string;
  plainText: string;
  contentHash: string;
  links: URL[];
  sitemapLinks: URL[];
  robotsDisallow: string[];
  contentType: string;
  rendered: boolean;
};

type EmailOccurrence = {
  email: string;
  index: number;
};

const PEOPLE_PATH_WORDS = [
  'team', 'our-team', 'people', 'our-people', 'leadership', 'executives',
  'management', 'staff', 'directory', 'professionals', 'partners', 'advisors',
  'experts', 'attorneys', 'consultants', 'investment-team', 'investment-professionals',
  'governance', 'board', 'board-of-directors', 'biographies', 'profiles',
] as const;
const CONTACT_PATH_WORDS = [
  'contact', 'contact-us', 'connect', 'get-in-touch', 'locations', 'offices',
] as const;
const SECTION_PREFIXES = [
  '', 'about', 'about-us', 'company', 'firm', 'who-we-are',
] as const;
const LOCALE_PREFIXES = ['', 'en', 'en-us', 'us', 'us/en'] as const;

function generatedStaticPaths() {
  const paths = new Set<string>([
    '/about', '/about-us', '/company', '/firm', '/who-we-are',
    '/news', '/press', '/media', '/resources', '/insights', '/publications',
    '/investments', '/portfolio',
  ]);
  for (const locale of LOCALE_PREFIXES) {
    for (const section of SECTION_PREFIXES) {
      for (const leaf of [...PEOPLE_PATH_WORDS, ...CONTACT_PATH_WORDS]) {
        paths.add(`/${[locale, section, leaf].filter(Boolean).join('/')}`);
      }
    }
  }
  return [...paths];
}

const STATIC_PATHS = generatedStaticPaths();

const GENERIC_LOCAL_PARTS = new Set([
  'admin', 'billing', 'careers', 'compliance', 'contact', 'customerservice',
  'enquiries', 'events', 'hello', 'help', 'hr', 'info', 'inquiries', 'investors',
  'jobs', 'legal', 'marketing', 'media', 'office', 'operations', 'privacy',
  'reception', 'sales', 'security', 'service', 'support', 'team',
]);

const COMMON_ENTITIES: Record<string, string> = {
  amp: '&',
  apos: "'",
  commat: '@',
  gt: '>',
  lt: '<',
  nbsp: ' ',
  period: '.',
  quot: '"',
};

const EMAIL_RE = /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,63}/giu;

let globalActiveRequests = 0;
const globalWaiters: Array<() => void> = [];

async function acquireGlobalSlot(limit: number) {
  if (globalActiveRequests >= limit) {
    await new Promise<void>((resolve) => globalWaiters.push(resolve));
  }
  globalActiveRequests++;
  return () => {
    globalActiveRequests = Math.max(0, globalActiveRequests - 1);
    globalWaiters.shift()?.();
  };
}

function incrementOutcome(diagnostics: ScrapeDiagnostics, outcome: ScrapePageOutcome) {
  diagnostics.outcomes[outcome] = (diagnostics.outcomes[outcome] ?? 0) + 1;
}

function normalizeHost(value: string) {
  return value.trim().toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
}

function normalizeDomain(value: string) {
  const trimmed = value.trim();
  try {
    return normalizeHost(new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`).hostname);
  } catch {
    return '';
  }
}

function normalizeName(value: string) {
  return value.normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function compactName(value: string) {
  return normalizeName(value).replace(/\s+/g, '');
}

function decodeHtmlEntities(value: string) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);?/gi, (entity, body: string) => {
    const key = body.toLowerCase();
    if (key.startsWith('#x')) {
      const code = Number.parseInt(key.slice(2), 16);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
    }
    if (key.startsWith('#')) {
      const code = Number.parseInt(key.slice(1), 10);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
    }
    return COMMON_ENTITIES[key] ?? entity;
  });
}

function decodeCloudflareEmail(encoded: string) {
  if (!/^[0-9a-f]{4,}$/i.test(encoded) || encoded.length % 2 !== 0) return '';
  const key = Number.parseInt(encoded.slice(0, 2), 16);
  let result = '';
  for (let index = 2; index < encoded.length; index += 2) {
    result += String.fromCharCode(Number.parseInt(encoded.slice(index, index + 2), 16) ^ key);
  }
  return result;
}

function decodeContent(value: string) {
  let decoded = decodeHtmlEntities(value);
  decoded = decoded.replace(
    /data-cfemail\s*=\s*["']([0-9a-f]+)["']/gi,
    (_match, encoded: string) => ` data-decoded-email="${decodeCloudflareEmail(encoded)}"`,
  );
  decoded = decoded.replace(/\/cdn-cgi\/l\/email-protection#([0-9a-f]+)/gi, (_match, encoded: string) =>
    decodeCloudflareEmail(encoded));
  decoded = decoded
    .replace(/\s*(?:\[|\()\s*at\s*(?:\]|\))\s*/gi, '@')
    .replace(/\s*(?:\[|\()\s*dot\s*(?:\]|\))\s*/gi, '.')
    .replace(/\\u([0-9a-f]{4})/gi, (_match, code: string) =>
      String.fromCharCode(Number.parseInt(code, 16)));
  try {
    decoded = decodeURIComponent(decoded.replace(/%(?![0-9a-f]{2})/gi, '%25'));
  } catch {
    // Malformed percent escapes are common in HTML; the other decoders still apply.
  }
  return decoded;
}

function htmlToText(value: string) {
  return value
    .replace(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi, ' $1 ')
    .replace(/<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function canonicalUrl(url: URL) {
  const normalized = new URL(url);
  normalized.hash = '';
  normalized.hostname = normalized.hostname.toLowerCase().replace(/\.$/, '');
  if ((normalized.protocol === 'https:' && normalized.port === '443')
    || (normalized.protocol === 'http:' && normalized.port === '80')) normalized.port = '';
  return normalized.toString();
}

function safeHttpUrl(value: string | URL, base?: URL) {
  try {
    const url = value instanceof URL ? new URL(value) : new URL(value, base);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.hash = '';
    return url;
  } catch {
    return null;
  }
}

function isSameCompanyHost(url: URL, domain: string) {
  return normalizeHost(url.hostname) === domain;
}

function pagePath(url: URL) {
  return `${url.pathname}${url.search}`;
}

function extractLinks(decoded: string, base: URL, domain: string) {
  const links: URL[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    const url = safeHttpUrl(decodeHtmlEntities(raw), base);
    if (!url || !isSameCompanyHost(url, domain)) return;
    const key = canonicalUrl(url);
    if (seen.has(key)) return;
    seen.add(key);
    links.push(url);
  };
  for (const match of decoded.matchAll(/(?:href|src)\s*=\s*["']([^"'#]+)["']/gi)) add(match[1]);
  // Common SPA route manifests and serialized application state contain paths
  // which do not appear in the server-rendered navigation.
  for (const match of decoded.matchAll(/["'](\/[a-z0-9._~/-]{0,180}(?:team|people|leadership|staff|management|professional|partner|advisor|directory|contact)[a-z0-9._~/-]{0,180})["']/gi)) {
    add(match[1]);
  }
  return links;
}

function extractImageLinks(decoded: string, base: URL, domain: string) {
  const images: URL[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    const url = safeHttpUrl(decodeHtmlEntities(raw.trim()), base);
    if (!url || !isSameCompanyHost(url, domain)) return;
    if (!/\.(?:png|jpe?g|webp)(?:$|\?)/i.test(url.toString())) return;
    if (/(?:logo|icon|avatar|sprite|pixel|tracking|spacer|favicon)/i.test(url.pathname)) return;
    const key = canonicalUrl(url);
    if (seen.has(key)) return;
    seen.add(key);
    images.push(url);
  };
  for (const match of decoded.matchAll(/(?:src|data-src|data-lazy-src)\s*=\s*["']([^"']+)["']/gi)) add(match[1]);
  for (const match of decoded.matchAll(/srcset\s*=\s*["']([^"']+)["']/gi)) {
    for (const entry of match[1].split(',')) add(entry.trim().split(/\s+/)[0] ?? '');
  }
  for (const match of decoded.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) add(match[1]);
  return images;
}

function extractSitemapLinks(decoded: string, base: URL, domain: string) {
  const links: URL[] = [];
  for (const match of decoded.matchAll(/<loc\b[^>]*>([\s\S]*?)<\/loc>/gi)) {
    const url = safeHttpUrl(decodeHtmlEntities(match[1].trim()), base);
    if (url && isSameCompanyHost(url, domain)) links.push(url);
  }
  return links;
}

function extractRobotsDisallow(decoded: string) {
  const disallowed: string[] = [];
  let applies = false;
  for (const rawLine of decoded.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    const userAgent = line.match(/^user-agent:\s*(.+)$/i)?.[1]?.trim();
    if (userAgent) {
      applies = userAgent === '*';
      continue;
    }
    const path = applies ? line.match(/^disallow:\s*(.*)$/i)?.[1]?.trim() : null;
    if (path) disallowed.push(path);
  }
  return disallowed;
}

function extractRobotsSitemaps(decoded: string, base: URL, domain: string) {
  return decoded.split(/\r?\n/).flatMap((line) => {
    const value = line.match(/^sitemap:\s*(\S+)/i)?.[1];
    const url = value ? safeHttpUrl(value, base) : null;
    return url && isSameCompanyHost(url, domain) ? [url] : [];
  });
}

function isUsefulPage(url: URL) {
  if (/\.(?:css|js|mjs|map|json|xml|rss|atom|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|eot|zip|mp4|mp3)$/i.test(url.pathname)) {
    return false;
  }
  if (url.pathname === '/' || /\.pdf$/i.test(url.pathname)) return true;
  return /(?:about|advisor|attorney|bio|board|company|contact|directory|director|executive|expert|governance|insight|leadership|management|media|news|partner|people|press|professional|profile|publication|resource|staff|team|who-we-are)/i
    .test(url.pathname);
}

function pagePriority(url: URL, people: readonly SiteScraperPerson[]) {
  const value = `${url.pathname} ${url.search}`.toLowerCase();
  let score = 0;
  if (/(?:team|people|leadership|staff|directory|management|professional|partner|advisor|executive|board|contact)/.test(value)) score += 100;
  if (/(?:about|company|firm|who-we-are|profile|bio)/.test(value)) score += 40;
  if (people.some((person) => {
    const last = personNameParts(person.full_name).last;
    return last.length >= 3 && normalizePersonToken(value).includes(last);
  })) score += 140;
  if (/(?:blog|career|privacy|terms|login|signin|shop|product|cart|tracking)/.test(value)) score -= 100;
  if (/\.pdf(?:$|\?)/i.test(value)) score += 30;
  return score;
}

function emailOccurrences(value: string, domain: string) {
  const occurrences: EmailOccurrence[] = [];
  const seen = new Set<string>();
  EMAIL_RE.lastIndex = 0;
  for (const match of value.matchAll(EMAIL_RE)) {
    const email = match[0].replace(/^[.,;:'"(<]+|[.,;:'")>]+$/g, '').toLowerCase();
    const [localPart, emailDomain] = email.split('@');
    if (!localPart || normalizeHost(emailDomain ?? '') !== domain) continue;
    if (GENERIC_LOCAL_PARTS.has(localPart.replace(/[._+-]/g, ''))) continue;
    const key = `${email}:${match.index ?? 0}`;
    if (seen.has(key)) continue;
    seen.add(key);
    occurrences.push({ email, index: match.index ?? 0 });
  }
  return occurrences;
}

function contextAround(value: string, index: number, email: string) {
  const boundaryStart = value.lastIndexOf('\f', index);
  const boundaryEnd = value.indexOf('\f', index + email.length);
  const start = Math.max(boundaryStart + 1, index - 180);
  const end = Math.min(
    boundaryEnd === -1 ? value.length : boundaryEnd,
    index + email.length + 180,
  );
  return value.slice(start, end).replace(/\s+/g, ' ').trim().slice(0, 420);
}

function matchPerson(
  occurrence: EmailOccurrence,
  text: string,
  people: readonly SiteScraperPerson[],
) {
  const context = contextAround(text, occurrence.index, occurrence.email);
  const normalizedContext = normalizeName(context);
  const localPart = occurrence.email.split('@')[0]?.replace(/[._+\-]/g, '') ?? '';
  const candidates = people.flatMap((person) => {
    const parsed = personNameParts(person.full_name);
    const first = compactName(person.first_name || parsed.first);
    const last = compactName(person.last_name || parsed.last);
    const exact = normalizeName(person.full_name);
    const fullNameMatch = exact.length >= 5 && normalizedContext.includes(exact);
    const aliases = firstNameAliases(first, parsed.parenthetical);
    const aliasMatch = aliases.some((alias) =>
      alias !== first && normalizedContext.includes(`${alias} ${last}`));
    const tokenMatch = aliases.some((alias) => alias.length >= 2
      && last.length >= 2
      && (
        normalizedContext.includes(`${alias} ${last}`)
        || new RegExp(`\\b${alias}\\b.{0,48}\\b${last}\\b`).test(normalizedContext)
      ));
    const localForms = new Set(
      buildNameSearchVariants(person).map((variant) =>
        normalizePersonToken(variant.display).replace(/\s+/g, '')),
    );
    localForms.add(`${first}${last}`);
    localForms.add(`${first[0] ?? ''}${last}`);
    const localPartMatch = localForms.has(localPart);
    const score = fullNameMatch ? 5 : aliasMatch ? 4 : tokenMatch ? 3 : localPartMatch ? 2 : 0;
    return score ? [{
      person,
      score,
      matchType: fullNameMatch
        ? 'exact'
        : aliasMatch
          ? 'nickname'
          : tokenMatch
            ? 'tokens'
            : 'local_part',
    }] : [];
  }).sort((left, right) => right.score - left.score);
  if (!candidates.length) return null;
  if (candidates.length > 1 && candidates[0].score === candidates[1].score) return null;
  return { person: candidates[0].person, context, matchType: candidates[0].matchType };
}

function isPrivateIp(address: string) {
  const normalized = address.toLowerCase();
  if (normalized.startsWith('::ffff:')) {
    const mapped = normalized.slice('::ffff:'.length);
    if (isIP(mapped) === 4) return isPrivateIp(mapped);
    const groups = mapped.split(':');
    if (groups.length === 2 && groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) {
      const value = (Number.parseInt(groups[0], 16) * 0x10000) + Number.parseInt(groups[1], 16);
      return isPrivateIp([
        (value >>> 24) & 255,
        (value >>> 16) & 255,
        (value >>> 8) & 255,
        value & 255,
      ].join('.'));
    }
  }
  if (isIP(normalized) === 4) {
    const [a, b] = normalized.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || a >= 224;
  }
  if (isIP(normalized) === 6) {
    return normalized === '::1' || normalized === '::'
      || normalized.startsWith('fc') || normalized.startsWith('fd')
      || normalized.startsWith('fe8') || normalized.startsWith('fe9')
      || normalized.startsWith('fea') || normalized.startsWith('feb')
      || normalized.startsWith('::ffff:');
  }
  return false;
}

// node:dns/promises lookup() has no built-in timeout/cancellation. Under
// concurrent scraping it can occasionally stall well past any sane per-page
// budget (observed hangs of 40s+ against a single hostname), which silently
// blocks a whole worker slot instead of failing fast into the next URL. Race
// it against a hard timeout so one slow resolution never eats the scraper's
// global deadline.
async function lookupWithTimeout(hostname: string, timeoutMs: number) {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('DNS lookup timed out')), timeoutMs);
  });
  try {
    return await Promise.race([lookup(hostname, { all: true, verbatim: true }), timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

async function assertPublicUrl(url: URL, resolveHostname: boolean, dnsTimeoutMs = 3000) {
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('unsafe URL');
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost')
    || hostname.endsWith('.local') || isPrivateIp(hostname)) {
    throw new Error('private network URL blocked');
  }
  if (!resolveHostname || isIP(hostname)) return;
  const addresses = await lookupWithTimeout(hostname, Math.max(250, dnsTimeoutMs));
  if (!addresses.length || addresses.some((entry) => isPrivateIp(entry.address))) {
    throw new Error('private network destination blocked');
  }
}

async function responseBytes(response: Response, maxBytes: number) {
  const declared = Number(response.headers?.get?.('content-length') ?? 0);
  if (declared > maxBytes) throw new Error('response too large');
  if (!response.body?.getReader) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new Error('response too large');
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error('response too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
}

async function responseText(response: Response, url: URL) {
  const contentType = response.headers?.get?.('content-type')?.toLowerCase() ?? '';
  const bytes = await responseBytes(
    response,
    contentType.includes('application/pdf') || /\.pdf$/i.test(url.pathname)
      ? 8 * 1024 * 1024
      : 2 * 1024 * 1024,
  );
  const contentHash = createHash('sha256').update(bytes).digest('hex');
  if (contentType.includes('application/pdf') || /\.pdf$/i.test(url.pathname)) {
    const extracted = extractPdfText(bytes);
    if (!extracted.text) {
      throw new Error(`PDF text extraction failed: ${extracted.error ?? 'unknown'}`);
    }
    return { raw: extracted.text, contentHash, contentType };
  }
  return { raw: bytes.toString('utf8'), contentHash, contentType };
}

async function fetchPage(
  url: URL,
  fetchImpl: SiteScraperFetch,
  deadlineAt: number,
  domain: string,
): Promise<PageContent> {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) throw new Error('global deadline exceeded');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), remaining);
  try {
    let currentUrl = url;
    let response: Response | null = null;
    for (let redirect = 0; redirect <= 3; redirect++) {
      const dnsTimeoutMs = Math.min(3000, Math.max(250, deadlineAt - Date.now()));
      await assertPublicUrl(currentUrl, fetchImpl === globalThis.fetch, dnsTimeoutMs);
      response = await fetchImpl(currentUrl, {
        signal: controller.signal,
        redirect: 'manual',
        headers: {
          accept: 'text/html,application/xhtml+xml,application/xml,application/pdf,text/plain;q=0.9,*/*;q=0.1',
          'user-agent': 'OutreachHubEmailDiscovery/1.0',
        },
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get('location');
      if (!location) throw new Error('redirect missing location');
      currentUrl = new URL(location, currentUrl);
      response = null;
    }
    if (!response) throw new Error('too many redirects');
    if (!response.ok) {
      const error = new Error(`HTTP ${response.status}`) as Error & { status?: number };
      error.status = response.status;
      throw error;
    }
    const fetched = await responseText(response, currentUrl);
    const raw = fetched.raw;
    const decoded = decodeContent(raw);
    const isMarkup = /<(?:html|body|a|script|loc)\b/i.test(decoded);
    const plainText = isMarkup ? htmlToText(decoded) : decoded.replace(/\s+/g, ' ').trim();
    return {
      url: currentUrl,
      decoded,
      plainText,
      contentHash: fetched.contentHash,
      links: isMarkup ? extractLinks(decoded, currentUrl, domain) : [],
      sitemapLinks: /<urlset\b|<sitemapindex\b/i.test(decoded)
        ? extractSitemapLinks(decoded, currentUrl, domain)
        : currentUrl.pathname === '/robots.txt'
          ? extractRobotsSitemaps(decoded, currentUrl, domain)
          : [],
      robotsDisallow: currentUrl.pathname === '/robots.txt' ? extractRobotsDisallow(decoded) : [],
      contentType: fetched.contentType,
      rendered: false,
    };
  } finally {
    clearTimeout(timer);
  }
}

function renderedPageContent(rendered: { html: string; finalUrl: string }, fallbackUrl: URL, domain: string): PageContent {
  const finalUrl = safeHttpUrl(rendered.finalUrl) ?? fallbackUrl;
  const decoded = decodeContent(rendered.html);
  return {
    url: finalUrl,
    decoded,
    plainText: htmlToText(decoded),
    contentHash: createHash('sha256').update(rendered.html).digest('hex'),
    links: extractLinks(decoded, finalUrl, domain),
    sitemapLinks: [],
    robotsDisallow: [],
    contentType: 'text/html',
    rendered: true,
  };
}

export function looksLikeJavascriptShell(page: Pick<PageContent, 'decoded' | 'plainText'>) {
  const meaningfulText = page.plainText.replace(/\b(?:loading|enable javascript|please wait)\b/gi, '').trim();
  return meaningfulText.length < 180
    && /(?:__NEXT_DATA__|id=["'](?:root|app|__next)["']|enable javascript|noscript|webpack|chunk\.js)/i
      .test(page.decoded);
}

function classifyFailure(error: unknown): {
  outcome: ScrapePageOutcome;
  retryable: boolean;
  status?: number;
  message: string;
} {
  const typed = error as Error & { status?: number; code?: string; cause?: { code?: string } };
  const message = typed?.name === 'AbortError' ? 'request timed out' : typed?.message || 'unknown scrape failure';
  const status = typed?.status;
  const code = typed?.code ?? typed?.cause?.code ?? '';
  if (/unsafe URL|private network|credentials/i.test(message)) return { outcome: 'error_unsafe_url', retryable: false, message };
  if (/too large/i.test(message)) return { outcome: 'error_too_large', retryable: false, message };
  if (/deadline|timed out|timeout|AbortError/i.test(message)) return { outcome: 'error_timeout', retryable: true, message };
  if (/ENOTFOUND|EAI_AGAIN|DNS/i.test(`${message} ${code}`)) return { outcome: 'error_dns', retryable: code === 'EAI_AGAIN' || /timed out/i.test(message), message };
  if (/CERT|TLS|SSL|self[- ]signed/i.test(`${message} ${code}`)) return { outcome: 'error_tls', retryable: false, message };
  if (status === 401 || status === 403 || status === 407 || status === 429 || /cloudflare|blocked/i.test(message)) {
    return { outcome: 'error_blocked', retryable: status === 429, status, message };
  }
  if (status) return { outcome: 'error_http', retryable: status >= 500 || status === 408, status, message };
  return { outcome: 'error_unknown', retryable: true, message };
}

function retryDelay(attempt: number) {
  return Math.min(1_000, 120 * (2 ** attempt)) + Math.floor(Math.random() * 100);
}

function uniqueSeedUrls(
  domain: string,
  preferredPaths: readonly string[],
  evidenceUrls: readonly string[],
  people: readonly SiteScraperPerson[],
) {
  const home = new URL(`https://${domain}/`);
  const wwwHome = new URL(`https://www.${domain}/`);
  const prioritized = [
    home.toString(),
    wwwHome.toString(),
    new URL('/robots.txt', home).toString(),
    new URL('/sitemap.xml', home).toString(),
    ...preferredPaths.map((path) => safeHttpUrl(path, home)?.toString()).filter((url): url is string => Boolean(url)),
    ...evidenceUrls,
    ...STATIC_PATHS.map((path) => new URL(path, home).toString()),
  ];
  const seen = new Set<string>();
  const unique = prioritized.flatMap((value, index) => {
    const url = safeHttpUrl(value, home);
    if (!url) return [];
    const key = canonicalUrl(url);
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ url, index }];
  });
  return unique.sort((left, right) => {
    const leftPinned = left.index < 4 + preferredPaths.length + evidenceUrls.length;
    const rightPinned = right.index < 4 + preferredPaths.length + evidenceUrls.length;
    if (leftPinned !== rightPinned) return Number(rightPinned) - Number(leftPinned);
    return pagePriority(right.url, people) - pagePriority(left.url, people) || left.index - right.index;
  }).map((entry) => entry.url);
}

export async function scrapeDirectEmails(
  domainValue: string,
  people: readonly SiteScraperPerson[],
  options: SiteScraperOptions = {},
) {
  const domain = normalizeDomain(domainValue);
  const diagnostics: ScrapeDiagnostics = {
    pagesAttempted: 0,
    pagesFetched: 0,
    pathsAttempted: [],
    pathsHit: [],
    errors: [],
    deadlineExceeded: false,
    outcomes: {},
    pageOutcomes: [],
    retries: 0,
    renderedPages: 0,
    ocrImages: 0,
    nicknameMatches: 0,
    localPartMatches: 0,
    throttled: 0,
  };
  const result = new ScrapeDirectEmailResult(diagnostics);
  if (!domain || !people.length) return result;

  try {
    const fetchImpl = options.fetchImpl ?? options.fetch ?? globalThis.fetch;
    if (!fetchImpl) {
      incrementOutcome(diagnostics, 'error_unknown');
      diagnostics.errors.push({
        url: `https://${domain}/`,
        path: '/',
        error: 'No fetch implementation is available',
        outcome: 'error_unknown',
      });
      return result;
    }
    const configuredPerHost = Number(process.env.ORG_SCRAPE_PER_HOST_CONCURRENCY ?? 2);
    const concurrency = Math.max(1, Math.min(
      4,
      Math.floor(options.concurrency ?? configuredPerHost),
      Number.isFinite(configuredPerHost) ? configuredPerHost : 2,
    ));
    const globalLimit = Math.max(1, Math.min(12, Number(process.env.ORG_SCRAPE_GLOBAL_CONCURRENCY ?? 4)));
    const maxPages = Math.max(1, Math.min(120, Math.floor(options.maxPages ?? 48)));
    const maxRetries = Math.max(0, Math.min(3, Math.floor(options.maxRetries ?? 2)));
    const maxRenderedPages = Math.max(0, Math.min(10, Math.floor(options.maxRenderedPages ?? 4)));
    const maxOcrImages = Math.max(0, Math.min(12, Math.floor(options.maxOcrImages ?? 4)));
    const deadlineAt = Date.now() + Math.max(1_000, options.deadlineMs ?? 25_000);
    const preferredPaths = options.preferredCachedPaths ?? options.preferredPaths ?? [];
    const queue = uniqueSeedUrls(
      domain,
      preferredPaths,
      options.additionalEvidenceUrls ?? [],
      people,
    );
    const queued = new Set(queue.map(canonicalUrl));
    const priorityQueue: URL[] = [];
    const priorityQueued = new Set<string>();
    const attempted = new Set<string>();
    const disallowedPaths = new Set<string>();
    const renderFetch = options.renderFetch ?? renderSitePage;
    const ocrImpl = options.ocrImpl ?? (async (bytes: Buffer) => {
      const { readImageText } = await import('@/lib/site-image-ocr');
      return readImageText(bytes);
    });
    let cursor = 0;
    let renderedCount = 0;
    let ocrCount = 0;

    const record = (
      url: URL,
      outcome: ScrapePageOutcome,
      attempt: number,
      startedAt: number,
      detail: { status?: number; error?: string } = {},
    ) => {
      incrementOutcome(diagnostics, outcome);
      diagnostics.pageOutcomes.push({
        url: url.toString(),
        path: pagePath(url),
        outcome,
        attempt,
        durationMs: Math.max(0, Date.now() - startedAt),
        ...detail,
      });
      if (outcome.startsWith('error_')) {
        diagnostics.errors.push({
          url: url.toString(),
          path: pagePath(url),
          error: detail.error ?? outcome,
          outcome,
          attempt,
          ...(detail.status === undefined ? {} : { status: detail.status }),
        });
      }
    };

    const addDynamic = (urls: readonly URL[], sitemap = false) => {
      const ranked = urls
        .filter((url) => isSameCompanyHost(url, domain) && (sitemap || isUsefulPage(url)))
        .sort((left, right) => pagePriority(right, people) - pagePriority(left, people));
      for (const url of ranked) {
        if (queued.size >= maxPages * 16 && pagePriority(url, people) < 80) {
          incrementOutcome(diagnostics, 'skipped_queue_full');
          continue;
        }
        const key = canonicalUrl(url);
        if (attempted.has(key)) continue;
        if (queued.has(key)) {
          if (!priorityQueued.has(key)) {
            priorityQueued.add(key);
            priorityQueue.push(url);
          }
          continue;
        }
        queued.add(key);
        priorityQueued.add(key);
        priorityQueue.push(url);
      }
    };

    const applySearchable = (
      searchable: string,
      pageUrl: URL,
      contentHash: string,
      method: DirectEmailMatch['extraction_method'],
    ) => {
      for (const occurrence of emailOccurrences(searchable, domain)) {
        const binding = matchPerson(occurrence, searchable, people);
        if (!binding || result.has(binding.person.full_name)) continue;
        if (binding.matchType === 'nickname') diagnostics.nicknameMatches++;
        if (binding.matchType === 'local_part') diagnostics.localPartMatches++;
        result.set(binding.person.full_name, {
          email: occurrence.email,
          source_url: pageUrl.toString(),
          content_hash: contentHash,
          context: binding.context,
          extraction_method: method,
        });
      }
    };

    const fetchNormal = async (url: URL) => {
      let lastFailure: ReturnType<typeof classifyFailure> | null = null;
      for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
        const startedAt = Date.now();
        if (Date.now() >= deadlineAt) {
          record(url, 'error_aborted_deadline', attempt, startedAt, { error: 'global deadline exceeded' });
          throw new Error('global deadline exceeded');
        }
        const waiting = globalActiveRequests >= globalLimit;
        const release = await acquireGlobalSlot(globalLimit);
        if (waiting) diagnostics.throttled++;
        try {
          const page = await fetchPage(url, fetchImpl, deadlineAt, domain);
          const outcome: ScrapePageOutcome = page.contentType.includes('pdf') || /\.pdf$/i.test(page.url.pathname)
            ? 'fetched_pdf'
            : 'fetched_html';
          record(url, outcome, attempt, startedAt);
          return page;
        } catch (error) {
          const failure = classifyFailure(error);
          lastFailure = failure;
          record(url, failure.outcome, attempt, startedAt, {
            error: failure.message,
            status: failure.status,
          });
          if (!failure.retryable || attempt > maxRetries || Date.now() + retryDelay(attempt) >= deadlineAt) break;
          diagnostics.retries++;
          await new Promise((resolve) => setTimeout(resolve, retryDelay(attempt)));
        } finally {
          release();
        }
      }
      const error = new Error(lastFailure?.message ?? 'page fetch exhausted retries') as Error & { status?: number };
      error.status = lastFailure?.status;
      throw error;
    };

    const fetchAndOcrImage = async (imageUrl: URL) => {
      const startedAt = Date.now();
      const release = await acquireGlobalSlot(globalLimit);
      try {
        await assertPublicUrl(imageUrl, fetchImpl === globalThis.fetch);
        const response = await fetchImpl(imageUrl, {
          redirect: 'error',
          signal: AbortSignal.timeout(Math.max(500, Math.min(6_000, deadlineAt - Date.now()))),
          headers: { accept: 'image/png,image/jpeg,image/webp;q=0.9' },
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const declared = Number(response.headers.get('content-length') ?? 0);
        if (declared && (declared < 2_000 || declared > 3 * 1024 * 1024)) {
          throw new Error('image size is outside OCR bounds');
        }
        const bytes = await responseBytes(response, 3 * 1024 * 1024);
        if (bytes.byteLength < 2_000) throw new Error('image too small for OCR');
        const text = await ocrImpl(bytes);
        diagnostics.ocrImages++;
        ocrCount++;
        record(imageUrl, 'fetched_image_ocr', 1, startedAt);
        if (text) {
          applySearchable(
            text,
            imageUrl,
            createHash('sha256').update(bytes).digest('hex'),
            'image_ocr',
          );
        }
      } catch (error) {
        record(imageUrl, 'error_ocr_failed', 1, startedAt, {
          error: error instanceof Error ? error.message : 'OCR failed',
        });
      } finally {
        release();
      }
    };

    const worker = async () => {
      while (Date.now() < deadlineAt && attempted.size < maxPages && result.size < people.length) {
        const url = priorityQueue.shift() ?? queue[cursor++];
        if (!url) return;
        const key = canonicalUrl(url);
        if (attempted.has(key)) {
          incrementOutcome(diagnostics, 'skipped_duplicate');
          continue;
        }
        if (!['/robots.txt', '/sitemap.xml'].includes(url.pathname)
          && [...disallowedPaths].some((path) => url.pathname.startsWith(path))) {
          incrementOutcome(diagnostics, 'skipped_robots');
          continue;
        }
        attempted.add(key);
        diagnostics.pagesAttempted++;
        diagnostics.pathsAttempted.push(pagePath(url));

        let page: PageContent | null = null;
        let normalFailure: ReturnType<typeof classifyFailure> | null = null;
        try {
          page = await fetchNormal(url);
        } catch (error) {
          normalFailure = classifyFailure(error);
        }

        const highValue = pagePriority(url, people) >= 80;
        const browserMayHelp = highValue
          && renderedCount < maxRenderedPages
          && (page
            ? looksLikeJavascriptShell(page)
            : ['error_blocked', 'error_timeout'].includes(normalFailure?.outcome ?? '')
              || (normalFailure?.outcome === 'error_http' && normalFailure.retryable));
        if (browserMayHelp && Date.now() < deadlineAt) {
          const startedAt = Date.now();
          const release = await acquireGlobalSlot(globalLimit);
          try {
            await assertPublicUrl(url, renderFetch === renderSitePage);
            const rendered = await renderFetch(url, {
              timeoutMs: Math.max(500, Math.min(8_000, deadlineAt - Date.now())),
            });
            page = renderedPageContent(rendered, url, domain);
            renderedCount++;
            diagnostics.renderedPages++;
            record(url, 'fetched_rendered', 1, startedAt);
          } catch (error) {
            record(url, 'error_render_failed', 1, startedAt, {
              error: error instanceof Error ? error.message : 'managed browser failed',
            });
          } finally {
            release();
          }
        }
        if (!page) continue;

        diagnostics.pagesFetched++;
        diagnostics.pathsHit.push(pagePath(page.url));
        for (const path of page.robotsDisallow) disallowedPaths.add(path);
        addDynamic(page.sitemapLinks, true);
        addDynamic(page.links);
        const searchable = `${page.decoded}\n${page.plainText}`;
        applySearchable(
          searchable,
          page.url,
          page.contentHash,
          page.rendered ? 'rendered_html' : page.contentType.includes('pdf') ? 'pdf' : 'html',
        );

        if (highValue && ocrCount < maxOcrImages && result.size < people.length) {
          const images = extractImageLinks(page.decoded, page.url, domain)
            .slice(0, maxOcrImages - ocrCount);
          for (const image of images) {
            if (Date.now() >= deadlineAt || ocrCount >= maxOcrImages) break;
            await fetchAndOcrImage(image);
          }
        }
      }
    };

    await Promise.allSettled(Array.from({ length: concurrency }, worker));
    diagnostics.deadlineExceeded = Date.now() >= deadlineAt;
    if (diagnostics.deadlineExceeded) incrementOutcome(diagnostics, 'error_aborted_deadline');
  } catch (error) {
    incrementOutcome(diagnostics, 'error_unknown');
    diagnostics.errors.push({
      url: `https://${domain}/`,
      path: '/',
      error: error instanceof Error ? error.message : 'unexpected scraper coordinator failure',
      outcome: 'error_unknown',
    });
  }
  return result;
}

export async function verifyDirectEmailSource(
  input: VerifyDirectEmailSourceInput,
  options?: Pick<SiteScraperOptions, 'fetch' | 'fetchImpl' | 'deadlineMs'>,
): Promise<DirectEmailVerification>;
export async function verifyDirectEmailSource(
  sourceUrl: string,
  email: string,
  personName: string,
  options?: Pick<SiteScraperOptions, 'fetch' | 'fetchImpl' | 'deadlineMs'>,
): Promise<DirectEmailVerification>;
export async function verifyDirectEmailSource(
  inputOrUrl: VerifyDirectEmailSourceInput | string,
  emailOrOptions?: string | Pick<SiteScraperOptions, 'fetch' | 'fetchImpl' | 'deadlineMs'>,
  personName?: string,
  positionalOptions?: Pick<SiteScraperOptions, 'fetch' | 'fetchImpl' | 'deadlineMs'>,
): Promise<DirectEmailVerification> {
  const input = typeof inputOrUrl === 'string'
    ? {
      source_url: inputOrUrl,
      email: typeof emailOrOptions === 'string' ? emailOrOptions : '',
      person_name: personName ?? '',
    }
    : inputOrUrl;
  const options = typeof inputOrUrl === 'string'
    ? positionalOptions
    : (typeof emailOrOptions === 'string' ? undefined : emailOrOptions);
  const sourceUrl = safeHttpUrl(input.source_url);
  const email = input.email.trim().toLowerCase();
  const person = (input.person_name ?? input.full_name ?? '').trim();
  const emailDomain = normalizeDomain(input.domain ?? email.split('@')[1] ?? '');
  const base: DirectEmailVerification = {
    verified: false,
    provisional: false,
    refetch_attempted: false,
    source_url: input.source_url,
    email,
    person_name: person,
  };
  if (!sourceUrl || !emailDomain || !person || !EMAIL_RE.test(email)) {
    EMAIL_RE.lastIndex = 0;
    return {
      ...base,
      failure_class: 'invalid',
      error: 'invalid source URL, email, person, or domain',
    };
  }
  EMAIL_RE.lastIndex = 0;
  if (normalizeHost(email.split('@')[1] ?? '') !== emailDomain) {
    return { ...base, failure_class: 'invalid', error: 'email is not on the requested company domain' };
  }
  const localPart = email.split('@')[0]?.replace(/[._+-]/g, '') ?? '';
  if (GENERIC_LOCAL_PARTS.has(localPart)) {
    return { ...base, failure_class: 'invalid', error: 'generic inboxes are not person email evidence' };
  }

  const fetchImpl = options?.fetchImpl ?? options?.fetch ?? globalThis.fetch;
  const deadlineAt = Date.now() + Math.max(250, options?.deadlineMs ?? 8_000);
  const quote = input.source_quote?.trim() ?? '';
  const normalizedQuote = normalizeName(quote);
  const parsedPerson = personNameParts(person);
  const quoteNames = firstNameAliases(parsedPerson.first, parsedPerson.parenthetical)
    .map((first) => `${first} ${parsedPerson.last}`);
  const quoteIsExact = quote.toLowerCase().includes(email)
    && quoteNames.some((name) => normalizedQuote.includes(name));
  const attemptedBase = { ...base, refetch_attempted: true };
  try {
    const page = await fetchPage(sourceUrl, fetchImpl, deadlineAt, emailDomain);
    const searchable = `${page.decoded}\n${page.plainText}`;
    const exact = emailOccurrences(searchable, emailDomain).find((item) => item.email === email);
    if (!exact) {
      return {
        ...attemptedBase,
        provisional: quoteIsExact,
        failure_class: 'email_absent',
        error: 'exact email is no longer present at source',
      };
    }
    const binding = matchPerson(exact, searchable, [{ full_name: person }]);
    if (!binding) {
      return {
        ...attemptedBase,
        failure_class: 'person_unbound',
        error: 'source does not bind the email to the named person',
      };
    }
    return {
      ...attemptedBase,
      verified: true,
      source_url: page.url.toString(),
      content_hash: page.contentHash,
      context: binding.context,
    };
  } catch (error) {
    const failure = classifyFailure(error);
    const failureClass = failure.outcome === 'error_blocked'
      ? 'blocked'
      : failure.outcome === 'error_timeout'
        ? 'timeout'
        : 'invalid';
    return {
      ...attemptedBase,
      provisional: quoteIsExact && ['blocked', 'timeout'].includes(failureClass),
      failure_class: failureClass,
      error: failure.message,
    };
  }
}
