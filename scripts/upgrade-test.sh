#!/usr/bin/env bash
# Upgrade test: data written by the previous image survives the new one.
#
#   OLD_IMAGE=ghcr.io/paisoapp/paiso:0.1.0 NEW_IMAGE=paiso:smoke scripts/upgrade-test.sh
#
# Starts OLD_IMAGE on an empty volume, creates the account, an account and a
# transaction, then swaps in NEW_IMAGE on the same volume and checks that it
# becomes healthy, the database is at the latest migration (/readyz), the data
# and the session secret survived, and a backup was taken when a migration ran.
# The container and volume are removed on exit.
set -euo pipefail

: "${OLD_IMAGE:?set OLD_IMAGE to the previous release}"
: "${NEW_IMAGE:?set NEW_IMAGE to the image under test}"
NAME="${NAME:-paiso-upgrade}"
PORT="${PORT:-18081}"
URL="http://127.0.0.1:$PORT"
EMAIL="owner@example.com"
PASSWORD="upgrade-test-pass-7"

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker volume rm "$NAME-data" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

start() {
  docker run -d --name "$NAME" -p "127.0.0.1:$PORT:8080" -v "$NAME-data:/data" "$1" >/dev/null
  for _ in $(seq 1 90); do
    [[ "$(curl -s -o /dev/null -w '%{http_code}' "$URL/readyz")" == "200" ]] && return 0
    sleep 2
  done
  echo "$1 did not become ready:" >&2
  docker logs "$NAME" >&2
  exit 1
}

json() { python3 -c "import json,sys; print(json.load(sys.stdin)$1)"; }

start "$OLD_IMAGE"
TOKEN="$(curl -sf -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" "$URL/api/auth/register" | json '["access_token"]')"
AUTH="Authorization: Bearer $TOKEN"
ACCOUNT="$(curl -sf -H "$AUTH" -H 'content-type: application/json' \
  -d '{"display_name":"Checking","account_type":"checking","current_balance":1000}' \
  "$URL/api/accounts" | json '["id"]')"
curl -sf -o /dev/null -H "$AUTH" -H 'content-type: application/json' \
  -d "{\"account_id\":$ACCOUNT,\"date_posted\":\"2026-01-15\",\"amount\":-42.5,\"description\":\"UPGRADE TEST\"}" \
  "$URL/api/transactions"
OLD_REV="$(docker exec "$NAME" python -c "import sqlite3;from app.core.config import settings;print(sqlite3.connect(settings.sqlite_path).execute('select version_num from alembic_version').fetchone()[0])")"

docker rm -f "$NAME" >/dev/null
start "$NEW_IMAGE"

# The session from before the upgrade still works: the secrets survived.
TOTAL="$(curl -sf -H "$AUTH" "$URL/api/transactions" | json '["total"]')"
[[ "$TOTAL" == "1" ]] || { echo "expected 1 transaction after the upgrade, found $TOTAL" >&2; exit 1; }
NEW_REV="$(docker exec "$NAME" python -c "import sqlite3;from app.core.config import settings;print(sqlite3.connect(settings.sqlite_path).execute('select version_num from alembic_version').fetchone()[0])")"
if [[ "$OLD_REV" != "$NEW_REV" ]]; then
  docker exec "$NAME" sh -c 'ls /data/backups/pre-*.db' >/dev/null \
    || { echo "a migration ran ($OLD_REV to $NEW_REV) but no backup was taken" >&2; exit 1; }
fi
echo "Upgrade from $OLD_IMAGE ($OLD_REV) to $NEW_IMAGE ($NEW_REV): data and session kept."
