-- db/dashboards_schema.sql — Helios Dashboards tables (idempotent).
-- Lives in Outreach Hub's Supabase Postgres under schema `dashboards`.
-- Do NOT point the app at the donor dashboards Supabase project.
--
-- Naming (merge decision):
--   Schema:  dashboards
--   Tables:  snake_case plurals (clients, projects, repo_events, …)
--   Donor Prisma PascalCase → SQL snake_case; text ids kept for cuid import.
--   Auth:    no dashboards.users — use outreach.users via Auth.js
--   Tokens:  dashboards.github_tokens (AES-256-GCM ciphertext only)
--
-- Apply:
--   npm run db:dashboards
--   # or full: npm run db:setup
\set ON_ERROR_STOP on

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS dashboards;

-- Private deck PDFs (Supabase Storage; preferred over Vercel Blob).
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'dashboards-decks',
    'dashboards-decks',
    false,
    52428800,
    ARRAY['application/pdf']
)
ON CONFLICT (id) DO UPDATE SET
    public = EXCLUDED.public,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

-- ── Clients ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS dashboards.clients (
    id             text PRIMARY KEY,
    name           text NOT NULL,
    contact_email  text,
    created_at     timestamptz NOT NULL DEFAULT now()
);

-- ── Projects ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS dashboards.projects (
    id                   text PRIMARY KEY,
    client_id            text NOT NULL REFERENCES dashboards.clients (id),
    name                 text NOT NULL,
    status               text NOT NULL DEFAULT 'ACTIVE'
                             CHECK (status IN ('ACTIVE', 'PAUSED', 'COMPLETE', 'ARCHIVED')),
    start_date           timestamptz NOT NULL,
    target_end_date      timestamptz NOT NULL,
    completed_at         timestamptz,
    access_token         text NOT NULL UNIQUE,
    github_repo          text NOT NULL DEFAULT '',
    github_branch        text NOT NULL DEFAULT 'main',
    github_last_sync_at  timestamptz,
    last_sync_error      text,
    readme_markdown      text,
    readme_fetched_at    timestamptz,
    deck_pdf_url         text,
    deck_storage_path    text,
    cron_enabled         boolean NOT NULL DEFAULT true,
    cron_status          text NOT NULL DEFAULT 'IDLE',
    mvp_delivered        boolean NOT NULL DEFAULT false,
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dashboards_projects_client
    ON dashboards.projects (client_id);
CREATE INDEX IF NOT EXISTS idx_dashboards_projects_access_token
    ON dashboards.projects (access_token);
CREATE INDEX IF NOT EXISTS idx_dashboards_projects_status
    ON dashboards.projects (status);

-- ── Repo events ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS dashboards.repo_events (
    id                 text PRIMARY KEY,
    project_id         text NOT NULL REFERENCES dashboards.projects (id) ON DELETE CASCADE,
    type               text NOT NULL
                           CHECK (type IN ('COMMIT', 'PR_MERGED', 'ISSUE_CLOSED', 'RELEASE')),
    external_id        text NOT NULL,
    title              text NOT NULL,
    body               text,
    author_name        text NOT NULL,
    author_login       text,
    author_avatar_url  text,
    url                text NOT NULL,
    occurred_at        timestamptz NOT NULL,
    meta               jsonb,
    fetched_at         timestamptz NOT NULL DEFAULT now(),
    UNIQUE (project_id, type, external_id)
);

CREATE INDEX IF NOT EXISTS idx_dashboards_repo_events_project_occurred
    ON dashboards.repo_events (project_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_dashboards_repo_events_project_type_occurred
    ON dashboards.repo_events (project_id, type, occurred_at);

-- ── Context updates (AI progress summaries) ─────────────────────────────────

CREATE TABLE IF NOT EXISTS dashboards.context_updates (
    id            text PRIMARY KEY,
    project_id    text NOT NULL REFERENCES dashboards.projects (id) ON DELETE CASCADE,
    bullets       jsonb NOT NULL,
    window_start  timestamptz NOT NULL,
    window_end    timestamptz NOT NULL,
    generated_at  timestamptz NOT NULL DEFAULT now(),
    generated_by  text NOT NULL DEFAULT 'CRON'
                      CHECK (generated_by IN ('CRON', 'MANUAL', 'WORKER'))
);

ALTER TABLE dashboards.context_updates
    ADD COLUMN IF NOT EXISTS actual_cost_usd numeric(10, 4) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS usage jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_dashboards_context_updates_project_generated
    ON dashboards.context_updates (project_id, generated_at DESC);

-- ── Per-user GitHub PATs (encrypted at rest; never return plaintext) ─────────
-- Lookup at sync time by github_handle = owner from project.github_repo.
-- added_by_user_id is Auth.js / outreach.users.id (not Clerk).

CREATE TABLE IF NOT EXISTS dashboards.github_tokens (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    github_handle      text NOT NULL,
    encrypted_token    text NOT NULL,
    iv                 text NOT NULL,
    auth_tag           text NOT NULL,
    token_suffix       text NOT NULL,
    added_by_user_id   uuid NOT NULL REFERENCES outreach.users (id),
    added_by_email     text NOT NULL,
    last_used_at       timestamptz,
    expires_at         timestamptz,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT dashboards_github_tokens_handle_unique UNIQUE (github_handle)
);

CREATE INDEX IF NOT EXISTS idx_dashboards_github_tokens_handle_lower
    ON dashboards.github_tokens (lower(github_handle));

COMMENT ON TABLE dashboards.github_tokens IS
    'AES-256-GCM ciphertext for per-user GitHub PATs. Decrypt only in server/worker memory. Never expose plaintext via API.';
COMMENT ON COLUMN dashboards.github_tokens.token_suffix IS
    'Last 4 characters of the raw PAT for masked UI display only.';
COMMENT ON COLUMN dashboards.projects.deck_storage_path IS
    'Path inside storage.buckets dashboards-decks; preferred over Vercel Blob URLs.';
COMMENT ON COLUMN dashboards.context_updates.generated_by IS
    'CRON/MANUAL from donor; WORKER for Outreach Hub orchestration jobs.';
