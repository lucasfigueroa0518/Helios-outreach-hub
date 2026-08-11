# Per-owner GitHub PAT storage (Outreach Hub / Auth.js)

Adapted from the donor `helios-dashboards` plan. Clerk is **not** used.
Auth gates use Outreach Hub Auth.js + `ALLOWED_EMAIL_DOMAINS`.

## Model

- Table: `dashboards.github_tokens`
- Keyed by `github_handle` (unique). Sync resolves owner from
  `project.github_repo` (`owner/repo` → owner).
- `added_by_user_id` = Auth.js / `outreach.users.id` (uuid)
- At rest: AES-256-GCM via `TOKEN_ENCRYPTION_KEY` (32 bytes, base64)
- Columns store ciphertext, IV, auth tag, and `token_suffix` (last 4) only

## Security bar

- Never return plaintext from any API; never put tokens in RSC props, logs, or Sentry
- Decrypt only in server/worker paths that build an Octokit client
- Scrub `github_pat_…` / `ghp_…` from logged errors
- Validate on submit: `GET https://api.github.com/user`, require
  `login` to match claimed handle, then encrypt and discard plaintext

## Env

```bash
openssl rand -base64 32   # → TOKEN_ENCRYPTION_KEY
```

Add to `.env.local`, Vercel, and `scripts/gcp/worker.env` (worker must decrypt for daily sync). Backup the key in 1Password — losing it loses all stored PATs.

## Implementation status

- [x] SQL table (`db/dashboards_schema.sql`)
- [x] `lib/dashboards/crypto.ts`, `getTokenForRepo`, scrub helper
- [x] First-use PAT prompt on `/dashboards` (gate until user adds a token)
- [x] Token APIs at `/api/dashboards/tokens` (Auth.js gated)
- [x] Worker job `dashboards.daily_update` (enqueued by `system.reconcile` after 09:00 UTC)

See donor brief: `helios-dashboards/MERGE_INTO_OUTREACH_HUB.md` §3 and §10.

**Ops:** Keep the same `TOKEN_ENCRYPTION_KEY` in `.env.local`, Vercel, and
`scripts/gcp/worker.env`. Back it up in 1Password.
