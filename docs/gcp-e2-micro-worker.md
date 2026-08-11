# Always-on worker on Google Cloud e2-micro (Always Free)

Runs `npm run worker` on a free-tier **e2-micro** VM so queued email sends (and the rest of Postgres orchestration) keep firing when your laptop is closed.

Vercel still serves the Next.js app. This VM is **only** the long-running worker.

## Free-tier constraints

| Rule | Value |
|---|---|
| Machine | `e2-micro` |
| Always Free regions | `us-west1`, `us-central1`, or `us-east1` |
| Memory | 1 GB → use swap + low concurrency (see below) |
| Disk | Keep boot disk ≤ 30 GB standard persistent disk |

One e2-micro in an Always Free region stays in the free tier if your project has no other conflicting Always Free VM usage. Confirm in [GCP Free Cloud Features](https://cloud.google.com/free/docs/free-cloud-features).

## What the worker needs

Minimum env (copy from `.env.local`, strip auth/frontend-only keys):

```bash
DIRECT_DATABASE_URL=...          # preferred over pooler for worker
DATABASE_URL=...                 # fallback
ORCHESTRATOR=postgres
RESEND_API_KEY=...               # backlog email.send
ANTHROPIC_API_KEY=...            # drafting/enrichment jobs (if those run in prod)
# Keep concurrency low on e2-micro:
PG_POOL_MAX=2
ORCHESTRATION_WORKER_MAX_CONCURRENCY=2
ORG_EMAIL_SEND_CONCURRENCY=1
ORG_DRAFT_RESEARCH_CONCURRENCY=1
ORG_DRAFT_WRITE_CONCURRENCY=1
ORG_EXTRACTION_CONCURRENCY=1
ORG_RESEARCH_CONCURRENCY=1
```

Full template: [`scripts/gcp/worker.env.example`](../scripts/gcp/worker.env.example).

## One-time setup (your Mac)

`gcloud` is not installed in this workspace yet — install it on your machine first.

### 1. Install Google Cloud SDK

```bash
# macOS
brew install --cask google-cloud-sdk
# open a new terminal so `gcloud` is on PATH, then:
gcloud init
gcloud auth login
gcloud config set project YOUR_PROJECT_ID
```

Enable compute:

```bash
gcloud services enable compute.googleapis.com
```

### 2. Create the worker env file (local, do not commit)

```bash
cp scripts/gcp/worker.env.example scripts/gcp/worker.env
# Edit scripts/gcp/worker.env — paste real secrets from .env.local
```

### 3. Provision the VM

```bash
chmod +x scripts/gcp/provision-e2-micro-worker.sh
./scripts/gcp/provision-e2-micro-worker.sh
```

Defaults / current prod worker:

- Project: `helios-influencer-network` (billing already linked; `helios-hub` hit billing-project quota)
- Zone: `us-west1-a` (Always Free region; `us-central1-*` was capacity-exhausted at provision time)
- Name: `helios-orch-worker`
- Installs Node 22, 2 GB swap, copies app, systemd unit `helios-worker`
- Deploy coords file: `scripts/gcp/.deploy-env`

Re-run deploy after code changes:

```bash
./scripts/gcp/deploy-worker-code.sh
```

### 4. Verify

```bash
gcloud compute ssh helios-orch-worker --zone=us-west1-a \
  --command='sudo systemctl status helios-worker --no-pager'
```

From the repo (with DB env locally):

```bash
npm run worker:status
```

In the app: Hub → **Queue**. Overdue badges should clear once the worker is healthy and due jobs drain.

## Ops cheat sheet

```bash
# Logs
gcloud compute ssh helios-orch-worker --zone=us-west1-a \
  --command='sudo journalctl -u helios-worker -f'

# Restart
gcloud compute ssh helios-orch-worker --zone=us-west1-a \
  --command='sudo systemctl restart helios-worker'

# Update env on the VM
gcloud compute scp scripts/gcp/worker.env \
  helios-orch-worker:/tmp/worker.env --zone=us-west1-a
gcloud compute ssh helios-orch-worker --zone=us-west1-a \
  --command='sudo mv /tmp/worker.env /opt/helios-worker/worker.env && sudo systemctl restart helios-worker'
```

## Cloud worker spend tracking

GCP budget notifications feed **Analytics Hub** (Spend → Cloud worker (GCP)). Spend does
**not** stop the orchestration worker or email sends — billable usage is expected so daily
sends can run on the always-on VM.

1. GCP Budget (`helios-worker-zero`, $0.01 with early thresholds) publishes to Pub/Sub topic `helios-billing-guard`.
2. Push subscription hits `POST /api/webhooks/gcp-billing?token=…` on the production app.
3. Hub writes `outreach.billing_guard` with the latest reported `cost_amount` (`tripped` stays false).
4. Analytics Hub shows that amount as infra spend (not attributed per campaign/lead).

One-time wiring (from your Mac, with `gcloud` authenticated):

```bash
chmod +x scripts/gcp/setup-billing-guard.sh
HELIOS_PUBLIC_URL=https://www.heliosgroup.tech ./scripts/gcp/setup-billing-guard.sh
```

Then put the same secrets on **Vercel production** (and keep them in `.env.local`):

- `GCP_BILLING_WEBHOOK_TOKEN`
- `BILLING_GUARD_CLEAR_SECRET` (optional; only for clearing a leftover legacy fail-closed flag)

Apply the table if needed: `npm run db:drafting`. Redeploy the app (webhook + Analytics Hub)
and worker code. Until the app deploy lands, Pub/Sub push will get middleware `401` on
`/api/webhooks/gcp-billing`.

## Cost / sleep notes

- The worker may incur normal GCP compute / network charges; track them in Analytics Hub.
- Do **not** use a preemptible/spot VM for this — the queue needs a stable process.
- Do **not** stop the VM overnight; stopped Always Free VMs are fine for disk, but backlog will not send while stopped.
- Billing account may still be required on the GCP project even when usage is free.
- External IPv4 and egress above Always Free can still bill — the guard above is the hard stop.

## If the VM OOMs

1. Confirm swap: `free -h` should show ~2G swap.
2. Lower concurrency further in `worker.env`.
3. Prefer `DIRECT_DATABASE_URL` and `PG_POOL_MAX=1`.
4. As a last resort, upgrade to e2-small (paid) or move the worker to Oracle Always Free / a home always-on box.
