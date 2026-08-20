import { dbQuery } from '@/lib/db';

export type AnthropicCostReportItem = {
  amount: string;
  currency?: string | null;
  cost_type?: string | null;
  token_type?: string | null;
  model?: string | null;
  description?: string | null;
  workspace_id?: string | null;
};

export type AnthropicCostReportBucket = {
  starting_at: string;
  ending_at: string;
  results: AnthropicCostReportItem[];
};

export type AnthropicCostReportResponse = {
  data: AnthropicCostReportBucket[];
  has_more?: boolean;
  next_page?: string | null;
};

/**
 * Cost API amounts are decimal strings in cents.
 * `"123.45"` USD = $1.2345.
 */
export function parseCostApiAmountUsd(amount: string | null | undefined): number {
  const n = Number(amount ?? 0);
  if (!Number.isFinite(n)) return 0;
  return n / 100;
}

export type CostReportFetcher = (input: {
  startingAt: string;
  endingAt: string;
  page?: string | null;
}) => Promise<AnthropicCostReportResponse>;

export async function fetchAnthropicCostReportPage(input: {
  startingAt: string;
  endingAt: string;
  page?: string | null;
  apiKey?: string;
}): Promise<AnthropicCostReportResponse> {
  const key = input.apiKey ?? process.env.ANTHROPIC_ADMIN_API_KEY?.trim();
  if (!key) {
    throw new Error('ANTHROPIC_ADMIN_API_KEY is not configured');
  }
  const url = new URL('https://api.anthropic.com/v1/organizations/cost_report');
  url.searchParams.set('starting_at', input.startingAt);
  url.searchParams.set('ending_at', input.endingAt);
  url.searchParams.set('bucket_width', '1d');
  url.searchParams.append('group_by[]', 'description');
  if (input.page) url.searchParams.set('page', input.page);

  const response = await fetch(url, {
    headers: {
      'anthropic-version': '2023-06-01',
      'x-api-key': key,
      'User-Agent': 'Helios-Outreach-Hub/1.0',
    },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Anthropic Cost API ${response.status}: ${body.slice(0, 400)}`);
  }
  return response.json() as Promise<AnthropicCostReportResponse>;
}

export async function fetchAllAnthropicCostReportBuckets(input: {
  startingAt: string;
  endingAt: string;
  fetchPage?: CostReportFetcher;
}): Promise<AnthropicCostReportBucket[]> {
  const fetchPage = input.fetchPage ?? fetchAnthropicCostReportPage;
  const buckets: AnthropicCostReportBucket[] = [];
  let page: string | null | undefined;
  do {
    const result = await fetchPage({
      startingAt: input.startingAt,
      endingAt: input.endingAt,
      page,
    });
    buckets.push(...(result.data ?? []));
    page = result.has_more ? result.next_page : null;
  } while (page);
  return buckets;
}

export async function upsertAnthropicCostReportBuckets(
  buckets: AnthropicCostReportBucket[],
): Promise<number> {
  let written = 0;
  for (const bucket of buckets) {
    const dayUtc = bucket.starting_at.slice(0, 10);
    const results = bucket.results?.length
      ? bucket.results
      : [{ amount: '0', cost_type: null, token_type: null, model: null }];
    for (const item of results) {
      const amountUsd = parseCostApiAmountUsd(item.amount);
      await dbQuery(
        `INSERT INTO outreach.anthropic_cost_report_days (
           day_utc, cost_type, token_type, model, description, amount_usd, currency_code, raw, synced_at
         ) VALUES ($1::date, $2, $3, $4, $5, $6::numeric, $7, $8::jsonb, now())
         ON CONFLICT (
           day_utc,
           (coalesce(cost_type, '')),
           (coalesce(token_type, '')),
           (coalesce(model, '')),
           (coalesce(description, ''))
         )
         DO UPDATE SET
           amount_usd = EXCLUDED.amount_usd,
           currency_code = EXCLUDED.currency_code,
           raw = EXCLUDED.raw,
           synced_at = now()`,
        [
          dayUtc,
          item.cost_type ?? null,
          item.token_type ?? null,
          item.model ?? null,
          item.description ?? null,
          amountUsd,
          item.currency ?? 'USD',
          JSON.stringify({ ...item, bucket_starting_at: bucket.starting_at, bucket_ending_at: bucket.ending_at }),
        ],
      );
      written += 1;
    }
  }
  return written;
}

/** Refresh yesterday + today (UTC). Idempotent upsert. */
export async function syncAnthropicCostReportDays(input: {
  now?: Date;
  fetchPage?: CostReportFetcher;
} = {}): Promise<{ startingAt: string; endingAt: string; rows: number }> {
  const now = input.now ?? new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const yesterday = new Date(today);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const startingAt = yesterday.toISOString();
  const endingAt = new Date(today.getTime() + 86_400_000).toISOString();
  const buckets = await fetchAllAnthropicCostReportBuckets({
    startingAt,
    endingAt,
    fetchPage: input.fetchPage,
  });
  const rows = await upsertAnthropicCostReportBuckets(buckets);
  return { startingAt, endingAt, rows };
}
