import { dbQuery } from '@/lib/db';
import { displayNameFromEmail } from '@/lib/login-policy';

/** Owner-scoped lists, or any Auto campaign (shared across signed-in Helios users). */
export function sqlCampaignAccessible(alias: string, ownerSql: string): string {
  return `(${alias}.owner_id = ${ownerSql} OR COALESCE(${alias}.kind, 'manual') = 'auto')`;
}

export type OutreachUser = {
  id: string;
  email: string;
  display_name: string;
};

/** Find-or-create an outreach.users row for a verified allowlisted Helios email. */
export async function upsertUserByEmail(email: string): Promise<OutreachUser> {
  const normalized = email.trim().toLowerCase();
  const displayName = displayNameFromEmail(normalized);

  const existing = await dbQuery<OutreachUser>(
    `SELECT id, email, display_name FROM outreach.users WHERE email = $1`,
    [normalized],
  );

  if (existing.rows[0]) {
    const updated = await dbQuery<OutreachUser>(
      `UPDATE outreach.users
       SET last_login_at = now()
       WHERE id = $1
       RETURNING id, email, display_name`,
      [existing.rows[0].id],
    );
    return updated.rows[0];
  }

  const created = await dbQuery<OutreachUser>(
    `INSERT INTO outreach.users (email, display_name, last_login_at)
     VALUES ($1, $2, now())
     RETURNING id, email, display_name`,
    [normalized, displayName],
  );
  return created.rows[0];
}

/** Verify the session user may read/mutate this campaign (owner, or any Auto campaign). */
export async function assertCampaignOwner(campaignId: string, ownerId: string): Promise<boolean> {
  const { rows } = await dbQuery<{ id: string }>(
    `SELECT id FROM outreach.campaigns
      WHERE id = $1
        AND (
          owner_id = $2
          OR COALESCE(kind, 'manual') = 'auto'
        )`,
    [campaignId, ownerId],
  );
  return rows.length > 0;
}
