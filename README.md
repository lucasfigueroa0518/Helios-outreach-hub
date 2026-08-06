# Lucas Outreach Hub (reference app)

Standalone Next.js reference for Eva Outreach Hub. Behavioral changes here must
be dual-ported to Eva in the same session (see `.cursor/rules/outreach-eva-port.mdc`).

Coworkers cloning Eva should use the Eva path documented in
`docs/modules/outreach-hub.md` § Coworker local setup — this app is optional
local tooling and is parent-gitignored.

## Stack

- **Frontend / API**: Next.js (App Router)
- **Database**: Postgres (`DATABASE_URL` / `DIRECT_DATABASE_URL`)
- **AI**: Claude (Anthropic) when `DRAFTING_MODE=live` / `EXTRACTION_MODE=live`
- **Worker**: durable Postgres orchestration (`npm run worker` / `worker:dev`)

## Setup

1. Copy env vars:
   ```
   cp .env.example .env.local
   ```
   Keep `EXTRACTION_MODE=stub` and `DRAFTING_MODE=stub` until you intentionally
   spend. `.env.local` is gitignored — never commit secrets.

2. Install dependencies:
   ```
   npm install
   ```

3. Apply the full Outreach schema + drafting ALTER migrations (preferred):
   ```
   npm run db:setup
   ```
   `db:drafting` alone is incomplete — it can miss generation-mode / duration-aware
   ALTERs that `db:setup` applies via `scripts/db_setup.js`.

4. Run the app + auto-reloading worker together:
   ```
   npm run dev
   ```
   Production-style worker (no watch): `npm run worker`.

## Notes

- Stub drafts may be reviewed/approved for offline work; export/send stay blocked
  until regenerated with live drafting.
- Schema readiness fails closed when required drafting columns are missing
  (`lib/drafting/runtime-readiness.ts`).
