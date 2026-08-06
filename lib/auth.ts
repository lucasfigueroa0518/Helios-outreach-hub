import { dbQuery } from '@/lib/db';
import { displayNameFromEmail } from '@/lib/session';

export type OutreachUser = {
  id: string;
  email: string;
  display_name: string;
};

/** Find-or-create an outreach.users row for a validated Embark email. */
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

/** Verify a campaign belongs to the session user before touching child rows. */
export async function assertCampaignOwner(campaignId: string, ownerId: string): Promise<boolean> {
  const { rows } = await dbQuery<{ id: string }>(
    `SELECT id FROM outreach.campaigns WHERE id = $1 AND owner_id = $2`,
    [campaignId, ownerId],
  );
  return rows.length > 0;
}
