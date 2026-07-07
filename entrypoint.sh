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
if [ -n "$OC_KEY" ] || [ -n "$J_KEY" ]; then
    echo "Configuring OpenCode authentication..."
    
    PRIMARY_KEY="${J_KEY:-$OC_KEY}"
    
    # Construct auth.json without nested logic errors
    # We use jq to build the object from scratch
    jq -n \
        --arg primary "$PRIMARY_KEY" \
        --arg oc "$OC_KEY" \
        --arg jk "$J_KEY" \
        '{
            api_key: $primary,
            opencode: (if $oc != "" then {type: "api", key: $oc, api_key: $oc} else null end),
            anthropic: (if $oc != "" then {type: "api", key: $oc, api_key: $oc} else null end),
            openai: (if $oc != "" then {type: "api", key: $oc, api_key: $oc} else null end),
            google: (if $oc != "" then {type: "api", key: $oc, api_key: $oc} else null end),
            helmholtz: (if $jk != "" then {type: "api", key: $jk, api_key: $jk, baseURL: "https://api.helmholtz-blablador.fz-juelich.de/v1"} else null end),
            copilot: (if $jk != "" then {type: "api", key: $jk, api_key: $jk} else null end),
            "github-copilot": (if $jk != "" then {type: "api", key: $jk, api_key: $jk} else null end)
        } | with_entries(select(.value != null))' > "$HOME/.local/share/opencode/auth.json"
    
    chmod 600 "$HOME/.local/share/opencode/auth.json"
    
    # Export env vars
    [ -n "$OC_KEY" ] && export ANTHROPIC_API_KEY="$OC_KEY"
    [ -n "$OC_KEY" ] && export OPENAI_API_KEY="$OC_KEY"
    [ -n "$J_KEY" ] && export JULES_TOKEN="$J_KEY"
    
    # Update settings
    if [ -n "$J_KEY" ] && [ -f "/usr/local/bin/update_settings.py" ]; then
        python3 /usr/local/bin/update_settings.py "$DATA_DIR" "helmholtz/alias-code"
    fi
    echo "OpenCode config created."
fi

# Configure GitHub CLI authentication
if [ -n "$GH_KEY" ]; then
    echo "Configuring GitHub CLI authentication..."
    export GH_TOKEN="$GH_KEY"
    # Create hosts.yml manually since 'gh auth login' flags might vary by version
    mkdir -p "$HOME/.config/gh"
    printf "github.com:\n    user: automaker\n    oauth_token: %s\n    git_protocol: https\n" "$GH_KEY" > "$HOME/.config/gh/hosts.yml"
    chmod 600 "$HOME/.config/gh/hosts.yml"
    echo "GitHub hosts.yml created."
fi

# Start application
echo "Starting application on port $PORT..."
exec node apps/server/dist/index.js
