import fs from 'node:fs';
import { dbQuery } from '@/lib/db';
import { evidenceBackedFormats, type ResearchFormat } from '@/lib/research-types';

for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const match = line.match(/^([^#=]+)=(.*)$/);
  if (match) process.env[match[1].trim()] = match[2].trim().replace(/^["']|["']$/g, '');
}

async function main() {
  const summaryOnly = process.argv.includes('--summary');
  const campaignArg = process.argv.slice(2).find((arg) => !arg.startsWith('--')) ?? 'Campaign #2';
  const campaigns = await dbQuery<{ id: string; name: string }>(
    `SELECT id, name FROM outreach.campaigns WHERE name = $1 ORDER BY created_at DESC LIMIT 1`,
    [campaignArg],
  );
  const campaign = campaigns.rows[0];
  if (!campaign) {
    console.log(JSON.stringify({ error: `Campaign not found: ${campaignArg}` }, null, 2));
    return;
  }

  const runs = await dbQuery<{
    id: string;
    status: string;
    started_at: string;
    finished_at: string | null;
    stats: Record<string, unknown>;
  }>(
    `SELECT id, status, started_at, finished_at, stats
     FROM outreach.runs
     WHERE campaign_id = $1
     ORDER BY (status = 'uploading') ASC, started_at DESC`,
    [campaign.id],
  );
  const latestRun = runs.rows[0];
  if (!latestRun) {
    console.log(JSON.stringify({ campaign, message: 'No runs yet — upload and click Enrich first.' }, null, 2));
    return;
  }

  const enrichment = (latestRun.stats?.enrichment ?? {}) as Record<string, number>;
  const leads = await dbQuery<{
    full_name: string;
    email_primary: string | null;
    email_status: string;
    email_source_note: string | null;
    title: string | null;
    company_name: string | null;
    location: string | null;
    profile_enrichment: Record<string, { research_pass?: string }> | null;
    reused_from_prior_lead: boolean;
  }>(
    `SELECT l.full_name, l.email_primary, l.email_status, l.email_source_note,
            l.title, l.company_name, l.location, l.profile_enrichment,
            cl.reused_from_prior_lead
     FROM outreach.campaign_leads cl
     JOIN outreach.leads l ON l.id = cl.lead_id
         WHERE cl.run_id = $1
     ORDER BY l.last_name NULLS LAST, l.first_name NULLS LAST`,
        [latestRun.id],
  );

  const rescueJobs = await dbQuery<{
    id: string;
    company_key: string;
    status: string;
    grade: string | null;
    research_pass: string | null;
    person_name: string | null;
    resolved_domain: string | null;
    last_error: string | null;
    literal_count: number;
    format_count: number;
    profile_count: number;
    literal_candidates: Array<{
      person_name: string;
      email: string;
      source_url: string;
      source_quote?: string;
    }>;
    format_candidates: ResearchFormat[];
  }>(
    `SELECT j.id, j.company_key, j.status, j.grade, j.resolved_domain, j.last_error,
            j.disambiguation->>'research_pass' AS research_pass,
            j.disambiguation->'people'->0->>'full_name' AS person_name,
            coalesce(jsonb_array_length(j.research_result->'literal_emails'), 0)::int AS literal_count,
            coalesce(jsonb_array_length(j.research_result->'formats'), 0)::int AS format_count,
            coalesce(jsonb_array_length(j.research_result->'profile_findings'), 0)::int AS profile_count,
            coalesce(j.research_result->'literal_emails', '[]'::jsonb) AS literal_candidates,
            coalesce(j.research_result->'formats', '[]'::jsonb) AS format_candidates
     FROM outreach.company_research_jobs j
     WHERE $1 = ANY(j.requested_by_runs)
     ORDER BY j.created_at`,
    [latestRun.id],
  );
  const emailByStatus = leads.rows.reduce<Record<string, number>>((acc, lead) => {
    acc[lead.email_status] = (acc[lead.email_status] ?? 0) + 1;
    return acc;
  }, {});

  const profileRescued = leads.rows.filter((lead) =>
    lead.profile_enrichment
    && Object.values(lead.profile_enrichment).some((entry) => entry.research_pass === 'profile_rescue'));

  const report = {
    campaign,
    latest_run: {
      id: latestRun.id,
      status: latestRun.status,
      started_at: latestRun.started_at,
      finished_at: latestRun.finished_at,
    },
    enrichment_stats: {
      direct: enrichment.direct ?? 0,
      d1_upload: enrichment.d1 ?? 0,
      d2_embark_db: enrichment.d2 ?? 0,
      d3_prior_lead: enrichment.d3 ?? 0,
      d4_literal: enrichment.d4 ?? 0,
      d4_model: enrichment.d4_model ?? 0,
      d4_scrape_preflight: enrichment.d4_scrape_preflight ?? 0,
      d4_scrape_post: enrichment.d4_scrape_post ?? 0,
      inferred: enrichment.inferred ?? 0,
      format_guess: enrichment.format_guess ?? 0,
      not_found: enrichment.not_found ?? 0,
      profile_rescue_jobs: enrichment.profile_rescue_jobs ?? 0,
      profile_rescue_jobs_completed: enrichment.profile_rescue_jobs_completed ?? 0,
      profile_rescue_jobs_failed: enrichment.profile_rescue_jobs_failed ?? 0,
      profile_rescue_fields_requested: enrichment.profile_rescue_fields_requested ?? 0,
      profile_rescue_fields_enriched: enrichment.profile_rescue_fields_enriched ?? 0,
      profile_rescue_fields_unresolved: enrichment.profile_rescue_fields_unresolved ?? 0,
      email_rescue_jobs: enrichment.email_rescue_jobs ?? 0,
      email_rescue_jobs_completed: enrichment.email_rescue_jobs_completed ?? 0,
      email_rescue_jobs_failed: enrichment.email_rescue_jobs_failed ?? 0,
      email_rescue_people: enrichment.email_rescue_people ?? 0,
      email_rescue_direct: enrichment.email_rescue_direct ?? 0,
      email_rescue_inferred: enrichment.email_rescue_inferred ?? 0,
      exact_search_queries: enrichment.exact_search_queries ?? 0,
      exact_search_confirmed: enrichment.exact_search_confirmed ?? 0,
      provider_calls: enrichment.provider_calls ?? 0,
      provider_finder_found: enrichment.provider_finder_found ?? 0,
      provider_finder_no_result: enrichment.provider_finder_no_result ?? 0,
      provider_verifier_invalid: enrichment.provider_verifier_invalid ?? 0,
      provider_errors: enrichment.provider_errors ?? 0,
      mailbox_valid: enrichment.mailbox_valid ?? 0,
      mailbox_invalid: enrichment.mailbox_invalid ?? 0,
      mailbox_accept_all: enrichment.mailbox_accept_all ?? 0,
      mailbox_risky: enrichment.mailbox_risky ?? 0,
      mailbox_unknown: enrichment.mailbox_unknown ?? 0,
      mailbox_provider_errors: enrichment.mailbox_provider_errors ?? 0,
      i1: enrichment.i1 ?? 0,
      i2: enrichment.i2 ?? 0,
      i3: enrichment.i3 ?? 0,
      companies_total: enrichment.companies_total ?? 0,
      companies_researched: enrichment.companies_researched ?? 0,
      companies_cache_hit: enrichment.companies_cache_hit ?? 0,
      companies_failed: enrichment.companies_failed ?? 0,
      scrape_pages_attempted: enrichment.scrape_pages_attempted ?? 0,
      scrape_pages_fetched: enrichment.scrape_pages_fetched ?? 0,
      scrape_errors: enrichment.scrape_errors ?? 0,
      verified_ok: enrichment.verified_ok ?? 0,
      verified_no_mx: enrichment.verified_no_mx ?? 0,
    },
    email_status_breakdown: emailByStatus,
    rescue_jobs: {
      profile: rescueJobs.rows.filter((job) => job.research_pass === 'profile_rescue'),
      email: rescueJobs.rows.filter((job) => job.research_pass === 'email_rescue'),
      primary: rescueJobs.rows.filter((job) => !job.research_pass || job.research_pass === 'primary'),
    },
    profile_rescue_wins: profileRescued.map((lead) => ({
      name: lead.full_name,
      fields: Object.entries(lead.profile_enrichment ?? {})
        .filter(([, entry]) => entry.research_pass === 'profile_rescue')
        .map(([field]) => field),
    })),
    format_guess_rows: leads.rows
      .filter((lead) => lead.email_status === 'format_guess')
      .map((lead) => ({
        name: lead.full_name,
        email: lead.email_primary,
        note: lead.email_source_note,
      })),
    prior_lead_reuse: leads.rows.filter((lead) => lead.reused_from_prior_lead).map((lead) => lead.full_name),
    lead_snapshot: leads.rows.map((lead) => ({
      name: lead.full_name,
      email_status: lead.email_status,
      email: lead.email_primary,
      company: lead.company_name,
      title: lead.title,
      location: lead.location,
      email_note: lead.email_source_note,
    })),
  };

  if (summaryOnly) {
    const emailRescueJobs = report.rescue_jobs.email;
    const usableFormatJobs = emailRescueJobs.filter((job) =>
      evidenceBackedFormats(job.format_candidates).length > 0);
    const emailRescueGrades = emailRescueJobs.reduce<Record<string, number>>((counts, job) => {
      const grade = job.grade ?? 'ungraded';
      counts[grade] = (counts[grade] ?? 0) + 1;
      return counts;
    }, {});
    console.log(JSON.stringify({
      campaign: report.campaign,
      latest_run: report.latest_run,
      enrichment_stats: report.enrichment_stats,
      email_status_breakdown: report.email_status_breakdown,
      rescue_job_counts: {
        profile: report.rescue_jobs.profile.length,
        email: emailRescueJobs.length,
        primary: report.rescue_jobs.primary.length,
      },
      email_rescue_evidence: {
        grade_breakdown: emailRescueGrades,
        jobs_with_literal_candidate: emailRescueJobs.filter((job) => job.literal_count > 0).length,
        jobs_with_format_candidate: emailRescueJobs.filter((job) => job.format_count > 0).length,
        jobs_with_usable_format: usableFormatJobs.length,
        jobs_with_neither: emailRescueJobs.filter((job) =>
          job.literal_count === 0 && job.format_count === 0).length,
        literal_candidates: emailRescueJobs.flatMap((job) =>
          job.literal_candidates.map((candidate) => ({
            person: job.person_name,
            ...candidate,
          }))),
        usable_formats: usableFormatJobs.map((job) => ({
          person: job.person_name,
          domain: job.resolved_domain,
          formats: evidenceBackedFormats(job.format_candidates).map((format) => ({
            pattern: format.pattern,
            confidence: format.confidence,
            share_pct: format.share_pct,
          })),
        })),
      },
      profile_rescue_wins: report.profile_rescue_wins,
      format_guess_count: report.format_guess_rows.length,
      prior_lead_reuse: report.prior_lead_reuse,
    }, null, 2));
    return;
  }
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
