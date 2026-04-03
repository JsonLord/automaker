# Automaker Multi-Stage Dockerfile for Hugging Face Spaces
# Combines built UI and Server into a single production image on port 7860

# =============================================================================
# BASE STAGE - Common setup for all builds
# =============================================================================
FROM node:22-slim AS base

# Install build dependencies for native modules (node-pty)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy root package files
COPY package*.json ./

# Copy all libs package.json files
COPY libs/types/package*.json ./libs/types/
COPY libs/utils/package*.json ./libs/utils/
COPY libs/prompts/package*.json ./libs/prompts/
COPY libs/platform/package*.json ./libs/platform/
COPY libs/spec-parser/package*.json ./libs/spec-parser/
COPY libs/model-resolver/package*.json ./libs/model-resolver/
COPY libs/dependency-resolver/package*.json ./libs/dependency-resolver/
COPY libs/git-utils/package*.json ./libs/git-utils/

# Copy scripts (needed by npm workspace)
COPY scripts ./scripts

# =============================================================================
# SERVER BUILD STAGE
# =============================================================================
FROM base AS server-builder

# Copy server-specific package.json
COPY apps/server/package*.json ./apps/server/

# Install dependencies
RUN npm ci --ignore-scripts && npm rebuild node-pty

# Copy all source files
COPY libs ./libs
COPY apps/server ./apps/server

# Build packages and server
RUN npm run build:packages && npm run build --workspace=apps/server

# =============================================================================
# UI BUILD STAGE
# =============================================================================
FROM base AS ui-builder

# Copy UI-specific package.json
COPY apps/ui/package*.json ./apps/ui/

# Install dependencies
RUN npm ci --ignore-scripts

# Copy all source files
COPY libs ./libs
COPY apps/ui ./apps/ui

# Build packages and UI
# For HF, we use relative URLs
ENV VITE_SKIP_ELECTRON=true
ENV VITE_SERVER_URL=
RUN npm run build:packages && npm run build --workspace=apps/ui

# =============================================================================
# FINAL PRODUCTION STAGE
# =============================================================================
FROM node:22-slim

WORKDIR /app

# Install git, curl, bash, and GitHub CLI
RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl bash ca-certificates openssh-client jq \
    # Playwright/Chromium dependencies
    libglib2.0-0 libnss3 libnspr4 libdbus-1-3 libatk1.0-0 libatk-bridge2.0-0 \
    libcups2 libdrm2 libxkbcommon0 libatspi2.0-0 libxcomposite1 libxdamage1 \
    libxfixes3 libxrandr2 libgbm1 libasound2 libpango-1.0-0 libcairo2 \
    libx11-6 libx11-xcb1 libxcb1 libxext6 libxrender1 libxss1 libxtst6 \
    libxshmfence1 libgtk-3-0 libexpat1 libfontconfig1 fonts-liberation \
    xdg-utils libpangocairo-1.0-0 libpangoft2-1.0-0 libu2f-udev libvulkan1 \
    && GH_VERSION="2.63.2" \
    && ARCH=$(uname -m) \
    && case "$ARCH" in \
        x86_64) GH_ARCH="amd64" ;; \
        aarch64|arm64) GH_ARCH="arm64" ;; \
        *) echo "Unsupported architecture: $ARCH" && exit 1 ;; \
    esac \
    && curl -L "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${GH_ARCH}.tar.gz" -o gh.tar.gz \
    && tar -xzf gh.tar.gz \
    && mv gh_${GH_VERSION}_linux_${GH_ARCH}/bin/gh /usr/local/bin/gh \
    && rm -rf gh.tar.gz gh_${GH_VERSION}_linux_${GH_ARCH} \
    && rm -rf /var/lib/apt/lists/*

# Install Claude CLI globally
RUN npm install -g @anthropic-ai/claude-code

# Create non-root user
RUN useradd -m -d /home/node -s /bin/bash automaker && \
    mkdir -p /home/node/.local/bin && \
    chown -R automaker:automaker /home/node

# Install Cursor CLI as the automaker user
USER automaker
ENV HOME=/home/node
RUN curl https://cursor.com/install -fsS | bash

# Install OpenCode CLI
RUN curl -fsSL https://opencode.ai/install | bash

USER root

# Add PATH
ENV PATH="/home/node/.local/bin:${PATH}"

# Copy built artifacts
COPY --from=server-builder /app/node_modules ./node_modules
COPY --from=server-builder /app/libs ./libs
COPY --from=server-builder /app/apps/server/dist ./apps/server/dist
COPY --from=server-builder /app/apps/server/package*.json ./apps/server/
COPY --from=ui-builder /app/apps/ui/dist ./apps/ui/dist

# Install Playwright Chromium
RUN ./node_modules/.bin/playwright install chromium

# Create data directory
RUN mkdir -p /app/data && chown automaker:automaker /app/data

# Environment variables
ENV PORT=7860
ENV DATA_DIR=/app/data
ENV NODE_ENV=production

# Copy scripts
COPY entrypoint.sh ./entrypoint.sh
COPY update_settings.py /usr/local/bin/update_settings.py
RUN chmod +x entrypoint.sh /usr/local/bin/update_settings.py

# Expose port
EXPOSE 7860

# Use entrypoint
ENTRYPOINT ["./entrypoint.sh"]
