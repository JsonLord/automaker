#!/bin/sh
# entrypoint.sh - Initialize environment and start Automaker

echo "Starting Automaker entrypoint script..."

# Configure OpenCode & Helmholtz authentication
if [ -n "$OPENCODE_AUTH_TOKEN" ] || [ -n "$BLABLADOR_API_KEY" ]; then
    echo "Authentication tokens detected, configuring providers..."
    mkdir -p "$HOME/.local/share/opencode"

    # Initialize base JSON
    AUTH_JSON="{}"

    if [ -n "$OPENCODE_AUTH_TOKEN" ]; then
        AUTH_JSON=$(echo "$AUTH_JSON" | jq ". + {\"opencode\": {\"type\": \"api\", \"key\": \"$OPENCODE_AUTH_TOKEN\"}}")
    fi

    if [ -n "$BLABLADOR_API_KEY" ]; then
        AUTH_JSON=$(echo "$AUTH_JSON" | jq ". + {\"helmholtz\": {\"type\": \"api\", \"key\": \"$BLABLADOR_API_KEY\", \"baseURL\": \"https://api.helmholtz-blablador.fz-juelich.de/v1\"}}")

        # Configure the app settings to use Helmholtz alias-code model by default
        mkdir -p "$DATA_DIR"
        python3 /home/jules/self_created_tools/update_settings.py "$DATA_DIR" "helmholtz/alias-code"
        echo "Helmholtz provider and default model configured."
    fi

    echo "$AUTH_JSON" > "$HOME/.local/share/opencode/auth.json"
    echo "Provider authentication configured."
else
    echo "No provider tokens set, skipping auto-login."
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
