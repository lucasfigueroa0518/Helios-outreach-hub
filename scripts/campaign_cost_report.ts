/**
 * Campaign cost report:
 *  A) All-inclusive — every enrichment + drafting spend (retries/failures included)
 *  B) Successful-only — one successful enrichment allocation + final successful
 *     research+write path per lead that reached a reviewable/approved draft
 */
import fs from 'node:fs';
import { dbQuery } from '@/lib/db';

for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const match = line.match(/^([^#=]+)=(.*)$/);
  if (match) process.env[match[1].trim()] = match[2].trim().replace(/^["']|["']$/g, '');
}

const campaignId = process.argv[2] ?? '2b27a197-3b22-4fba-baa4-d8f190ef99f7';

function money(n: number | string | null | undefined): number {
  const v = Number(n ?? 0);
  return Number.isFinite(v) ? v : 0;
}

function usd(n: number): string {
  return `$${n.toFixed(4)}`;
}

async function main() {
  const campaign = await dbQuery<{ name: string; lead_count: number }>(
    `SELECT c.name,
            (SELECT count(*)::int FROM outreach.campaign_leads cl WHERE cl.campaign_id = c.id) AS lead_count
       FROM outreach.campaigns c WHERE c.id = $1`,
    [campaignId],
  );
  if (!campaign.rows[0]) throw new Error(`Campaign not found: ${campaignId}`);

  // ── Enrichment: company research jobs for this campaign's runs ─────────
  const enrichmentJobs = await dbQuery<{
    id: string;
    job_kind: string;
    status: string;
    actual_cost_usd: string | null;
    searches_used: number;
    company_key: string;
  }>(
    `SELECT crj.id, crj.job_kind, crj.status, crj.actual_cost_usd::text,
            crj.searches_used, crj.company_key
       FROM outreach.company_research_jobs crj
      WHERE EXISTS (
        SELECT 1 FROM outreach.runs r
         WHERE r.id = ANY(crj.requested_by_runs)
           AND r.campaign_id = $1
      )
      ORDER BY crj.job_kind, crj.created_at`,
    [campaignId],
  );

  // Enrichment ledger events (per-lead share of company jobs)
  const enrichmentLedger = await dbQuery<{
    lead_id: string;
    full_name: string | null;
    source_id: string;
    actual_cost_usd: string;
  }>(
    `SELECT e.lead_id, l.full_name, e.source_id, e.actual_cost_usd::text
       FROM outreach.lead_cost_events e
       JOIN outreach.leads l ON l.id = e.lead_id
      WHERE e.campaign_id = $1 AND e.phase = 'enrichment'
      ORDER BY l.full_name, e.created_at`,
    [campaignId],
  );

  // ── Drafting jobs (all statuses with cost or terminal) for this campaign ─
  const draftingJobs = await dbQuery<{
    job_id: string;
    item_id: string;
    lead_id: string;
    full_name: string | null;
    company: string | null;
    item_state: string;
    kind: string;
    status: string;
    actual_cost_usd: string;
    attempt_count: number;
    created_at: string;
    finished_at: string | null;
    research_usd: string | null;
    write_usd: string | null;
    adversarial_usd: string | null;
  }>(
    `SELECT j.id AS job_id, i.id AS item_id, i.lead_id, l.full_name,
            coalesce(i.input_overrides->>'company', i.input_snapshot->>'company') AS company,
            i.state AS item_state, j.kind, j.status,
            coalesce(j.actual_cost_usd, 0)::text AS actual_cost_usd,
            j.attempt_count,
            j.created_at::text,
            j.finished_at::text,
            j.usage #>> '{insight,costs,researchUsd}' AS research_usd,
            j.usage #>> '{insight,costs,writeUsd}' AS write_usd,
            j.usage #>> '{adversarial,usage,costUsd}' AS adversarial_usd
       FROM outreach.drafting_jobs j
       JOIN outreach.drafting_items i ON i.id = j.drafting_item_id
       JOIN outreach.drafting_workspaces w ON w.id = i.workspace_id
       JOIN outreach.leads l ON l.id = i.lead_id
      WHERE w.campaign_id = $1
      ORDER BY l.full_name, j.created_at`,
    [campaignId],
  );

  // Drafting ledger (aggregated per item — may include historical resets)
  const draftingLedger = await dbQuery<{
    events: number;
    cost_usd: string;
  }>(
    `SELECT count(*)::int AS events, coalesce(sum(actual_cost_usd), 0)::text AS cost_usd
       FROM outreach.lead_cost_events
      WHERE campaign_id = $1 AND phase = 'drafting'`,
    [campaignId],
  );

  // Successful items = reached a reviewable draft
  const successfulItems = await dbQuery<{
    item_id: string;
    lead_id: string;
    full_name: string | null;
    state: string;
  }>(
    `SELECT i.id AS item_id, i.lead_id, l.full_name, i.state
       FROM outreach.drafting_items i
       JOIN outreach.drafting_workspaces w ON w.id = i.workspace_id
       JOIN outreach.leads l ON l.id = i.lead_id
      WHERE w.campaign_id = $1
        AND i.removed_at IS NULL
        AND i.state IN ('ready_for_review', 'approved')
      ORDER BY l.full_name`,
    [campaignId],
  );
  const successItemIds = new Set(successfulItems.rows.map((r) => r.item_id));
  const successLeadIds = new Set(successfulItems.rows.map((r) => r.lead_id));

  // ── Report A: all-inclusive ────────────────────────────────────────────
  const enrichJobTotal = enrichmentJobs.rows.reduce((s, r) => s + money(r.actual_cost_usd), 0);
  const enrichLedgerTotal = enrichmentLedger.rows.reduce((s, r) => s + money(r.actual_cost_usd), 0);
  const draftJobTotal = draftingJobs.rows.reduce((s, r) => s + money(r.actual_cost_usd), 0);
  const draftLedgerTotal = money(draftingLedger.rows[0]?.cost_usd);

  const draftByKindStatus = new Map<string, { n: number; cost: number }>();
  for (const j of draftingJobs.rows) {
    const key = `${j.kind}/${j.status}`;
    const cur = draftByKindStatus.get(key) ?? { n: 0, cost: 0 };
    cur.n += 1;
    cur.cost += money(j.actual_cost_usd);
    draftByKindStatus.set(key, cur);
  }

  const enrichByKindStatus = new Map<string, { n: number; cost: number }>();
  for (const j of enrichmentJobs.rows) {
    const key = `${j.job_kind}/${j.status}`;
    const cur = enrichByKindStatus.get(key) ?? { n: 0, cost: 0 };
    cur.n += 1;
    cur.cost += money(j.actual_cost_usd);
    enrichByKindStatus.set(key, cur);
  }

  // Per-lead all-inclusive drafting (sum every job on that lead's items)
  const allInclusiveByLead = new Map<string, {
    name: string | null;
    enrichment: number;
    drafting: number;
    researchJobs: number;
    writeJobs: number;
    failedResearch: number;
  }>();

  for (const e of enrichmentLedger.rows) {
    const cur = allInclusiveByLead.get(e.lead_id) ?? {
      name: e.full_name, enrichment: 0, drafting: 0, researchJobs: 0, writeJobs: 0, failedResearch: 0,
    };
    cur.enrichment += money(e.actual_cost_usd);
    allInclusiveByLead.set(e.lead_id, cur);
  }

  for (const j of draftingJobs.rows) {
    const cur = allInclusiveByLead.get(j.lead_id) ?? {
      name: j.full_name, enrichment: 0, drafting: 0, researchJobs: 0, writeJobs: 0, failedResearch: 0,
    };
    cur.drafting += money(j.actual_cost_usd);
    if (j.kind === 'research') {
      cur.researchJobs += 1;
      if (j.status === 'failed') cur.failedResearch += 1;
    }
    if (j.kind === 'write') cur.writeJobs += 1;
    allInclusiveByLead.set(j.lead_id, cur);
  }

  // ── Report B: successful-only ──────────────────────────────────────────
  // Enrichment: only shares from done company-research jobs, for leads that
  // have a successful draft (or all leads that got enrichment — user asked
  // "successful run for each lead" — interpret as successful path costs only).
  //
  // For enrichment success = job status done (all enrichment jobs here are done).
  // Allocate only done-job ledger shares. For "successful run per lead", take
  // enrichment cost attributed to that lead from done jobs only (already the case).
  //
  // For drafting success: for each ready_for_review/approved item, take the
  // latest done research job + the write job with cost that finished for that
  // item (superseded write still carries actual cost in this pipeline).
  // Exclude failed research and any prior research attempts if multiple done.

  const successDraftCostByLead = new Map<string, {
    name: string | null;
    research: number;
    write: number;
    researchJobsKept: number;
    writeJobsKept: number;
    researchJobsExcluded: number;
    writeJobsExcluded: number;
  }>();

  // Group jobs by item
  const jobsByItem = new Map<string, typeof draftingJobs.rows>();
  for (const j of draftingJobs.rows) {
    const list = jobsByItem.get(j.item_id) ?? [];
    list.push(j);
    jobsByItem.set(j.item_id, list);
  }

  for (const item of successfulItems.rows) {
    const jobs = jobsByItem.get(item.item_id) ?? [];
    const researchDone = jobs
      .filter((j) => j.kind === 'research' && j.status === 'done' && money(j.actual_cost_usd) > 0)
      .sort((a, b) => String(a.finished_at ?? a.created_at).localeCompare(String(b.finished_at ?? b.created_at)));
    const writeCharged = jobs
      .filter((j) => j.kind === 'write' && money(j.actual_cost_usd) > 0)
      .sort((a, b) => String(a.finished_at ?? a.created_at).localeCompare(String(b.finished_at ?? b.created_at)));

    // Keep the last successful research (the one that produced the packet used)
    // and the last charged write (final email). Earlier charged attempts = waste.
    const keptResearch = researchDone.length ? [researchDone[researchDone.length - 1]] : [];
    const keptWrite = writeCharged.length ? [writeCharged[writeCharged.length - 1]] : [];

    const researchCost = keptResearch.reduce((s, j) => s + money(j.actual_cost_usd), 0);
    const writeCost = keptWrite.reduce((s, j) => s + money(j.actual_cost_usd), 0);

    const allResearch = jobs.filter((j) => j.kind === 'research');
    const allWrite = jobs.filter((j) => j.kind === 'write');

    successDraftCostByLead.set(item.lead_id, {
      name: item.full_name,
      research: researchCost,
      write: writeCost,
      researchJobsKept: keptResearch.length,
      writeJobsKept: keptWrite.length,
      researchJobsExcluded: Math.max(0, allResearch.length - keptResearch.length),
      writeJobsExcluded: Math.max(0, allWrite.length - keptWrite.length),
    });
  }

  // Successful enrichment: per successful lead, sum enrichment ledger from done jobs only
  const doneEnrichJobIds = new Set(
    enrichmentJobs.rows.filter((j) => j.status === 'done').map((j) => j.id),
  );
  const successEnrichByLead = new Map<string, number>();
  for (const e of enrichmentLedger.rows) {
    if (!doneEnrichJobIds.has(e.source_id)) continue;
    // Attribute enrichment to all campaign leads that received it; for "successful
    // run per lead" pairing, only count leads with a successful draft.
    if (!successLeadIds.has(e.lead_id)) continue;
    successEnrichByLead.set(
      e.lead_id,
      (successEnrichByLead.get(e.lead_id) ?? 0) + money(e.actual_cost_usd),
    );
  }

  // Also: enrichment job totals for done-only (job-level, no double-count across leads)
  const enrichDoneJobTotal = enrichmentJobs.rows
    .filter((j) => j.status === 'done')
    .reduce((s, r) => s + money(r.actual_cost_usd), 0);

  const successDraftResearch = [...successDraftCostByLead.values()].reduce((s, r) => s + r.research, 0);
  const successDraftWrite = [...successDraftCostByLead.values()].reduce((s, r) => s + r.write, 0);
  const successEnrichLeadSum = [...successEnrichByLead.values()].reduce((s, r) => s + r, 0);

  // Waste = all-inclusive job totals − successful path
  const draftWaste = draftJobTotal - (successDraftResearch + successDraftWrite);

  // ── Print ──────────────────────────────────────────────────────────────
  const lines: string[] = [];
  const out = (s = '') => lines.push(s);

  out(`# Cost report — ${campaign.rows[0].name}`);
  out(`Campaign ID: ${campaignId}`);
  out(`Leads on campaign: ${campaign.rows[0].lead_count}`);
  out(`Successful drafts (ready_for_review / approved): ${successfulItems.rows.length}`);
  out(`Generated: ${new Date().toISOString()}`);
  out();

  out(`## A) All-inclusive ledger (retries + failures included)`);
  out();
  out(`Ground-truth spend is taken from job rows (company_research_jobs + drafting_jobs).`);
  out(`Per-lead ledger events allocate enrichment shares and may retain historical drafting rounds.`);
  out();
  out(`### Enrichment`);
  out(`| Job kind / status | Jobs | Cost |`);
  out(`|---|---:|---:|`);
  for (const [key, v] of [...enrichByKindStatus.entries()].sort()) {
    out(`| ${key} | ${v.n} | ${usd(v.cost)} |`);
  }
  out(`| **Job total** | **${enrichmentJobs.rows.length}** | **${usd(enrichJobTotal)}** |`);
  out(`| Lead-share ledger events | ${enrichmentLedger.rows.length} | ${usd(enrichLedgerTotal)} |`);
  out();
  out(`### Drafting`);
  out(`| Kind / status | Jobs | Cost |`);
  out(`|---|---:|---:|`);
  for (const [key, v] of [...draftByKindStatus.entries()].sort()) {
    out(`| ${key} | ${v.n} | ${usd(v.cost)} |`);
  }
  out(`| **Job total** | **${draftingJobs.rows.length}** | **${usd(draftJobTotal)}** |`);
  out(`| Aggregated lead_cost_events (may include prior resets) | ${draftingLedger.rows[0]?.events ?? 0} | ${usd(draftLedgerTotal)} |`);
  out();
  out(`### All-inclusive totals (job ground truth)`);
  out(`| Phase | Cost |`);
  out(`|---|---:|`);
  out(`| Enrichment | ${usd(enrichJobTotal)} |`);
  out(`| Drafting | ${usd(draftJobTotal)} |`);
  out(`| **Combined** | **${usd(enrichJobTotal + draftJobTotal)}** |`);
  out();
  out(`Per-lead average (all-inclusive, over ${campaign.rows[0].lead_count} campaign leads): ${usd((enrichJobTotal + draftJobTotal) / Math.max(1, campaign.rows[0].lead_count))}`);
  out(`Per successful-draft lead average (all-inclusive drafting attributed / ${successfulItems.rows.length}): ${usd(draftJobTotal / Math.max(1, successfulItems.rows.length))}`);
  out();

  out(`### All-inclusive per-lead (top 15 by total)`);
  out(`| Lead | Enrichment (ledger shares) | Drafting (all jobs) | Research jobs | Failed research | Write jobs | Total |`);
  out(`|---|---:|---:|---:|---:|---:|---:|`);
  const ranked = [...allInclusiveByLead.entries()]
    .map(([id, v]) => ({ id, ...v, total: v.enrichment + v.drafting }))
    .sort((a, b) => b.total - a.total);
  for (const row of ranked.slice(0, 15)) {
    out(`| ${row.name ?? row.id.slice(0, 8)} | ${usd(row.enrichment)} | ${usd(row.drafting)} | ${row.researchJobs} | ${row.failedResearch} | ${row.writeJobs} | ${usd(row.total)} |`);
  }
  out();

  out(`## B) Successful-run only (one good path per successful lead)`);
  out();
  out(`Rules:`);
  out(`- Enrichment: lead-share costs from **done** company research jobs, only for leads with a successful draft`);
  out(`- Drafting: for each \`ready_for_review\`/\`approved\` item, keep the **last done research** job and the **last charged write** job; drop failed research and earlier attempts`);
  out(`- Enrichment job-level done total shown for reference (not double-counted with lead shares)`);
  out();
  out(`### Successful totals`);
  out(`| Phase | Cost | Notes |`);
  out(`|---|---:|---|`);
  out(`| Enrichment (lead shares on successful leads) | ${usd(successEnrichLeadSum)} | From done jobs only |`);
  out(`| Enrichment (done jobs, company-level) | ${usd(enrichDoneJobTotal)} | Same ${enrichmentJobs.rows.filter((j) => j.status === 'done').length} jobs — shared across leads |`);
  out(`| Drafting research (last done / lead) | ${usd(successDraftResearch)} | ${successfulItems.rows.length} leads |`);
  out(`| Drafting write (last charged / lead) | ${usd(successDraftWrite)} | ${successfulItems.rows.length} leads |`);
  out(`| **Drafting successful path** | **${usd(successDraftResearch + successDraftWrite)}** | |`);
  out(`| **Combined (enrich lead-shares + successful drafting)** | **${usd(successEnrichLeadSum + successDraftResearch + successDraftWrite)}** | |`);
  out();
  out(`Per successful draft: ${usd((successDraftResearch + successDraftWrite) / Math.max(1, successfulItems.rows.length))} drafting`);
  out(`Per successful draft + its enrichment share: ${usd((successEnrichLeadSum + successDraftResearch + successDraftWrite) / Math.max(1, successfulItems.rows.length))}`);
  out();

  out(`### Waste / retry overhead (drafting jobs)`);
  out(`| | Cost |`);
  out(`|---|---:|`);
  out(`| All drafting jobs | ${usd(draftJobTotal)} |`);
  out(`| Successful path only | ${usd(successDraftResearch + successDraftWrite)} |`);
  out(`| **Retries / failed / superseded extras** | **${usd(draftWaste)}** |`);
  out();

  out(`### Successful per-lead (all ${successfulItems.rows.length})`);
  out(`| Lead | Enrichment share | Research | Write | Drafting total | Excluded research jobs | Excluded write jobs |`);
  out(`|---|---:|---:|---:|---:|---:|---:|`);
  const successRows = [...successDraftCostByLead.entries()]
    .map(([leadId, v]) => ({
      leadId,
      enrich: successEnrichByLead.get(leadId) ?? 0,
      ...v,
      draftTotal: v.research + v.write,
    }))
    .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
  for (const row of successRows) {
    out(`| ${row.name ?? row.leadId.slice(0, 8)} | ${usd(row.enrich)} | ${usd(row.research)} | ${usd(row.write)} | ${usd(row.draftTotal)} | ${row.researchJobsExcluded} | ${row.writeJobsExcluded} |`);
  }
  out();

  out(`## Headlines`);
  out(`- **All-in spend (jobs):** ${usd(enrichJobTotal + draftJobTotal)} (enrich ${usd(enrichJobTotal)} + draft ${usd(draftJobTotal)})`);
  out(`- **Successful-path spend:** ${usd(successEnrichLeadSum + successDraftResearch + successDraftWrite)} (enrich shares ${usd(successEnrichLeadSum)} + draft ${usd(successDraftResearch + successDraftWrite)})`);
  out(`- **Drafting retry waste:** ${usd(draftWaste)} (${((draftWaste / Math.max(draftJobTotal, 1e-9)) * 100).toFixed(1)}% of drafting job spend)`);
  out(`- **Note:** write jobs finished as \`superseded\` in this pipeline but still carry \`actual_cost_usd\` — counted in both reports when charged.`);

  const text = lines.join('\n');
  console.log(text);

  const outPath = `scripts/cost-report-campaign5-${Date.now()}.md`;
  fs.writeFileSync(outPath, text, 'utf8');
  console.error(`\nWrote ${outPath}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
