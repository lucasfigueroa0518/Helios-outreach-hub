#!/usr/bin/env bash
# Stop the always-on worker VM, set machine type, start it again.
# Needed so drafting can run at laptop-equivalent shard parallelism.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

if [[ -f scripts/gcp/.deploy-env ]]; then
  # shellcheck disable=SC1091
  source scripts/gcp/.deploy-env
fi

PROJECT="${GCP_PROJECT:-$(gcloud config get-value project 2>/dev/null || true)}"
ZONE="${GCP_ZONE:-us-west1-a}"
INSTANCE="${GCP_INSTANCE:-helios-orch-worker}"
MACHINE_TYPE="${GCP_MACHINE_TYPE:-e2-standard-2}"

if ! command -v gcloud >/dev/null 2>&1; then
  echo "gcloud not found. See docs/gcp-e2-micro-worker.md"
  exit 1
fi
if [[ -z "${PROJECT}" || "${PROJECT}" == "(unset)" ]]; then
  echo "GCP project unset. Set GCP_PROJECT or run gcloud config set project …"
  exit 1
fi

current="$(
  gcloud compute instances describe "${INSTANCE}" \
    --project="${PROJECT}" --zone="${ZONE}" \
    --format='value(machineType)'
)"
current="${current##*/}"
echo "Instance ${INSTANCE} is ${current}; target ${MACHINE_TYPE}"
if [[ "${current}" == "${MACHINE_TYPE}" ]]; then
  echo "Already on ${MACHINE_TYPE}."
  exit 0
fi

echo "Stopping ${INSTANCE}…"
gcloud compute instances stop "${INSTANCE}" --project="${PROJECT}" --zone="${ZONE}"

echo "Setting machine type ${MACHINE_TYPE}…"
gcloud compute instances set-machine-type "${INSTANCE}" \
  --project="${PROJECT}" --zone="${ZONE}" \
  --machine-type="${MACHINE_TYPE}"

echo "Starting ${INSTANCE}…"
gcloud compute instances start "${INSTANCE}" --project="${PROJECT}" --zone="${ZONE}"

echo "Waiting for SSH…"
for _ in $(seq 1 30); do
  if gcloud compute ssh "${INSTANCE}" --zone="${ZONE}" --project="${PROJECT}" --command='echo ok' >/dev/null 2>&1; then
    break
  fi
  sleep 5
done

gcloud compute instances describe "${INSTANCE}" \
  --project="${PROJECT}" --zone="${ZONE}" \
  --format='table(name,status,machineType)'
