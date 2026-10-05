#!/bin/sh
# entrypoint.sh - Initialize environment and start Automaker for Hugging Face

echo "Starting Automaker entrypoint script..."

# Ensure directories exist
mkdir -p "$DATA_DIR"
mkdir -p "$HOME/.local/share/opencode"
mkdir -p "$HOME/.config/gh"
: "${ARGUS_SKILL_HOME:=${DATA_DIR}/argus}"
export ARGUS_SKILL_HOME
mkdir -p "$ARGUS_SKILL_HOME"

# OpenCode configuration is upserted by the server. The key stays in COMPATIBLE_API_KEY.
[ -n "$COMPATIBLE_URL" ] && [ -n "$COMPATIBLE_MODEL" ] && \
    echo "Compatible OpenCode provider configuration detected."

# Configure GitHub CLI authentication
if [ -n "$GITHUB_PAT" ]; then
    export GH_TOKEN="$GITHUB_PAT"
    echo "GitHub authentication configured from GITHUB_PAT."
fi

# Start application
echo "Starting application on port $PORT..."
exec node apps/server/dist/index.js
