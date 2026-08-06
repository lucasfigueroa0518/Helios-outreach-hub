import { dbQuery, dbTransaction } from '@/lib/db';
import { priorLeadGuessUntrusted } from '@/lib/identity';
import { enqueueWorkInTransaction } from '@/lib/orchestration/repository';

export type PriorEnrichmentDecision = 'use_prior' | 're_enrich';

export async function initPriorEnrichmentScanStats(runId: string, peopleTotal: number) {
  await dbQuery(
    `UPDATE outreach.runs
        SET stats = stats || jsonb_build_object(
          'prior_enrichment',
          jsonb_build_object(
            'people_total', $2::int,
            'people_scanned', 0,
            'awaiting_count', 0,
            'scan_complete', false
          )
        )
      WHERE id = $1`,
    [runId, peopleTotal],
  );
}

export async function updatePriorEnrichmentScanProgress(
  runId: string,
  peopleScanned: number,
  awaitingCount: number,
) {
  await dbQuery(
    `UPDATE outreach.runs
        SET stats = jsonb_set(
          stats,
          '{prior_enrichment}',
          coalesce(stats->'prior_enrichment', '{}'::jsonb)
            || jsonb_build_object(
              'people_scanned', $2::int,
              'awaiting_count', $3::int
            ),
          true
        )
      WHERE id = $1`,
    [runId, peopleScanned, awaitingCount],
  );
}

export async function completePriorEnrichmentScan(runId: string, awaitingCount: number) {
  await dbQuery(
    `UPDATE outreach.runs
        SET stats = jsonb_set(
          stats,
          '{prior_enrichment}',
          coalesce(stats->'prior_enrichment', '{}'::jsonb)
            || jsonb_build_object(
              'awaiting_count', $2::int,
              'scan_complete', true
            ),
          true
        ),
            status = CASE
              WHEN $2::int > 0 THEN 'awaiting_prior_enrichment'
              ELSE status
            END
      WHERE id = $1`,
    [runId, awaitingCount],
  );
}

export async function applyPriorEnrichmentDecision(
  runId: string,
  ownerId: string,
  decision: PriorEnrichmentDecision,
) {
  await dbTransaction(async (client) => {
    const run = await client.query<{ id: string; campaign_id: string; status: string }>(
      `SELECT r.id, r.campaign_id, r.status
         FROM outreach.runs r
         JOIN outreach.campaigns c ON c.id = r.campaign_id
        WHERE r.id = $1
          AND c.owner_id = $2
          AND r.user_id = $2
        FOR UPDATE`,
      [runId, ownerId],
    );
    if (!run.rows[0]) throw new Error('Run not found');
    if (run.rows[0].status !== 'awaiting_prior_enrichment') {
      throw new Error('Run is not awaiting a prior enrichment decision');
    }

    const pending = await client.query<{
      campaign_id: string;
      lead_id: string;
      prior_enrichment_lead_id: string | null;
    }>(
      `SELECT campaign_id, lead_id, prior_enrichment_lead_id
         FROM outreach.campaign_leads
        WHERE run_id = $1
          AND prior_enrichment_pending`,
      [runId],
    );

    if (decision === 'use_prior') {
      for (const row of pending.rows) {
        const priorLeadId = row.prior_enrichment_lead_id;
        if (!priorLeadId) continue;

        const prior = await client.query<{ email_status: string | null }>(
          `SELECT email_status FROM outreach.leads WHERE id = $1`,
          [priorLeadId],
        );
        if (priorLeadGuessUntrusted(prior.rows[0]?.email_status)) {
          await client.query(
            `UPDATE outreach.leads
                SET email_primary = NULL,
                    email_alt_1 = NULL,
                    email_alt_2 = NULL,
                    email_source_note = 'prior format guess discarded — re-researching',
                    updated_at = now()
              WHERE id = $1`,
            [priorLeadId],
          );
        }

        await client.query(
          `DELETE FROM outreach.campaign_leads
            WHERE campaign_id = $1
              AND lead_id = $2`,
          [row.campaign_id, row.lead_id],
        );
        await client.query(
          `INSERT INTO outreach.campaign_leads (
             campaign_id, lead_id, run_id, reused_from_prior_lead,
             prior_enrichment_pending, prior_enrichment_lead_id
           ) VALUES ($1, $2, $3, true, false, NULL)
           ON CONFLICT (campaign_id, lead_id) DO UPDATE SET
             run_id = EXCLUDED.run_id,
             reused_from_prior_lead = true,
             prior_enrichment_pending = false,
             prior_enrichment_lead_id = NULL`,
          [row.campaign_id, priorLeadId, runId],
        );
        await client.query(
          `DELETE FROM outreach.leads l
            WHERE l.id = $1
              AND NOT EXISTS (
                SELECT 1 FROM outreach.campaign_leads cl WHERE cl.lead_id = l.id
              )`,
          [row.lead_id],
        );
      }
    } else {
      await client.query(
        `UPDATE outreach.campaign_leads
            SET prior_enrichment_pending = false,
                prior_enrichment_lead_id = NULL,
                reused_from_prior_lead = false
          WHERE run_id = $1
            AND prior_enrichment_pending`,
        [runId],
      );
    }

    await client.query(
      `UPDATE outreach.runs
          SET status = 'enriching',
              stats = jsonb_set(
                stats,
                '{prior_enrichment}',
                coalesce(stats->'prior_enrichment', '{}'::jsonb)
                  || jsonb_build_object('decision', $2::text),
                true
              )
        WHERE id = $1`,
      [runId, decision],
    );

    // Atomic with the status flip — never leave enriching visible without a
    // pending/in_flight run.enrich, or system.reconcile will finalize mid-flight
    // (Campaign #9 scar).
    await enqueueWorkInTransaction(client, {
      kind: 'run.enrich',
      payload: { runId },
      dedupeKey: `${runId}:enrich`,
      scopeKey: runId,
      reviveTerminal: true,
    });
  });
}
