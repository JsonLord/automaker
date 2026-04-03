#!/bin/sh
# entrypoint.sh - Initialize environment and start Automaker for Hugging Face

echo "Starting Automaker entrypoint script..."

# Ensure DATA_DIR exists
mkdir -p "$DATA_DIR"

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
        python3 /usr/local/bin/update_settings.py "$DATA_DIR" "helmholtz/alias-code"
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
fi

# Start the application
echo "Starting application on port $PORT..."
exec node apps/server/dist/index.js
