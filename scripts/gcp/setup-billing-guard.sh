#!/usr/bin/env bash
# Create GCP budget + Pub/Sub push → Helios billing-guard webhook (>$0 fail-closed).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

export PATH="/opt/homebrew/bin:/opt/homebrew/share/google-cloud-sdk/bin:${PATH}"

PROJECT="${GCP_PROJECT:-helios-influencer-network}"
BILLING_ACCOUNT="${GCP_BILLING_ACCOUNT:-011FD6-E83AAF-E53EF3}"
TOPIC="${GCP_BILLING_TOPIC:-helios-billing-guard}"
SUB="${GCP_BILLING_SUB:-helios-billing-guard-push}"
BUDGET_NAME="${GCP_BILLING_BUDGET_NAME:-helios-worker-zero}"
PUBLIC_URL="${HELIOS_PUBLIC_URL:-https://www.heliosgroup.tech}"

if ! command -v gcloud >/dev/null 2>&1; then
  echo "gcloud not found" >&2
  exit 1
fi

gcloud config set project "${PROJECT}" >/dev/null

get_or_create_env() {
  local key="$1"
  local val
  val="$(python3 - <<PY
from pathlib import Path
p = Path('.env.local')
text = p.read_text() if p.exists() else ''
for line in text.splitlines():
    if line.startswith('${key}='):
        print(line.split('=', 1)[1].strip())
        break
PY
)"
  if [[ -z "${val}" ]]; then
    val="$(openssl rand -hex 24)"
    printf '%s=%s\n' "${key}" "${val}" >> .env.local
    echo "Added ${key} to .env.local" >&2
  else
    echo "${key} already set in .env.local" >&2
  fi
  printf '%s' "${val}"
}

TOKEN="$(get_or_create_env GCP_BILLING_WEBHOOK_TOKEN)"
CLEAR_SECRET="$(get_or_create_env BILLING_GUARD_CLEAR_SECRET)"

if [[ -f scripts/gcp/worker.env ]]; then
  python3 - <<PY
from pathlib import Path
p = Path('scripts/gcp/worker.env')
text = p.read_text()
key = 'GCP_BILLING_WEBHOOK_TOKEN'
val = '''${TOKEN}'''
lines = []
found = False
for line in text.splitlines():
    if line.startswith(key + '='):
        lines.append(f'{key}={val}')
        found = True
    else:
        lines.append(line)
if not found:
    lines.append(f'{key}={val}')
p.write_text('\n'.join(lines) + '\n')
print('Updated scripts/gcp/worker.env token', flush=True)
PY
fi

PUSH_ENDPOINT="${PUBLIC_URL%/}/api/webhooks/gcp-billing?token=${TOKEN}"

gcloud services enable \
  pubsub.googleapis.com \
  billingbudgets.googleapis.com \
  cloudbilling.googleapis.com \
  --project="${PROJECT}"

if ! gcloud pubsub topics describe "${TOPIC}" --project="${PROJECT}" >/dev/null 2>&1; then
  gcloud pubsub topics create "${TOPIC}" --project="${PROJECT}"
fi

# Budget create auto-grants billing-budget-alert@system; bind explicitly if needed.
gcloud pubsub topics add-iam-policy-binding "${TOPIC}" \
  --project="${PROJECT}" \
  --member='serviceAccount:billing-budget-alert@system.gserviceaccount.com' \
  --role='roles/pubsub.publisher' >/dev/null \
  || echo "Note: billing-budget-alert IAM bind skipped (often auto-granted on budget create)" >&2

if gcloud pubsub subscriptions describe "${SUB}" --project="${PROJECT}" >/dev/null 2>&1; then
  gcloud pubsub subscriptions update "${SUB}" \
    --project="${PROJECT}" \
    --push-endpoint="${PUSH_ENDPOINT}"
else
  gcloud pubsub subscriptions create "${SUB}" \
    --project="${PROJECT}" \
    --topic="${TOPIC}" \
    --push-endpoint="${PUSH_ENDPOINT}" \
    --ack-deadline=30
fi

PROJECT_NUMBER="$(gcloud projects describe "${PROJECT}" --format='value(projectNumber)')"

EXISTING_BUDGET="$(gcloud billing budgets list \
  --billing-account="${BILLING_ACCOUNT}" \
  --filter="displayName=${BUDGET_NAME}" \
  --format='value(name)' 2>/dev/null | head -1 || true)"

if [[ -z "${EXISTING_BUDGET}" ]]; then
  # Near-zero amount so any project spend crosses early thresholds; webhook trips on costAmount > 0.
  gcloud billing budgets create \
    --billing-account="${BILLING_ACCOUNT}" \
    --display-name="${BUDGET_NAME}" \
    --budget-amount=0.01USD \
    --threshold-rule=percent=0.01 \
    --threshold-rule=percent=1.0 \
    --filter-projects="projects/${PROJECT_NUMBER}" \
    --notifications-rule-pubsub-topic="projects/${PROJECT}/topics/${TOPIC}"
else
  echo "Budget already exists: ${EXISTING_BUDGET}"
fi

echo ""
echo "Billing guard wiring complete."
echo "  Project:   ${PROJECT}"
echo "  Topic:     ${TOPIC}"
echo "  Push URL:  ${PUBLIC_URL%/}/api/webhooks/gcp-billing?token=***"
echo "  Budget:    ${BUDGET_NAME} (\$0.01, alert at 1% and 100%)"
echo ""
echo "Set the same secrets on Vercel production:"
echo "  GCP_BILLING_WEBHOOK_TOKEN"
echo "  BILLING_GUARD_CLEAR_SECRET"
echo ""
echo "Clear-secret length: ${#CLEAR_SECRET}"
