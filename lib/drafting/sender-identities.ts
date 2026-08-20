import {
  inferIdentitySlug,
  SENDER_IDENTITY_DEFAULTS,
  type SenderIdentitySlug,
} from '@/lib/agentmail-inboxes';
import { dbQuery } from '@/lib/db';

export type SenderIdentityRow = {
  id: string;
  slug: SenderIdentitySlug;
  display_name: string;
  title: string;
  company_name: string;
  headshot_public_path: string | null;
  voice_notes: string | null;
};

export type SenderInboxRow = {
  id: string;
  identity_id: string;
  identity_slug: SenderIdentitySlug;
  email: string;
  sort_order: number;
  is_primary: boolean;
  enabled: boolean;
};

export const DAILY_INBOX_CAP_DEFAULT = 10;
export const DAILY_INBOX_CAPS = [10, 20] as const;
export type DailyInboxCap = (typeof DAILY_INBOX_CAPS)[number];

export async function getDailyInboxCap(): Promise<DailyInboxCap> {
  const { rows } = await dbQuery<{ value: unknown }>(
    `SELECT value FROM outreach.org_settings WHERE key = 'daily_inbox_cap'`,
  );
  const raw = rows[0]?.value;
  const n = typeof raw === 'number' ? raw : Number(raw);
  return n === 20 ? 20 : DAILY_INBOX_CAP_DEFAULT;
}

export async function setDailyInboxCap(cap: number): Promise<DailyInboxCap> {
  const next: DailyInboxCap = cap === 20 ? 20 : 10;
  await dbQuery(
    `INSERT INTO outreach.org_settings (key, value, updated_at)
     VALUES ('daily_inbox_cap', $1::jsonb, now())
     ON CONFLICT (key) DO UPDATE
        SET value = EXCLUDED.value, updated_at = now()`,
    [JSON.stringify(next)],
  );
  return next;
}

export async function listSenderIdentities(): Promise<SenderIdentityRow[]> {
  const { rows } = await dbQuery<SenderIdentityRow>(
    `SELECT id::text, slug, display_name, title, company_name,
            headshot_public_path, voice_notes
       FROM outreach.sender_identities
      ORDER BY CASE slug WHEN 'lucas' THEN 0 ELSE 1 END`,
  );
  return rows;
}

export async function getSenderIdentityBySlug(
  slug: SenderIdentitySlug,
): Promise<SenderIdentityRow | null> {
  const { rows } = await dbQuery<SenderIdentityRow>(
    `SELECT id::text, slug, display_name, title, company_name,
            headshot_public_path, voice_notes
       FROM outreach.sender_identities
      WHERE slug = $1`,
    [slug],
  );
  return rows[0] ?? null;
}

export async function listSenderInboxes(input: {
  identitySlug?: SenderIdentitySlug | null;
  enabledOnly?: boolean;
} = {}): Promise<SenderInboxRow[]> {
  const params: unknown[] = [];
  const clauses: string[] = [];
  if (input.identitySlug) {
    params.push(input.identitySlug);
    clauses.push(`i.slug = $${params.length}`);
  }
  if (input.enabledOnly !== false) {
    clauses.push('ib.enabled = true');
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const { rows } = await dbQuery<SenderInboxRow>(
    `SELECT ib.id::text, ib.identity_id::text, i.slug AS identity_slug,
            lower(ib.email) AS email, ib.sort_order, ib.is_primary, ib.enabled
       FROM outreach.sender_inboxes ib
       JOIN outreach.sender_identities i ON i.id = ib.identity_id
      ${where}
      ORDER BY CASE i.slug WHEN 'lucas' THEN 0 ELSE 1 END, ib.sort_order ASC`,
    params,
  );
  return rows;
}

export async function getSenderInboxByEmail(email: string): Promise<SenderInboxRow | null> {
  const { rows } = await dbQuery<SenderInboxRow>(
    `SELECT ib.id::text, ib.identity_id::text, i.slug AS identity_slug,
            lower(ib.email) AS email, ib.sort_order, ib.is_primary, ib.enabled
       FROM outreach.sender_inboxes ib
       JOIN outreach.sender_identities i ON i.id = ib.identity_id
      WHERE lower(ib.email) = lower($1)
        AND ib.enabled = true`,
    [email],
  );
  return rows[0] ?? null;
}

export function identityDefaults(slug: SenderIdentitySlug) {
  return SENDER_IDENTITY_DEFAULTS[slug];
}

export function resolveIdentityFromSnapshot(sender: {
  identitySlug?: string | null;
  workEmail?: string | null;
  displayName?: string | null;
}): SenderIdentitySlug {
  return inferIdentitySlug(sender);
}
