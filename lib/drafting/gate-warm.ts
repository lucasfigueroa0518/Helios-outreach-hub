/**
 * Warm / cache draft quality-gate audits so Download/Export hits a fresh result
 * instead of cold per-click recomputes. Does not change write/repair quality.
 */

import type { PoolClient } from 'pg';

import { dbQuery, dbTransaction } from '@/lib/db';
import {
  assessResearchTimeliness,
  type ResearchTimelinessAudit,
} from '@/lib/drafting/temporal-policy';
import type { DraftingResearchPacket } from '@/lib/drafting/types';

/** Skip full packet reassess when a matching audit is newer than this. */
export const TEMPORAL_AUDIT_TTL_MS = 5 * 60 * 1000;

/** Max drafts refreshed per workspace snapshot poll. */
export const GATE_WARM_BATCH_LIMIT = 8;

/** Max drafts refreshed across active workspaces per reconcile tick. */
export const GATE_WARM_RECONCILE_LIMIT = 24;

export function asResearchTimelinessAudit(
  value: unknown,
): ResearchTimelinessAudit | null {
  if (!value || typeof value !== 'object') return null;
  const audit = value as Partial<ResearchTimelinessAudit>;
  if (
    typeof audit.auditedAt !== 'string'
    || typeof audit.packetAsOf !== 'string'
    || (audit.status !== 'verified'
      && audit.status !== 'context_only'
      && audit.status !== 'blocked')
  ) {
    return null;
  }
  return audit as ResearchTimelinessAudit;
}

export function isFreshTemporalAudit(
  audit: ResearchTimelinessAudit | null,
  packetAsOf: string | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (!audit || !packetAsOf) return false;
  if (audit.packetAsOf !== packetAsOf) return false;
  const auditedAtMs = Date.parse(audit.auditedAt);
  if (!Number.isFinite(auditedAtMs)) return false;
  return nowMs - auditedAtMs < TEMPORAL_AUDIT_TTL_MS;
}

export type WarmDraftRow = {
  drafting_item_id: string;
  subject: string;
  body_text: string;
  generation_mode: string;
  research_packet_sha256: string;
  temporal_audit: unknown;
  used_fact_ids: string[];
  claim_ledger: { entries?: unknown };
  draft_grounding: {
    usedFactIds?: string[];
    claimLedger?: unknown;
    prospectTerms?: string[];
  } | null;
  packet: DraftingResearchPacket;
  packet_status: string;
};

export async function persistTimelinessAudit(
  client: PoolClient,
  itemId: string,
  audit: ResearchTimelinessAudit,
): Promise<void> {
  await client.query(
    `UPDATE outreach.draft_research_packets
        SET temporal_status = $2, temporal_audit = $3::jsonb,
            status = CASE WHEN $2 = 'blocked' THEN 'stale' ELSE status END,
            updated_at = now()
      WHERE drafting_item_id = $1`,
    [itemId, audit.status, JSON.stringify(audit)],
  );
  await client.query(
    `UPDATE outreach.email_drafts
        SET temporal_status = $2, temporal_audit = $3::jsonb, updated_at = now()
      WHERE drafting_item_id = $1`,
    [itemId, audit.status, JSON.stringify(audit)],
  );
}

/**
 * Refresh temporal audits for reviewable drafts whose cache is older than TTL.
 * Safe to call from workspace snapshot polls and system.reconcile.
 */
export async function warmStaleDraftTimeliness(options: {
  workspaceId?: string;
  limit?: number;
} = {}): Promise<number> {
  const limit = Math.max(1, options.limit ?? GATE_WARM_BATCH_LIMIT);
  const params: unknown[] = [TEMPORAL_AUDIT_TTL_MS];
  let workspaceClause = '';
  if (options.workspaceId) {
    params.push(options.workspaceId);
    workspaceClause = `AND di.workspace_id = $${params.length}`;
  }
  params.push(limit);

  const { rows } = await dbQuery<WarmDraftRow>(
    `SELECT ed.drafting_item_id, ed.subject, ed.body_text, ed.generation_mode,
            ed.research_packet_sha256, ed.temporal_audit, ed.used_fact_ids,
            ed.claim_ledger, ed.draft_grounding,
            p.packet, p.status AS packet_status
       FROM outreach.email_drafts ed
       JOIN outreach.drafting_items di ON di.id = ed.drafting_item_id
       JOIN outreach.draft_research_packets p ON p.drafting_item_id = ed.drafting_item_id
      WHERE di.removed_at IS NULL
        AND di.state IN ('ready_for_review', 'approved')
        AND ed.generation_mode = 'live'
        ${workspaceClause}
        AND (
          ed.temporal_audit->>'auditedAt' IS NULL
          OR (ed.temporal_audit->>'auditedAt')::timestamptz
             < now() - ($1::bigint * interval '1 millisecond')
          OR ed.temporal_audit->>'packetAsOf' IS DISTINCT FROM p.packet->>'asOf'
        )
      ORDER BY di.ordinal
      LIMIT $${params.length}`,
    params,
  );

  if (rows.length === 0) return 0;

  await dbTransaction(async (client) => {
    for (const row of rows) {
      const audit = assessResearchTimeliness(row.packet);
      await persistTimelinessAudit(client, row.drafting_item_id, audit);
    }
  });

  return rows.length;
}
