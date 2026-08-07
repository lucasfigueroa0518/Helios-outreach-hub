#!/usr/bin/env bash
# Push latest repo code to an existing e2-micro worker and restart.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

PROJECT="${GCP_PROJECT:-$(gcloud config get-value project 2>/dev/null || true)}"
ZONE="${GCP_ZONE:-us-central1-a}"
INSTANCE="${GCP_INSTANCE:-helios-orch-worker}"
ENV_FILE="${WORKER_ENV_FILE:-scripts/gcp/worker.env}"

if ! command -v gcloud >/dev/null 2>&1; then
  echo "gcloud not found. See docs/gcp-e2-micro-worker.md"
  exit 1
fi

ARCHIVE="$(mktemp -t helios-worker-XXXXXX).tgz"
trap 'rm -f "${ARCHIVE}"' EXIT
tar -czf "${ARCHIVE}" \
  --exclude='./.git' \
  --exclude='./node_modules' \
  --exclude='./.next' \
  --exclude='./.env.local' \
  --exclude='./scripts/gcp/worker.env' \
  --exclude='./.cursor' \
  .

gcloud compute scp --zone="${ZONE}" --project="${PROJECT}" \
  "${ARCHIVE}" "${INSTANCE}:/tmp/helios-app.tgz"

if [[ -f "${ENV_FILE}" ]]; then
  gcloud compute scp --zone="${ZONE}" --project="${PROJECT}" \
    "${ENV_FILE}" "${INSTANCE}:/tmp/worker.env"
fi

gcloud compute ssh "${INSTANCE}" --zone="${ZONE}" --project="${PROJECT}" --command="
  set -euo pipefail
  sudo rm -rf /opt/helios-worker/app
  sudo mkdir -p /opt/helios-worker/app
  sudo tar -xzf /tmp/helios-app.tgz -C /opt/helios-worker/app
  if [[ -f /tmp/worker.env ]]; then
    sudo mv /tmp/worker.env /opt/helios-worker/worker.env
    sudo chmod 600 /opt/helios-worker/worker.env
  fi
  cd /opt/helios-worker/app
  sudo npm ci
  sudo systemctl restart helios-worker
  sudo systemctl --no-pager --full status helios-worker || true
"

echo "Deployed to ${INSTANCE}."
