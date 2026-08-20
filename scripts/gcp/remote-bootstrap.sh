#!/usr/bin/env bash
# Runs on the e2-micro VM (via provision script). Idempotent.
set -euo pipefail

APP_DIR=/opt/helios-worker
SWAP_MB=2048
NODE_MAJOR=22
UNIT_SRC="${HELIOS_WORKER_UNIT_SRC:-/tmp/helios-worker.service}"

export DEBIAN_FRONTEND=noninteractive

apt-get update -y
apt-get install -y ca-certificates curl git build-essential python3

# Swap — keep even after the RAM upgrade; drafting spikes still happen.
if ! swapon --show | grep -q '/swapfile'; then
  if [[ ! -f /swapfile ]]; then
    fallocate -l "${SWAP_MB}M" /swapfile || dd if=/dev/zero of=/swapfile bs=1M count="${SWAP_MB}"
    chmod 600 /swapfile
    mkswap /swapfile
  fi
  swapon /swapfile || true
  if ! grep -q '/swapfile' /etc/fstab; then
    echo '/swapfile none swap sw 0 0' >> /etc/fstab
  fi
fi

# Node 22 via NodeSource
if ! command -v node >/dev/null || [[ "$(node -v | cut -d. -f1 | tr -d v)" -lt "${NODE_MAJOR}" ]]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
fi

mkdir -p "${APP_DIR}"
chown -R "$(id -un)":"$(id -gn)" "${APP_DIR}" 2>/dev/null || true

if [[ -f "${UNIT_SRC}" ]]; then
  cp "${UNIT_SRC}" /etc/systemd/system/helios-worker.service
else
  cat >/etc/systemd/system/helios-worker.service <<'UNIT'
[Unit]
Description=Helios Outreach Hub orchestration worker
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/helios-worker/app
EnvironmentFile=/opt/helios-worker/worker.env
ExecStart=/usr/bin/npm run worker
Restart=always
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=120
MemoryMax=7G
MemoryHigh=6G
Nice=5

[Install]
WantedBy=multi-user.target
UNIT
fi

systemctl daemon-reload
systemctl enable helios-worker.service

echo "Bootstrap complete. Node $(node -v). Swap:"
free -h
