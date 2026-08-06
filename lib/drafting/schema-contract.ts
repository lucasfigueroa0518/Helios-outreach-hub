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
  'outreach.drafting_job_cost_events',
  'outreach.drafting_run_cost_opening_balances',
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
