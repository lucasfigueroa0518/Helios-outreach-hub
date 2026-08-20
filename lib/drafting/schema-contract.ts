/**
 * Runtime-critical drafting schema contract.
 *
 * Code under lib/drafting/** assumes these tables, columns, and functions
 * exist. verify_drafting_schema.ts checks the live database against this list
 * before local dev starts and after db:drafting applies.
 */
export type DraftingSchemaColumn = {
  table: `${string}.${string}`;
  column: string;
  reason: string;
};

export type DraftingSchemaFunction = {
  schema: string;
  name: string;
  reason: string;
};

export const DRAFTING_REQUIRED_TABLES = [
  'outreach.drafting_workspaces',
  'outreach.drafting_runs',
  'outreach.drafting_items',
  'outreach.drafting_jobs',
  'outreach.drafting_company_research_leases',
  'outreach.draft_research_packets',
  'outreach.email_drafts',
  'outreach.email_sends',
  'outreach.email_send_queue',
  'outreach.sender_identities',
  'outreach.sender_inboxes',
  'outreach.org_settings',
  'outreach.billing_guard',
  'outreach.drafting_job_cost_events',
  'outreach.drafting_run_cost_opening_balances',
  'outreach.anthropic_cost_report_days',
] as const;

/** Columns referenced by repository/jobs paths that are added incrementally. */
export const DRAFTING_REQUIRED_COLUMNS: DraftingSchemaColumn[] = [
  {
    table: 'outreach.drafting_jobs',
    column: 'execution_epoch',
    reason: 'Go to Drafting revives terminal jobs and cost events key spend by epoch',
  },
  {
    table: 'outreach.drafting_items',
    column: 'empty_brief_attempts',
    reason: 'Empty-brief retry budget and quarantine',
  },
  {
    table: 'outreach.drafting_items',
    column: 'empty_brief_input_fingerprint',
    reason: 'Empty-brief retry budget and quarantine',
  },
  {
    table: 'outreach.drafting_items',
    column: 'empty_brief_last_at',
    reason: 'Empty-brief retry budget and quarantine',
  },
  {
    table: 'outreach.drafting_items',
    column: 'last_error_code',
    reason: 'Resume/retry surfacing and quarantine labels',
  },
  {
    table: 'outreach.email_sends',
    column: 'provider_rfc_message_id',
    reason: 'Resend reply threading via Message-ID',
  },
  {
    table: 'outreach.email_sends',
    column: 'delivered_at',
    reason: 'Resend delivery engagement',
  },
  {
    table: 'outreach.email_sends',
    column: 'opened_at',
    reason: 'Resend open engagement',
  },
  {
    table: 'outreach.email_sends',
    column: 'replied_at',
    reason: 'Resend inbound reply matching',
  },
  {
    table: 'outreach.email_sends',
    column: 'processed_webhook_ids',
    reason: 'Idempotent Resend webhook ingestion',
  },
  {
    table: 'outreach.email_send_queue',
    column: 'schedule_date',
    reason: 'Daily send budget buckets (America/New_York)',
  },
  {
    table: 'outreach.email_send_queue',
    column: 'scheduled_for',
    reason: 'Orchestration available_at for deferred sends',
  },
  {
    table: 'outreach.email_send_queue',
    column: 'orchestration_job_id',
    reason: 'Link queue rows to email.send orch jobs',
  },
  {
    table: 'outreach.email_send_queue',
    column: 'sender_inbox_id',
    reason: 'Per-inbox daily cap and Agent Mail From routing',
  },
  {
    table: 'outreach.email_send_queue',
    column: 'from_email',
    reason: 'Allocated outreach inbox at enqueue time',
  },
  {
    table: 'outreach.email_sends',
    column: 'sender_inbox_id',
    reason: 'Analytics and reply routing by Agent Mail inbox',
  },
  {
    table: 'outreach.email_sends',
    column: 'provider_thread_id',
    reason: 'Agent Mail thread matching for inbound replies',
  },
  {
    table: 'outreach.org_settings',
    column: 'value',
    reason: 'Org daily inbox cap (10 or 20)',
  },
  {
    table: 'outreach.billing_guard',
    column: 'cost_amount',
    reason: 'Track GCP cloud worker spend for Analytics Hub',
  },
  {
    table: 'outreach.sender_profiles',
    column: 'company_name',
    reason: 'HTML email signature company line',
  },
  {
    table: 'outreach.sender_profiles',
    column: 'headshot_storage_path',
    reason: 'HTML email signature headshot (png/jpeg in Storage)',
  },
  {
    table: 'outreach.reply_sends',
    column: 'actual_cost_usd',
    reason: 'Anthropic reply-draft spend on the work row',
  },
  {
    table: 'outreach.reply_sends',
    column: 'usage',
    reason: 'Anthropic token buckets for reply drafts',
  },
  {
    table: 'dashboards.context_updates',
    column: 'actual_cost_usd',
    reason: 'Anthropic dashboard summary spend',
  },
  {
    table: 'dashboards.context_updates',
    column: 'usage',
    reason: 'Anthropic token buckets for dashboard summaries',
  },
];

export const DRAFTING_REQUIRED_FUNCTIONS: DraftingSchemaFunction[] = [
  {
    schema: 'public',
    name: 'claim_drafting_job',
    reason: 'Worker claim path',
  },
  {
    schema: 'public',
    name: 'finish_drafting_job',
    reason: 'Worker finish path',
  },
  {
    schema: 'public',
    name: 'record_drafting_job_cost_event',
    reason: 'Append-only provider spend persistence',
  },
];

export function formatDraftingSchemaDrift(missing: string[]): string {
  const lines = [
    'Drafting schema drift detected — runtime SQL will fail until the database is upgraded.',
    '',
    ...missing.map((item) => `- missing ${item}`),
    '',
    'Fix: cd lucas-outreach-hub && npm run db:drafting',
    'Audit: npm run verify:drafting',
  ];
  return lines.join('\n');
}
