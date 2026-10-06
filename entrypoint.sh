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

# Map HF Space secrets for OpenAI compatible provider if present
[ -z "$COMPATIBLE_URL" ] && [ -n "$OPENAI_COMPATIBLE_URL" ] && export COMPATIBLE_URL="$OPENAI_COMPATIBLE_URL"
[ -z "$COMPATIBLE_URL" ] && [ -n "$openai_compatible_url" ] && export COMPATIBLE_URL="$openai_compatible_url"

[ -z "$COMPATIBLE_MODEL" ] && [ -n "$OPENAI_COMPATIBLE_MODEL" ] && export COMPATIBLE_MODEL="$OPENAI_COMPATIBLE_MODEL"
[ -z "$COMPATIBLE_MODEL" ] && [ -n "$openai_compatible_model" ] && export COMPATIBLE_MODEL="$openai_compatible_model"

[ -z "$COMPATIBLE_API_KEY" ] && [ -n "$OPENAI_COMPATIBLE_API_KEY" ] && export COMPATIBLE_API_KEY="$OPENAI_COMPATIBLE_API_KEY"
[ -z "$COMPATIBLE_API_KEY" ] && [ -n "$openai_compatible_api_key" ] && export COMPATIBLE_API_KEY="$openai_compatible_api_key"

export COMPATIBLE_URL COMPATIBLE_MODEL COMPATIBLE_API_KEY

# OpenCode configuration is upserted by the server. The key stays in COMPATIBLE_API_KEY.
if [ -n "$COMPATIBLE_URL" ] && [ -n "$COMPATIBLE_MODEL" ]; then
    echo "Compatible OpenCode provider configuration detected ($COMPATIBLE_MODEL)."
    python3 /usr/local/bin/update_settings.py "$DATA_DIR" "$COMPATIBLE_MODEL"
fi

# Configure GitHub CLI authentication
if [ -n "$GITHUB_PAT" ]; then
    export GH_TOKEN="$GITHUB_PAT"
    echo "GitHub authentication configured from GITHUB_PAT."
fi

# Start application
echo "Starting application on port $PORT..."
exec node apps/server/dist/index.js
