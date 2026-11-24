#!/usr/bin/env bash
set -euo pipefail
[[ $EUID == 0 ]] || { echo 'Run with sudo.' >&2; exit 1; }
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
ARCHIVE=$(realpath -- "${1:?Usage: sudo bash scripts/update-api.sh API_ARCHIVE}")
NODE="$ROOT/.local-state/tools/node/bin/node"
export SITE_FACTORY_PG_BIN=/usr/lib/postgresql/18/bin
export SITE_FACTORY_SECRET_KEY_FILE="$ROOT/.local-state/server/master.key"
export PLAYWRIGHT_BROWSERS_PATH="$ROOT/.local-state/browsers"
export PATH="$ROOT/.local-state/tools/node/bin:$PATH"
COMMON=(runuser -u sitefactory -- env PATH="$PATH" SITE_FACTORY_PG_BIN="$SITE_FACTORY_PG_BIN" SITE_FACTORY_SECRET_KEY_FILE="$SITE_FACTORY_SECRET_KEY_FILE" PLAYWRIGHT_BROWSERS_PATH="$PLAYWRIGHT_BROWSERS_PATH" "$NODE")
APPLIED=0
recover() {
  status=$?
  if [[ $status != 0 ]]; then
    systemctl stop site-factory-api
    if [[ $APPLIED == 1 ]]; then
      "${COMMON[@]}" "$ROOT/scripts/update-api.mjs" rollback || { echo 'Rollback failed; API remains stopped.' >&2; exit 1; }
    fi
    "$NODE" -e 'const fs=require("fs");const p=process.argv[1];if(fs.existsSync(p)&&JSON.parse(fs.readFileSync(p)).state==="installing")process.exit(1)' "$ROOT/.local-state/upgrade.json" || { echo 'Code rollback incomplete; API remains stopped.' >&2; exit 1; }
    systemctl start site-factory-api
  fi
  exit "$status"
}
trap recover EXIT
systemctl stop site-factory-api
"${COMMON[@]}" "$ROOT/scripts/update-api.mjs" "$ARCHIVE"
APPLIED=1
systemctl start site-factory-api
for attempt in {1..40}; do
  if "${COMMON[@]}" "$ROOT/scripts/server-manage.mjs" status >/dev/null 2>&1; then
    echo 'Updated API is healthy. Encrypted backup and previous code retained.'
    exit 0
  fi
  sleep 2
done
echo 'Updated API did not become healthy.' >&2
exit 1
