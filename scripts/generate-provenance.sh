#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

if [ -f "release-source.json" ]; then
    node "$SCRIPT_DIR/verify-release-context.mjs"
else
    echo "release-source.json not found, using graceful fallback SHA"
    FALLBACK_SHA="0000000000000000000000000000000000000000"
    PROVENANCE_FILE="${PROVENANCE_FILE:-/app/apps/server/dist/assets/build-provenance.json}"

    COMMIT_SHA=$(git rev-parse HEAD 2>/dev/null || echo "$FALLBACK_SHA")
    TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    mkdir -p "$(dirname "$PROVENANCE_FILE")"
    cat <<JSON > "$PROVENANCE_FILE"
{
  "gitSha": "$COMMIT_SHA",
  "sourceIdentity": "fallback",
  "buildTimestamp": "$TIMESTAMP"
}
JSON
    echo "Fallback provenance generated at $PROVENANCE_FILE"
fi
