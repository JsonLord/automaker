#!/bin/sh
# entrypoint.sh - Initialize environment and start Automaker for Hugging Face

echo "Starting Automaker entrypoint script..."

# Ensure DATA_DIR exists
mkdir -p "$DATA_DIR"

# Configure OpenCode authentication
if [ -n "$OPENCODE_API_KEY" ] || [ -n "$JULES_API_KEY" ]; then
    echo "Configuring OpenCode authentication..."
    mkdir -p "$HOME/.local/share/opencode"

    # Start with a base auth object
    AUTH_JSON="{}"

    # Add opencode provider if OPENCODE_API_KEY is present
    if [ -n "$OPENCODE_API_KEY" ]; then
        AUTH_JSON=$(echo "$AUTH_JSON" | jq ". + {\"api_key\": \"$OPENCODE_API_KEY\", \"opencode\": {\"type\": \"api_key\", \"key\": \"$OPENCODE_API_KEY\"}}")
    fi

    # Add helmholtz provider if JULES_API_KEY is present
    if [ -n "$JULES_API_KEY" ]; then
        AUTH_JSON=$(echo "$AUTH_JSON" | jq ". + {\"helmholtz\": {\"type\": \"api_key\", \"key\": \"$JULES_API_KEY\", \"baseURL\": \"https://api.helmholtz-blablador.fz-juelich.de/v1\"}}")

        # Also set helmholtz/alias-code as default model using update_settings.py
        if [ -f "/usr/local/bin/update_settings.py" ]; then
            python3 /usr/local/bin/update_settings.py "$DATA_DIR" "helmholtz/alias-code"
        fi

        # Export as JULES_TOKEN for Jules CLI compatibility
        export JULES_TOKEN="$JULES_API_KEY"
        echo "Jules CLI authentication configured."
    fi

    echo "$AUTH_JSON" > "$HOME/.local/share/opencode/auth.json"
    echo "OpenCode authentication configured."
else
    echo "Neither OPENCODE_API_KEY nor JULES_API_KEY found."
fi

# Configure GitHub CLI authentication
if [ -n "$GITHUB_API_KEY" ]; then
    echo "GITHUB_API_KEY detected, configuring GitHub CLI..."
    export GH_TOKEN="$GITHUB_API_KEY"
    echo "GitHub CLI token exported."
else
    echo "GITHUB_API_KEY not found."
fi

# Log environment info for debugging
echo "Environment Info:"
echo "  UID: $(id -u)"
echo "  HOME: $HOME"
echo "  PWD: $(pwd)"
echo "  PORT: $PORT"
echo "  DATA_DIR: $DATA_DIR"

# Start the application
echo "Starting application on port $PORT..."
exec node apps/server/dist/index.js
