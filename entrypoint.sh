#!/bin/sh
# entrypoint.sh - Initialize environment and start Automaker

echo "Starting Automaker entrypoint script..."

# Configure OpenCode authentication if token is provided
if [ -n "$OPENCODE_AUTH_TOKEN" ]; then
    echo "OPENCODE_AUTH_TOKEN detected, configuring authentication..."
    mkdir -p "$HOME/.local/share/opencode"
    # Create auth.json in the format that OpenCode Zen expects for API keys
    echo "{\"opencode\": {\"type\": \"api\", \"key\": \"$OPENCODE_AUTH_TOKEN\"}}" > "$HOME/.local/share/opencode/auth.json"
    echo "OpenCode authentication configured."
else
    echo "OPENCODE_AUTH_TOKEN not set, skipping OpenCode auto-login."
fi

# Configure GitHub CLI authentication if token is provided
if [ -n "$GITHUB_API_TOKEN" ]; then
    echo "GITHUB_API_TOKEN detected, configuring GitHub CLI..."
    export GH_TOKEN="$GITHUB_API_TOKEN"
    echo "GitHub CLI token exported."
else
    echo "GITHUB_API_TOKEN not set, skipping GitHub CLI auto-login."
fi

# Set a fixed API key for Automaker if requested, otherwise it generates a random one
if [ -n "$AUTOMAKER_API_KEY" ]; then
    echo "AUTOMAKER_API_KEY detected, using provided key."
else
    echo "AUTOMAKER_API_KEY not set, a random key will be generated on startup (see logs)."
fi

# Start the application
echo "Starting application..."
exec node apps/server/dist/index.js
