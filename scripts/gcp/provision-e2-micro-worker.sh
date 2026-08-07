#!/usr/bin/env bash
# Create (or reuse) an Always Free e2-micro VM and install the Helios worker.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

PROJECT="${GCP_PROJECT:-$(gcloud config get-value project 2>/dev/null || true)}"
if [[ -f "$(dirname "$0")/.deploy-env" ]]; then
  # shellcheck disable=SC1091
  source "$(dirname "$0")/.deploy-env"
fi
ZONE="${GCP_ZONE:-us-west1-a}"
INSTANCE="${GCP_INSTANCE:-helios-orch-worker}"
ENV_FILE="${WORKER_ENV_FILE:-scripts/gcp/worker.env}"

if ! command -v gcloud >/dev/null 2>&1; then
  echo "gcloud not found. Install: brew install --cask google-cloud-sdk"
  echo "Then: gcloud init && re-run this script."
  echo "Guide: docs/gcp-e2-micro-worker.md"
  exit 1
fi

if [[ -z "${PROJECT}" || "${PROJECT}" == "(unset)" ]]; then
  echo "No GCP project set. Run: gcloud config set project YOUR_PROJECT_ID"
  exit 1
fi

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Missing ${ENV_FILE}"
  echo "  cp scripts/gcp/worker.env.example scripts/gcp/worker.env"
  echo "  # paste DIRECT_DATABASE_URL, RESEND_API_KEY, etc from .env.local"
  exit 1
fi

if ! grep -qE '^(DIRECT_DATABASE_URL|DATABASE_URL)=.+' "${ENV_FILE}"; then
  echo "${ENV_FILE} needs DIRECT_DATABASE_URL or DATABASE_URL filled in."
  exit 1
fi

echo "Project=${PROJECT} Zone=${ZONE} Instance=${INSTANCE}"

gcloud services enable compute.googleapis.com --project="${PROJECT}"

if gcloud compute instances describe "${INSTANCE}" --zone="${ZONE}" --project="${PROJECT}" >/dev/null 2>&1; then
  echo "Instance ${INSTANCE} already exists — skipping create."
else
  echo "Creating e2-micro (Always Free region required)…"
  gcloud compute instances create "${INSTANCE}" \
    --project="${PROJECT}" \
    --zone="${ZONE}" \
    --machine-type=e2-micro \
    --image-family=ubuntu-2204-lts \
    --image-project=ubuntu-os-cloud \
    --boot-disk-size=30GB \
    --boot-disk-type=pd-standard \
    --tags=helios-worker \
    --scopes=cloud-platform \
    --metadata=enable-oslogin=TRUE
fi

echo "Waiting for SSH…"
for i in $(seq 1 30); do
  if gcloud compute ssh "${INSTANCE}" --zone="${ZONE}" --project="${PROJECT}" --command='echo ok' >/dev/null 2>&1; then
    break
  fi
  sleep 5
done

echo "Uploading bootstrap + app + env…"
gcloud compute ssh "${INSTANCE}" --zone="${ZONE}" --project="${PROJECT}" \
  --command='sudo mkdir -p /opt/helios-worker && sudo chmod 755 /opt/helios-worker'

gcloud compute scp --zone="${ZONE}" --project="${PROJECT}" \
  scripts/gcp/remote-bootstrap.sh "${INSTANCE}:/tmp/remote-bootstrap.sh"

gcloud compute ssh "${INSTANCE}" --zone="${ZONE}" --project="${PROJECT}" \
  --command='sudo bash /tmp/remote-bootstrap.sh'

# Sync app code (excludes heavy/local paths)
ARCHIVE="$(mktemp -t helios-worker-XXXXXX).tgz"
trap 'rm -f "${ARCHIVE}"' EXIT
tar -czf "${ARCHIVE}" \
  --exclude='./.git' \
  --exclude='./node_modules' \
  --exclude='./.next' \
  --exclude='./.env.local' \
  --exclude='./scripts/gcp/worker.env' \
  --exclude='./agent-transcripts' \
  --exclude='./.cursor' \
  .

gcloud compute scp --zone="${ZONE}" --project="${PROJECT}" \
  "${ARCHIVE}" "${INSTANCE}:/tmp/helios-app.tgz"

gcloud compute scp --zone="${ZONE}" --project="${PROJECT}" \
  "${ENV_FILE}" "${INSTANCE}:/tmp/worker.env"

gcloud compute ssh "${INSTANCE}" --zone="${ZONE}" --project="${PROJECT}" --command='
  set -euo pipefail
  sudo mkdir -p /opt/helios-worker/app
  sudo tar -xzf /tmp/helios-app.tgz -C /opt/helios-worker/app
  sudo mv /tmp/worker.env /opt/helios-worker/worker.env
  sudo chmod 600 /opt/helios-worker/worker.env
  cd /opt/helios-worker/app
  # tsx is a devDependency and is required for `npm run worker`.
  sudo npm ci
  sudo systemctl restart helios-worker
  sleep 2
  sudo systemctl --no-pager --full status helios-worker || true
'

echo ""
echo "Done. Worker should be running on ${INSTANCE}."
echo "Logs: gcloud compute ssh ${INSTANCE} --zone=${ZONE} --command='sudo journalctl -u helios-worker -f'"
echo "Doc:  docs/gcp-e2-micro-worker.md"
