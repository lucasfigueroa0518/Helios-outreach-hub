import type { DraftingItemState, MailboxVerificationStatus, ReviewStatus } from '@/lib/drafting/types';

export type DraftingItemRow = {
  id: string;
  ordinal: number;
  state: DraftingItemState;
  review_status: ReviewStatus;
  input_revision: number;
  input_fingerprint: string | null;
  last_error_code: string | null;
  empty_brief_attempts: number;
  empty_brief_input_fingerprint: string | null;
  missing_fields: string[];
  effective_fields: {
    email: string | null;
    fullName: string | null;
    firstName: string | null;
    company: string | null;
    title: string | null;
    workLocation: string | null;
  };
  delivery_snapshot: {
    effectiveEmail: string;
    emailVerification: MailboxVerificationStatus;
  } | null;
  can_approve_for_drafting: boolean;
  draft: {
    subject: string;
    body_text: string;
    content_revision: number;
    lint_hard: number;
    lint_warnings: number;
    retry_suggested: boolean;
    lint_hard_codes: string[];
    generated_at: string | null;
    temporal_status: 'verified' | 'context_only' | 'blocked' | 'unknown';
    export_quality_ready: boolean;
    send_status: 'unsent' | 'queued' | 'sending' | 'sent' | 'failed';
    queue_id: string | null;
    schedule_date: string | null;
    sent_at: string | null;
    send_error: string | null;
    engagement:
      | 'unsent'
      | 'failed'
      | 'sent'
      | 'delivered'
      | 'opened'
      | 'clicked'
      | 'replied'
      | 'bounced'
      | 'complained';
    delivered_at: string | null;
    opened_at: string | null;
    clicked_at: string | null;
    bounced_at: string | null;
    replied_at: string | null;
    open_count: number;
    click_count: number;
  } | null;
};

export type WorkspaceActivityPhase = 'verify' | 'research' | 'writing' | 'repair' | 'rewrite';

export type WorkspaceActivityItem = {
  item_id: string;
  ordinal: number;
  lead_name: string | null;
  company: string | null;
  title: string | null;
  phase: WorkspaceActivityPhase;
  state: DraftingItemState;
  snippet: string | null;
};

export type WorkspaceActivity = {
  worker_limit: number;
  active_workers: number;
  items: WorkspaceActivityItem[];
};

export type DraftingSnapshot = {
  workspace: {
    id: string;
    status: string;
    updated_at: string;
    generation_complete: boolean;
    review_complete: boolean;
    paused: boolean;
    paused_at: string | null;
  };
  activity: WorkspaceActivity;
  counts: {
    total: number;
    mailbox_valid_total: number;
    running: number;
    generated: number;
    approved: number;
    waiting_for_enrichment: number;
    verifying_mailbox: number;
    leads_attention: number;
    budget_paused: number;
    failed: number;
    sent: number;
    delivered: number;
    opened: number;
    replied: number;
    bounced: number;
  };
  progress: {
    generated: number;
    mailbox_valid_total: number;
    reviewed: number;
    generated_for_review: number;
  };
  current_item: DraftingItemRow | null;
  neighbors: {
    previous_item_id: string | null;
    next_item_id: string | null;
  };
  email_rows: DraftingItemRow[];
  leads_rows: DraftingItemRow[];
  attention_rows: DraftingItemRow[];
  exports: {
    available: boolean;
    blocking_reasons: string[];
  };
  sends: {
    configured: boolean;
    available: boolean;
    blocking_reasons: string[];
    pending: number;
    today_remaining: number;
    queued_count: number;
    next_schedule_date: string | null;
  };
  rescue: {
    needed: boolean;
    auto_attempted: boolean;
    reasons: Array<
      | 'worker_offline'
      | 'stale_leases'
      | 'stranded_items'
      | 'missing_orch_jobs'
      | 'incomplete_stalled'
    >;
    message: string;
    worker_healthy: boolean;
    stranded_count: number;
    stale_lease_count: number;
    missing_orch_count: number;
  };
};

export type SenderProfile = {
  id: string;
  display_name: string;
  work_email: string;
  title: string;
  company_name: string;
  headshot_storage_path: string | null;
  signature_mode: 'name' | 'name_and_role';
  voice_notes: string | null;
  is_default: boolean;
};
