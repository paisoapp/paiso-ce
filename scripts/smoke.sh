#!/usr/bin/env bash
# Build the image (unless IMAGE is given), start it on an empty volume, wait
# for its HEALTHCHECK, and run the container smoke suite against it.
#
#   scripts/smoke.sh                  build ./Dockerfile and test it
#   IMAGE=ghcr.io/... scripts/smoke.sh  test an image that already exists
#
# Needs Docker and Python with backend/requirements.txt installed (the suite
# uses httpx and pyotp). Leaves nothing behind: the container and its volume
# are removed on exit.
set -euo pipefail

cd "$(dirname "$0")/.."
NAME="${NAME:-paiso-smoke}"
PORT="${PORT:-18080}"
PYTHON="${PYTHON:-python3}"

if [[ -z "${IMAGE:-}" ]]; then
  IMAGE="paiso:smoke"
  docker build -t "$IMAGE" .
fi

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker volume rm "$NAME-data" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

docker run -d --name "$NAME" -p "127.0.0.1:$PORT:8080" -v "$NAME-data:/data" "$IMAGE" >/dev/null

for _ in $(seq 1 60); do
  status="$(docker inspect -f '{{.State.Health.Status}}' "$NAME")"
  [[ "$status" == "healthy" ]] && break
  sleep 2
done
if [[ "$status" != "healthy" ]]; then
  echo "The container did not become healthy:" >&2
  docker logs "$NAME" >&2
  exit 1
fi

cd backend
PAISO_URL="http://127.0.0.1:$PORT" PAISO_CONTAINER="$NAME" \
  "$PYTHON" -m pytest tests/smoke -q -p no:cacheprovider "$@"
