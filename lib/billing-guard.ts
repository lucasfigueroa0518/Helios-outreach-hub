/**
 * Cloud worker GCP spend tracking.
 *
 * Budget Pub/Sub notifications update the latest reported project cost so the
 * Analytics Hub can show infra spend. Spend does not block the orchestration
 * worker or email sends.
 */
import { dbQuery } from '@/lib/db';

export const BILLING_GUARD_ID = 'cloud_worker';

export const DEFAULT_BILLING_CONSOLE_URL =
  'https://console.cloud.google.com/billing/011FD6-E83AAF-E53EF3/reports;projects=helios-influencer-network';

export type CloudWorkerSpendState = {
  id: string;
  /** Legacy column — always false; spend never fail-closes the worker. */
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

/** @deprecated Use CloudWorkerSpendState */
export type BillingGuardState = CloudWorkerSpendState;

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

function mapRow(row: CloudWorkerSpendState | undefined): CloudWorkerSpendState {
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
    tripped: false,
    cost_amount: row.cost_amount == null ? null : Number(row.cost_amount),
    raw_payload: (row.raw_payload && typeof row.raw_payload === 'object')
      ? row.raw_payload as Record<string, unknown>
      : {},
  };
}

export async function getCloudWorkerSpendState(): Promise<CloudWorkerSpendState> {
  const { rows } = await dbQuery<CloudWorkerSpendState>(
    `SELECT id, tripped, cost_amount::float8 AS cost_amount, currency_code,
            alert_title, detail, source, console_url, raw_payload,
            tripped_at::text, cleared_at::text, acknowledged_at::text, updated_at::text
       FROM outreach.billing_guard
      WHERE id = $1`,
    [BILLING_GUARD_ID],
  );
  return mapRow(rows[0]);
}

/** @deprecated Use getCloudWorkerSpendState */
export async function getBillingGuardState(): Promise<CloudWorkerSpendState> {
  return getCloudWorkerSpendState();
}

/**
 * Always false — retained only so older callers compile during the transition.
 * Prefer deleting call sites; spend never blocks the worker.
 */
export async function isBillingGuardTripped(): Promise<boolean> {
  return false;
}

/** Record the latest GCP-reported cloud worker cost (does not trip / fail-close). */
export async function recordCloudWorkerSpend(input: {
  source: string;
  alertTitle?: string | null;
  detail?: string | null;
  costAmount?: number | null;
  currencyCode?: string | null;
  consoleUrl?: string | null;
  rawPayload?: Record<string, unknown>;
}): Promise<CloudWorkerSpendState> {
  const { rows } = await dbQuery<CloudWorkerSpendState>(
    `INSERT INTO outreach.billing_guard (
       id, tripped, cost_amount, currency_code, alert_title, detail, source,
       console_url, raw_payload, tripped_at, cleared_at, acknowledged_at, updated_at
     ) VALUES (
       $1, false, $2, $3, $4, $5, $6, $7, $8::jsonb, NULL, NULL, NULL, now()
     )
     ON CONFLICT (id) DO UPDATE SET
       tripped = false,
       cost_amount = COALESCE(EXCLUDED.cost_amount, outreach.billing_guard.cost_amount),
       currency_code = COALESCE(EXCLUDED.currency_code, outreach.billing_guard.currency_code),
       alert_title = COALESCE(EXCLUDED.alert_title, outreach.billing_guard.alert_title),
       detail = COALESCE(EXCLUDED.detail, outreach.billing_guard.detail),
       source = EXCLUDED.source,
       console_url = COALESCE(EXCLUDED.console_url, outreach.billing_guard.console_url),
       raw_payload = EXCLUDED.raw_payload,
       tripped_at = NULL,
       cleared_at = CASE
         WHEN outreach.billing_guard.tripped THEN now()
         ELSE outreach.billing_guard.cleared_at
       END,
       updated_at = now()
     RETURNING id, tripped, cost_amount::float8 AS cost_amount, currency_code,
               alert_title, detail, source, console_url, raw_payload,
               tripped_at::text, cleared_at::text, acknowledged_at::text, updated_at::text`,
    [
      BILLING_GUARD_ID,
      input.costAmount ?? null,
      input.currencyCode ?? 'USD',
      input.alertTitle ?? 'Cloud worker GCP spend update',
      input.detail ?? 'GCP reported billable usage for the always-on worker project.',
      input.source,
      input.consoleUrl ?? DEFAULT_BILLING_CONSOLE_URL,
      JSON.stringify(input.rawPayload ?? {}),
    ],
  );
  return mapRow(rows[0]);
}

/** @deprecated Use recordCloudWorkerSpend */
export async function tripBillingGuard(input: {
  source: string;
  alertTitle?: string | null;
  detail?: string | null;
  costAmount?: number | null;
  currencyCode?: string | null;
  consoleUrl?: string | null;
  rawPayload?: Record<string, unknown>;
}): Promise<CloudWorkerSpendState> {
  return recordCloudWorkerSpend(input);
}

export async function acknowledgeBillingGuard(): Promise<CloudWorkerSpendState> {
  const { rows } = await dbQuery<CloudWorkerSpendState>(
    `UPDATE outreach.billing_guard
        SET acknowledged_at = now(), updated_at = now(), tripped = false
      WHERE id = $1
      RETURNING id, tripped, cost_amount::float8 AS cost_amount, currency_code,
                alert_title, detail, source, console_url, raw_payload,
                tripped_at::text, cleared_at::text, acknowledged_at::text, updated_at::text`,
    [BILLING_GUARD_ID],
  );
  if (!rows[0]) throw new Error('Cloud worker spend row missing');
  return mapRow(rows[0]);
}

/** Force-clear any leftover fail-closed flag from the old $0 guard. */
export async function clearBillingGuard(input: {
  source: string;
  detail?: string | null;
}): Promise<CloudWorkerSpendState> {
  const { rows } = await dbQuery<CloudWorkerSpendState>(
    `UPDATE outreach.billing_guard
        SET tripped = false,
            detail = COALESCE($2, detail),
            source = $3,
            cleared_at = now(),
            tripped_at = NULL,
            updated_at = now()
      WHERE id = $1
      RETURNING id, tripped, cost_amount::float8 AS cost_amount, currency_code,
                alert_title, detail, source, console_url, raw_payload,
                tripped_at::text, cleared_at::text, acknowledged_at::text, updated_at::text`,
    [BILLING_GUARD_ID, input.detail ?? null, input.source],
  );
  if (!rows[0]) throw new Error('Cloud worker spend row missing');
  return mapRow(rows[0]);
}

/** Parse GCP Budget Pub/Sub push / budget notification JSON into a spend update. */
export function parseGcpBudgetNotification(body: unknown): {
  shouldRecord: boolean;
  /** @deprecated Use shouldRecord */
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
    : 'Helios cloud worker budget';

  // Record whenever GCP includes a cost amount (including $0 status pings).
  const shouldRecord = amount != null;

  const detailParts = [
    `${budgetName}: billable spend reported.`,
    amount != null ? `Reported cost: ${amount} ${currency ?? 'USD'}.` : null,
    threshold != null ? `Threshold: ${(threshold <= 1 ? threshold * 100 : threshold).toFixed(2)}%.` : null,
    'Tracked in Analytics Hub; worker continues running.',
  ].filter(Boolean);

  return {
    shouldRecord,
    shouldTrip: shouldRecord,
    costAmount: amount,
    currencyCode: currency ?? 'USD',
    alertTitle: 'Cloud worker GCP spend update',
    detail: detailParts.join(' '),
    raw: messageData,
  };
}
