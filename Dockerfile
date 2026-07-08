# Automaker Multi-Stage Dockerfile for Hugging Face Spaces
# Combines built UI and Server into a single production image on port 7860

# =============================================================================
# BUILD STAGE
# =============================================================================
FROM node:22-slim AS builder

# Install build dependencies for native modules (node-pty)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ git curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Clone the repository
ARG BRANCH_NAME=add-jules-cli-provider-5092951037381118710
RUN git clone https://github.com/JsonLord/automaker.git . && \
    git checkout $BRANCH_NAME

# Copy local changes to include iterative fixes
COPY . .

# Install all dependencies using the root package-lock.json
RUN npm ci --ignore-scripts

# Build shared libraries
RUN npm run build:packages

# Build UI
ENV VITE_SKIP_ELECTRON=true
ENV VITE_SERVER_URL=
RUN npm run build --workspace=apps/ui

# Build Server
RUN npm run build --workspace=apps/server && \
    npm rebuild node-pty --workspace=apps/server

# =============================================================================
# FINAL PRODUCTION STAGE
# =============================================================================
FROM node:22-slim

WORKDIR /app

# Install git, curl, bash, python3 and tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl bash ca-certificates openssh-client jq python3 wget \
    # Playwright/Chromium dependencies
    libglib2.0-0 libnss3 libnspr4 libdbus-1-3 libatk1.0-0 libatk-bridge2.0-0 \
    libcups2 libdrm2 libxkbcommon0 libatspi2.0-0 libxcomposite1 libxdamage1 \
    libxfixes3 libxrandr2 libgbm1 libasound2 libcairo2 \
    libx11-6 libx11-xcb1 libxcb1 libxext6 libxrender1 libxss1 libxtst6 \
    libxshmfence1 libgtk-3-0 libexpat1 libfontconfig1 fonts-liberation \
    xdg-utils libpangocairo-1.0-0 libpangoft2-1.0-0 libu2f-udev libvulkan1 \
    && rm -rf /var/lib/apt/lists/*

# node:slim image already has a 'node' user with UID 1000
# Ensure node user can write to /app and has a proper home
RUN mkdir -p /home/node/.local/bin && \
    chown -R node:node /home/node && \
    chown -R node:node /app

USER node
ENV HOME=/home/node
ENV PATH="/home/node/.local/bin:/home/node/.opencode/bin:${PATH}"

# Install OpenCode CLI
RUN curl -fsSL https://opencode.ai/install | bash

# Install GitHub CLI (gh)
USER root
RUN mkdir -p -m 755 /etc/apt/keyrings && \
    wget -qO- https://cli.github.com/packages/githubcli-archive-keyring.gpg | tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null && \
    chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null && \
    apt-get update && \
    apt-get install -y gh && \
    rm -rf /var/lib/apt/lists/*
USER node

# Copy built artifacts and dependencies from builder
COPY --from=builder --chown=node:node /app/package*.json ./
COPY --from=builder --chown=node:node /app/vitest.config.ts ./
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/libs ./libs
COPY --from=builder --chown=node:node /app/apps/server ./apps/server
COPY --from=builder --chown=node:node /app/apps/ui/dist ./apps/ui/dist

# Install Playwright Chromium
RUN ./node_modules/.bin/playwright install chromium

# Create data directory
RUN mkdir -p /app/data && chown node:node /app/data

# Environment variables
ENV PORT=7860
ENV DATA_DIR=/app/data
ENV NODE_ENV=production
ENV AUTOMAKER_AUTO_LOGIN=true

# Copy scripts
COPY --chown=node:node entrypoint.sh ./entrypoint.sh
COPY --chown=node:node update_settings.py /usr/local/bin/update_settings.py

USER root
RUN chmod +x ./entrypoint.sh /usr/local/bin/update_settings.py
USER node

# Expose port
EXPOSE 7860

# Use entrypoint
ENTRYPOINT ["./entrypoint.sh"]
