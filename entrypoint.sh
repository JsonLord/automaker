#!/bin/sh
# entrypoint.sh - Initialize environment and start Automaker for Hugging Face

echo "Starting Automaker entrypoint script..."

# Ensure directories exist
mkdir -p "$DATA_DIR"
mkdir -p "$HOME/.local/share/opencode"
mkdir -p "$HOME/.config/gh"

# Resolve tokens
HF_DETECTED_TOKEN=$(env | grep "^hf_" | head -n 1 | cut -d'=' -f2)

OC_KEY="${OPENCODE_API_KEY:-${OPENCODE_TOKEN:-${HF_TOKEN:-${HF_DETECTED_TOKEN}}}}"
J_KEY="${JULES_API_KEY:-${JULES_TOKEN:-${BLABLADOR_API_KEY:-${HF_DETECTED_TOKEN}}}}"
GH_KEY="${GITHUB_API_KEY:-${GH_TOKEN:-${HF_DETECTED_TOKEN}}}"

# Configure OpenCode authentication
if [ -n "$OC_KEY" ] || [ -n "$J_KEY" ] || [ -n "$OPENAI_API_KEY" ]; then
    echo "Configuring OpenCode authentication..."
    
    # Use OpenAI API Key as primary if available, otherwise JULES or OpenCode
    PRIMARY_KEY="${OPENAI_API_KEY:-${OPENCODE_API_KEY:-${J_KEY:-$OC_KEY}}}"
    
    # Construct auth.json using jq
    # We map OPENAI_API_KEY and OPENAI_BASE_URL to the 'openai' provider in OpenCode
    jq -n \
        --arg primary "$PRIMARY_KEY" \
        --arg oc "$OC_KEY" \
        --arg jk "$J_KEY" \
        --arg oak "${OPENAI_API_KEY:-}" \
        --arg oab "${OPENAI_BASE_URL:-}" \
        '{
            api_key: $primary,
            opencode: (if $oc != "" then {type: "api", key: $oc, api_key: $oc} else null end),
            anthropic: (if $oc != "" then {type: "api", key: $oc, api_key: $oc} else null end),
            openai: (if $oak != "" then {type: "api", key: $oak, api_key: $oak, baseURL: (if $oab != "" then $oab else null end)} else (if $oc != "" then {type: "api", key: $oc, api_key: $oc} else null end) end),
            google: (if $oc != "" then {type: "api", key: $oc, api_key: $oc} else null end),
            helmholtz: (if $jk != "" then {type: "api", key: $jk, api_key: $jk, baseURL: "https://api.helmholtz-blablador.fz-juelich.de/v1"} else null end),
            copilot: (if $jk != "" then {type: "api", key: $jk, api_key: $jk} else null end),
            "github-copilot": (if $jk != "" then {type: "api", key: $jk, api_key: $jk} else null end)
        } | with_entries(select(.value != null))' > "$HOME/.local/share/opencode/auth.json"
    
    chmod 600 "$HOME/.local/share/opencode/auth.json"
    
    # Export env vars for other potential consumers
    [ -n "$OC_KEY" ] && export ANTHROPIC_API_KEY="$OC_KEY"
    [ -z "$OPENAI_API_KEY" ] && [ -n "$OC_KEY" ] && export OPENAI_API_KEY="$OC_KEY"
    [ -n "$J_KEY" ] && export JULES_TOKEN="$J_KEY"
    
    # Update settings
    # If OPENAI_MODEL is set, we use it as the default model via the 'openai' provider in OpenCode
    if [ -n "$OPENAI_MODEL" ] && [ -f "/usr/local/bin/update_settings.py" ]; then
        echo "Setting default model to openai/$OPENAI_MODEL"
        python3 /usr/local/bin/update_settings.py "$DATA_DIR" "openai/$OPENAI_MODEL"
    elif [ -n "$J_KEY" ] && [ -f "/usr/local/bin/update_settings.py" ]; then
        echo "Setting default model to helmholtz/alias-code"
        python3 /usr/local/bin/update_settings.py "$DATA_DIR" "helmholtz/alias-code"
    fi
    echo "OpenCode config created."
fi

# Configure GitHub CLI authentication
if [ -n "$GH_KEY" ]; then
    echo "Configuring GitHub CLI authentication..."
    export GH_TOKEN="$GH_KEY"
    # Create hosts.yml manually
    mkdir -p "$HOME/.config/gh"
    printf "github.com:\n    user: automaker\n    oauth_token: %s\n    git_protocol: https\n" "$GH_KEY" > "$HOME/.config/gh/hosts.yml"
    chmod 600 "$HOME/.config/gh/hosts.yml"
    echo "GitHub hosts.yml created."
fi

# Start application
echo "Starting application on port $PORT..."
exec node apps/server/dist/index.js
