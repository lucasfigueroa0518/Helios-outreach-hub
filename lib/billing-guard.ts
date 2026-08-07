/**
 * Fail-closed guard for the always-on GCP worker when billed spend exceeds $0.
 */
import { dbQuery } from '@/lib/db';

export const BILLING_GUARD_ID = 'cloud_worker';

export const DEFAULT_BILLING_CONSOLE_URL =
  'https://console.cloud.google.com/billing/011FD6-E83AAF-E53EF3/reports;projects=helios-influencer-network';

export type BillingGuardState = {
  id: string;
  tripped: boolean;
  cost_amount: number | null;
  currency_code: string | null;
  alert_title: string | null;
  detail: string | null;
  source: string | null;
  console_url: string | null;
  raw_payload: Record<string, unknown>;
  tripped_at: string | null;
  cleared_at: string | null;
  acknowledged_at: string | null;
  updated_at: string;
};

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

export async function getBillingGuardState(): Promise<BillingGuardState> {
  const { rows } = await dbQuery<BillingGuardState>(
    `SELECT id, tripped, cost_amount::float8 AS cost_amount, currency_code,
            alert_title, detail, source, console_url, raw_payload,
            tripped_at::text, cleared_at::text, acknowledged_at::text, updated_at::text
       FROM outreach.billing_guard
      WHERE id = $1`,
    [BILLING_GUARD_ID],
  );
  const row = rows[0];
  if (!row) {
    return {
      id: BILLING_GUARD_ID,
      tripped: false,
      cost_amount: null,
      currency_code: null,
      alert_title: null,
      detail: null,
      source: null,
      console_url: DEFAULT_BILLING_CONSOLE_URL,
      raw_payload: {},
      tripped_at: null,
      cleared_at: null,
      acknowledged_at: null,
      updated_at: new Date().toISOString(),
    };
  }
  return {
    ...row,
    cost_amount: row.cost_amount == null ? null : Number(row.cost_amount),
    raw_payload: (row.raw_payload && typeof row.raw_payload === 'object')
      ? row.raw_payload as Record<string, unknown>
      : {},
  };
}

export async function isBillingGuardTripped(): Promise<boolean> {
  const { rows } = await dbQuery<{ tripped: boolean }>(
    `SELECT tripped FROM outreach.billing_guard WHERE id = $1`,
    [BILLING_GUARD_ID],
  );
  return Boolean(rows[0]?.tripped);
}

export async function tripBillingGuard(input: {
  source: string;
  alertTitle?: string | null;
  detail?: string | null;
  costAmount?: number | null;
  currencyCode?: string | null;
  consoleUrl?: string | null;
  rawPayload?: Record<string, unknown>;
}): Promise<BillingGuardState> {
  const { rows } = await dbQuery<BillingGuardState>(
    `INSERT INTO outreach.billing_guard (
       id, tripped, cost_amount, currency_code, alert_title, detail, source,
       console_url, raw_payload, tripped_at, cleared_at, acknowledged_at, updated_at
     ) VALUES (
       $1, true, $2, $3, $4, $5, $6, $7, $8::jsonb, now(), NULL, NULL, now()
     )
     ON CONFLICT (id) DO UPDATE SET
       tripped = true,
       cost_amount = COALESCE(EXCLUDED.cost_amount, outreach.billing_guard.cost_amount),
       currency_code = COALESCE(EXCLUDED.currency_code, outreach.billing_guard.currency_code),
       alert_title = COALESCE(EXCLUDED.alert_title, outreach.billing_guard.alert_title),
       detail = COALESCE(EXCLUDED.detail, outreach.billing_guard.detail),
       source = EXCLUDED.source,
       console_url = COALESCE(EXCLUDED.console_url, outreach.billing_guard.console_url),
       raw_payload = EXCLUDED.raw_payload,
       tripped_at = COALESCE(outreach.billing_guard.tripped_at, now()),
       cleared_at = NULL,
       updated_at = now()
     RETURNING id, tripped, cost_amount::float8 AS cost_amount, currency_code,
               alert_title, detail, source, console_url, raw_payload,
               tripped_at::text, cleared_at::text, acknowledged_at::text, updated_at::text`,
    [
      BILLING_GUARD_ID,
      input.costAmount ?? null,
      input.currencyCode ?? 'USD',
      input.alertTitle ?? 'Cloud worker billing exceeded $0',
      input.detail ?? 'GCP reported billable usage for the always-on worker project.',
      input.source,
      input.consoleUrl ?? DEFAULT_BILLING_CONSOLE_URL,
      JSON.stringify(input.rawPayload ?? {}),
    ],
  );
  return rows[0]!;
}

export async function acknowledgeBillingGuard(): Promise<BillingGuardState> {
  const { rows } = await dbQuery<BillingGuardState>(
    `UPDATE outreach.billing_guard
        SET acknowledged_at = now(), updated_at = now()
      WHERE id = $1
      RETURNING id, tripped, cost_amount::float8 AS cost_amount, currency_code,
                alert_title, detail, source, console_url, raw_payload,
                tripped_at::text, cleared_at::text, acknowledged_at::text, updated_at::text`,
    [BILLING_GUARD_ID],
  );
  if (!rows[0]) throw new Error('Billing guard row missing');
  return rows[0];
}

export async function clearBillingGuard(input: {
  source: string;
  detail?: string | null;
}): Promise<BillingGuardState> {
  const { rows } = await dbQuery<BillingGuardState>(
    `UPDATE outreach.billing_guard
        SET tripped = false,
            detail = COALESCE($2, detail),
            source = $3,
            cleared_at = now(),
            updated_at = now()
      WHERE id = $1
      RETURNING id, tripped, cost_amount::float8 AS cost_amount, currency_code,
                alert_title, detail, source, console_url, raw_payload,
                tripped_at::text, cleared_at::text, acknowledged_at::text, updated_at::text`,
    [BILLING_GUARD_ID, input.detail ?? null, input.source],
  );
  if (!rows[0]) throw new Error('Billing guard row missing');
  return rows[0];
}

/** Parse GCP Budget Pub/Sub push / budget notification JSON into a trip payload. */
export function parseGcpBudgetNotification(body: unknown): {
  shouldTrip: boolean;
  costAmount: number | null;
  currencyCode: string | null;
  alertTitle: string;
  detail: string;
  raw: Record<string, unknown>;
} {
  const root = (body && typeof body === 'object') ? body as Record<string, unknown> : {};
  let messageData: Record<string, unknown> = root;

  // Pub/Sub push envelope: { message: { data: base64 } }
  const message = root.message;
  if (message && typeof message === 'object') {
    const dataB64 = (message as { data?: unknown }).data;
    if (typeof dataB64 === 'string' && dataB64.trim()) {
      try {
        const decoded = Buffer.from(dataB64, 'base64').toString('utf8');
        messageData = JSON.parse(decoded) as Record<string, unknown>;
      } catch {
        messageData = { raw: dataB64 };
      }
    }
  }

  const costAmount = asNumber(messageData.costAmount)
    ?? asNumber((messageData.costAmount as { units?: unknown } | undefined)?.units)
    ?? asNumber(messageData.costAmountUnits)
    ?? asNumber((messageData as { budgetDisplayName?: unknown }).budgetDisplayName && messageData.alertThresholdExceeded
      ? messageData.costAmount
      : null);

  // Nested Billing proto style: costAmount: { currencyCode, units, nanos }
  let nestedCost: number | null = null;
  let currency: string | null = null;
  const costObj = messageData.costAmount;
  if (costObj && typeof costObj === 'object') {
    const c = costObj as { currencyCode?: string; units?: string | number; nanos?: number };
    currency = c.currencyCode ?? null;
    const units = asNumber(c.units) ?? 0;
    const nanos = asNumber(c.nanos) ?? 0;
    nestedCost = units + nanos / 1e9;
  }

  const amount = nestedCost ?? costAmount;
  if (typeof messageData.currencyCode === 'string' && messageData.currencyCode.trim()) {
    currency = currency ?? messageData.currencyCode.trim();
  }
  const threshold = asNumber(messageData.alertThresholdExceeded)
    ?? asNumber(messageData.thresholdPercent)
    ?? null;

  const budgetName = typeof messageData.budgetDisplayName === 'string'
    ? messageData.budgetDisplayName
    : 'Helios cloud worker $0 budget';

  // GCP publishes budget status to Pub/Sub multiple times per day even at $0.
  // Fail-closed only when reported cost is strictly greater than zero.
  const shouldTrip = amount != null && amount > 0;

  const detailParts = [
    `${budgetName}: billable spend reported.`,
    amount != null ? `Reported cost: ${amount} ${currency ?? 'USD'}.` : null,
    threshold != null ? `Threshold: ${(threshold <= 1 ? threshold * 100 : threshold).toFixed(2)}%.` : null,
    'Orchestration worker is fail-closed until an admin clears the billing guard.',
  ].filter(Boolean);

  return {
    shouldTrip,
    costAmount: amount,
    currencyCode: currency ?? 'USD',
    alertTitle: 'Cloud worker billing exceeded $0',
    detail: detailParts.join(' '),
    raw: messageData,
  };
}
