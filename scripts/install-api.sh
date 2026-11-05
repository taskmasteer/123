#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ $EUID == 0 ]] || { echo 'Run with sudo.' >&2; exit 1; }
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
[[ $ROOT =~ ^/[a-zA-Z0-9_./-]+$ ]] || { echo 'Use an installation path without spaces.' >&2; exit 1; }
[[ ! -f "$ROOT/.local-state/server/config.json" ]] || { echo 'Existing installation; use server-manage.mjs restore/address.' >&2; exit 1; }
IP=${1:?Usage: sudo bash scripts/install-api.sh PUBLIC_IPV4 [BACKUP_FILE]}
BACKUP=${2:-}
[[ $(uname -m) == x86_64 ]] || { echo 'This package supports Linux x86_64.' >&2; exit 1; }
. /etc/os-release
[[ ${ID:-} == ubuntu || ${ID:-} == debian ]] || { echo 'Supported: Ubuntu / Debian with systemd.' >&2; exit 1; }
[[ ${VERSION_CODENAME:-} =~ ^[a-z]+$ ]] || exit 1
apt-get update
apt-get install -y ca-certificates curl gnupg xz-utils openssl build-essential python3
install -d /usr/share/postgresql-common/pgdg
curl --fail --proto '=https' -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc
gpg --show-keys --with-colons /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc | grep -q 'B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8' || { echo 'PostgreSQL repository key mismatch'; exit 1; }
chmod 644 /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main" > /etc/apt/sources.list.d/site-factory-pgdg.list
apt-get update
apt-get install -y postgresql-18
id sitefactory &>/dev/null || useradd --system --home-dir "$ROOT" --shell /usr/sbin/nologin sitefactory
mkdir -p "$ROOT/.local-state/tools" "$ROOT/.local-state/server"
cd "$ROOT/.local-state/tools"
NODE_VERSION=24.22.1
curl --fail --proto '=https' -O "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz"
curl --fail --proto '=https' -o SHASUMS256.txt "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt"
grep " node-v${NODE_VERSION}-linux-x64.tar.xz$" SHASUMS256.txt | sha256sum --check -
mkdir node
tar -xJf "node-v${NODE_VERSION}-linux-x64.tar.xz" --strip-components=1 -C node
chown -R sitefactory:sitefactory "$ROOT"
chmod 700 "$ROOT/.local-state/server"
NODE="$ROOT/.local-state/tools/node/bin/node"
export PATH="$ROOT/.local-state/tools/node/bin:$PATH"
cd "$ROOT"
runuser -u sitefactory -- env PATH="$PATH" ELECTRON_SKIP_BINARY_DOWNLOAD=1 "$NODE" .local-state/tools/node/lib/node_modules/npm/bin/npm-cli.js ci --omit=dev
"$NODE" node_modules/playwright/cli.js install-deps chromium
runuser -u sitefactory -- env PATH="$PATH" PLAYWRIGHT_BROWSERS_PATH="$ROOT/.local-state/browsers" "$NODE" node_modules/playwright/cli.js install chromium --only-shell
# Ubuntu restricts unprivileged user namespaces. Allow them only for this
# installation's Chromium executable; keep Chromium's sandbox enabled.
if [[ -f /proc/sys/kernel/apparmor_restrict_unprivileged_userns ]] && [[ $(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns) == 1 ]]; then
  command -v apparmor_parser >/dev/null || { echo 'AppArmor tools are required for the Chromium sandbox.' >&2; exit 1; }
  cat > /etc/apparmor.d/site-factory-browser <<EOF
abi <abi/4.0>,
include <tunables/global>
profile site-factory-browser $ROOT/.local-state/browsers/**/{chrome-headless-shell,headless_shell} flags=(unconfined) {
  userns,
}
EOF
  apparmor_parser -r /etc/apparmor.d/site-factory-browser
fi
runuser -u sitefactory -- env PATH="$PATH" PLAYWRIGHT_BROWSERS_PATH="$ROOT/.local-state/browsers" "$NODE" scripts/check-api-browser.mjs
COMMON=(runuser -u sitefactory -- env PATH="$PATH" SITE_FACTORY_PG_BIN=/usr/lib/postgresql/18/bin SITE_FACTORY_SECRET_KEY_FILE="$ROOT/.local-state/server/master.key" "$NODE" "$ROOT/scripts/server-manage.mjs")
if [[ -n $BACKUP ]]; then
  BACKUP=$(realpath -- "$BACKUP")
  install -o sitefactory -g sitefactory -m 600 "$BACKUP" "$ROOT/.local-state/restore.sfbak"
  "${COMMON[@]}" init --ip "$IP" --prepare
  "${COMMON[@]}" restore --ip "$IP" --backup "$ROOT/.local-state/restore.sfbak"
else
  "${COMMON[@]}" init --ip "$IP"
fi
cat > /etc/systemd/system/site-factory-api.service <<EOF
[Unit]
Description=Site Factory API and workers
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
User=sitefactory
Group=sitefactory
WorkingDirectory=$ROOT
Environment=SITE_FACTORY_PG_BIN=/usr/lib/postgresql/18/bin
Environment=SITE_FACTORY_SECRET_KEY_FILE=$ROOT/.local-state/server/master.key
ExecStart=$NODE $ROOT/scripts/server-manage.mjs serve
Restart=on-failure
RestartSec=5
TimeoutStopSec=120
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now site-factory-api
READY=0
for attempt in {1..30}; do
  if "${COMMON[@]}" status >/dev/null 2>&1; then READY=1; break; fi
  sleep 2
done
[[ $READY == 1 ]] || { echo 'API did not become ready. Check journalctl -u site-factory-api.' >&2; exit 1; }
if command -v ufw >/dev/null && ufw status | grep -q 'Status: active'; then ufw allow 9443/tcp; fi
echo "API installed. Allow inbound TCP 9443 in your provider firewall. Import $ROOT/site-factory.sfconnection in the client."
