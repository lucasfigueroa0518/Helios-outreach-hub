# Always-on orchestration worker on Google Cloud

Runs `npm run worker` on an always-on GCE VM so drafting, queued email sends,
and the rest of Postgres orchestration keep firing when your laptop is closed.

Vercel still serves the Next.js app. This VM is **only** the long-running worker.

The original Always Free **e2-micro** (1 GB) could not run laptop-equivalent
drafting shards — it serialized research (`ORG_DRAFT_RESEARCH_CONCURRENCY=1`).
Production now uses **e2-standard-2** (2 vCPU, 8 GB) so the cloud worker uses
the same admission control as `npm run worker` on a laptop:

| Knob | Cloud = laptop |
|---|---:|
| `DRAFTING_ANTHROPIC_MAX_INFLIGHT` | 8 |
| `ORG_DRAFT_RESEARCH_CONCURRENCY` | 8 (effective **4** shards) |
| `ORG_DRAFT_WRITE_CONCURRENCY` | 8 (effective **1** after research reserve) |
| `ORCHESTRATION_WORKER_MAX_CONCURRENCY` | 16 (effective **7**) |
| `ORG_MAILBOX_VERIFY_CONCURRENCY` | 3 |
| `PG_POOL_MAX` | 8 (worker-only process) |

Worker id stays `gcp-e2-micro-1` so existing leases and the laptop/cloud
fallback fence keep working. This VM still **yields** while any laptop/dev
worker heartbeat is healthy, then claims again ~45s after that machine goes
away.

## Machine

| Rule | Value |
|---|---|
| Machine | `e2-standard-2` (not free-tier) |
| Region | `us-west1-a` |
| Memory | 8 GB; systemd `MemoryMax=7G` |
| Disk | Keep boot disk ≤ 30 GB standard persistent disk |

Resize an existing VM (stops it briefly):

```bash
chmod +x scripts/gcp/resize-worker-vm.sh
./scripts/gcp/resize-worker-vm.sh
./scripts/gcp/deploy-worker-code.sh
```

## What the worker needs

Minimum env (copy from `.env.local`, strip auth/frontend-only keys):

```bash
DIRECT_DATABASE_URL=...          # preferred over pooler for worker
DATABASE_URL=...                 # fallback
ORCHESTRATOR=postgres
AGENT_MAIL_API=...               # outreach email.send + mailbox verify
AGENTMAIL_INBOX_ID=abcdefg@agentmail.to  # verify-only; never an outreach inbox
ANTHROPIC_API_KEY=...            # drafting/enrichment jobs (if those run in prod)
ANTHROPIC_ADMIN_API_KEY=...      # Cost API billed totals for Analytics Hub (sk-ant-admin01-…)
PG_POOL_MAX=8
ORCHESTRATION_POLL_MS=400
ORCHESTRATION_WORKER_MAX_CONCURRENCY=16
ORCHESTRATION_WORKER_ID=gcp-e2-micro-1
ORCHESTRATION_FALLBACK_WORKER_ID=gcp-e2-micro-1
DRAFTING_ANTHROPIC_MAX_INFLIGHT=8
ORG_EMAIL_SEND_CONCURRENCY=2
ORG_DRAFT_RESEARCH_CONCURRENCY=8
ORG_DRAFT_WRITE_CONCURRENCY=8
ORG_EXTRACTION_CONCURRENCY=3
ORG_RESEARCH_CONCURRENCY=2
ORG_MAILBOX_VERIFY_CONCURRENCY=3
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
- Zone: `us-west1-a`
- Name: `helios-orch-worker`
- Machine: `e2-standard-2`
- Installs Node 22, 2 GB swap, copies app, systemd unit `helios-worker`
- Deploy coords file: `scripts/gcp/.deploy-env`

Re-run deploy after code or env changes:

```bash
./scripts/gcp/deploy-worker-code.sh
```

That also installs `scripts/gcp/helios-worker.service` (memory limits).

### 4. Verify

```bash
gcloud compute ssh helios-orch-worker --zone=us-west1-a \
  --command='sudo systemctl status helios-worker --no-pager'
```

From the repo (with DB env locally):

```bash
npm run worker:status
```

Confirm `config.draftingResearch` is **4**, `draftingWrite` is **1**, `workerMax` is **7**,
and the live worker is `gcp-e2-micro-1`.

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

GCP budget notifications feed **Analytics Hub** (Spend → Cloud worker (GCP)). Spend
does **not** stop the orchestration worker or email sends — billable usage is expected so daily
sends can run on the always-on VM. `e2-standard-2` is paid compute; track it there.

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

- The worker incurs GCE compute / network charges; track them in Analytics Hub.
- Do **not** use a preemptible/spot VM for this — the queue needs a stable process.
- Do **not** stop the VM overnight; backlog will not send or draft while stopped.
- Billing account is required on the GCP project.
- External IPv4 and egress above Always Free can still bill.

## If the VM OOMs

1. Confirm swap: `free -h` should show ~2G swap.
2. Confirm systemd `MemoryMax=7G` and machine type `e2-standard-2`.
3. Prefer `DIRECT_DATABASE_URL`. Do not drop drafting shards back to 1 without
   an explicit decision — that reintroduces serial cloud drafting.
4. If still tight, step to `e2-standard-4` via `GCP_MACHINE_TYPE` and
   `./scripts/gcp/resize-worker-vm.sh`.
