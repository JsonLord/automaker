#!/bin/sh

set -e

DEST_DIR="/app/apps/server/dist/assets"
DEST_FILE="${DEST_DIR}/build-provenance.json"

mkdir -p "$DEST_DIR"

if [ -n "$BUILD_GIT_SHA" ]; then
  SHA="$BUILD_GIT_SHA"
elif git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  SHA=$(git rev-parse HEAD)
else
  SHA="unknown"
fi

if [ -n "$BUILD_TIMESTAMP" ]; then
  TS="$BUILD_TIMESTAMP"
elif git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  TS=$(git show -s --format=%cI HEAD)
else
  TS=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
fi

cat > "$DEST_FILE" <<JSON
{
  "gitSha": "$SHA",
  "buildTimestamp": "$TS"
}
JSON

echo "Generated build provenance at $DEST_FILE: SHA=$SHA, Timestamp=$TS"
