# syntax=docker/dockerfile:1
# Argus modes run inside the existing Node process; no per-mode daemon or GPU.
# REA binary/live-probe workers, PDF/OCR ingestion and arbitrary scientific workers
# are optional external capabilities and are not installed into the base image.
# See docs/architecture/ARGUS-MULTI-MODE.md before configuring a worker/provider.
# Automaker Multi-Stage Dockerfile for Hugging Face Spaces
# Combines built UI and Server into a single production image on port 7860

# =============================================================================
# BUILD STAGE
# =============================================================================
FROM node:22-slim AS builder
ARG BUILD_GIT_SHA
ARG BUILD_TIMESTAMP
ENV BUILD_GIT_SHA=${BUILD_GIT_SHA} BUILD_TIMESTAMP=${BUILD_TIMESTAMP}

# Install build dependencies for native modules (node-pty)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ git curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Build exactly the checked-out source supplied as the Docker build context.
COPY . .

# Generate provenance file
RUN sh scripts/generate-provenance.sh

# Keep the verified install/build/browser sequence in one layer. This also avoids
# duplicating the full development dependency tree on VFS-based qualification hosts.
ENV VITE_SKIP_ELECTRON=true
ENV VITE_SERVER_URL=
RUN --mount=type=secret,id=proxy_ca,mode=0444 \
    if [ -f /run/secrets/proxy_ca ]; then \
      export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca PIP_CERT=/run/secrets/proxy_ca \
        SSL_CERT_FILE=/run/secrets/proxy_ca CURL_CA_BUNDLE=/run/secrets/proxy_ca; \
    fi; \
    npm ci --ignore-scripts && \
    npm run build:packages && \
    npm run build --workspace=apps/ui && \
    npm run build --workspace=apps/server && \
    npm rebuild node-pty --workspace=apps/server && \
    PLAYWRIGHT_BROWSERS_PATH=/opt/playwright ./node_modules/.bin/playwright install chromium && \
    npm cache clean --force

FROM builder AS runtime-dependencies
RUN --mount=type=secret,id=proxy_ca,mode=0444 \
    if [ -f /run/secrets/proxy_ca ]; then \
      export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca PIP_CERT=/run/secrets/proxy_ca \
        SSL_CERT_FILE=/run/secrets/proxy_ca CURL_CA_BUNDLE=/run/secrets/proxy_ca; \
    fi; \
    npm prune --omit=dev --ignore-scripts --no-audit --no-fund && \
    npm rebuild node-pty --workspace=apps/server

# Collect artifacts before installing them into the OS image. One final COPY avoids
# repeatedly snapshotting an entire runtime filesystem on VFS-based builders.
FROM scratch AS runtime-assets
COPY --from=builder /app/package*.json /app/
COPY --from=builder /app/vitest.config.ts /app/
COPY --from=builder /app/libs /app/libs
COPY --from=runtime-dependencies /app/apps/server /app/apps/server
COPY --from=builder /app/apps/ui/dist /app/apps/ui/dist
COPY --from=builder /app/scripts /app/scripts
COPY --chmod=0755 entrypoint.sh /app/entrypoint.sh
COPY --chmod=0755 update_settings.py /usr/local/bin/update_settings.py
COPY --from=runtime-dependencies /app/node_modules /app/node_modules
COPY --from=builder /opt/playwright /opt/playwright

FROM node:22-slim
ARG BUILD_GIT_SHA
ARG BUILD_TIMESTAMP
ARG OPENCODE_VERSION=1.18.35
ARG ARGUS_SOURCE_REVISION=746f76b7a74a1217507c9ee348eecd3b782f7c92
ARG ARGUS_PACKAGE_VERSION=0.1.1
ENV BUILD_GIT_SHA=${BUILD_GIT_SHA} BUILD_TIMESTAMP=${BUILD_TIMESTAMP}
ENV OPENCODE_VERSION=${OPENCODE_VERSION} ARGUS_SOURCE_REVISION=${ARGUS_SOURCE_REVISION} ARGUS_PACKAGE_VERSION=${ARGUS_PACKAGE_VERSION}
WORKDIR /app
# Optional public CA bundle is mounted for this build step only, never copied.
RUN --mount=type=secret,id=proxy_ca,mode=0444 \
    if [ -f /run/secrets/proxy_ca ]; then \
      export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca PIP_CERT=/run/secrets/proxy_ca \
        SSL_CERT_FILE=/run/secrets/proxy_ca CURL_CA_BUNDLE=/run/secrets/proxy_ca; \
    fi; \
    apt-get update && apt-get install -y --no-install-recommends \
    gh git curl bash ca-certificates openssh-client jq python3 python3-venv python3-pip wget lsof procps \
    # Playwright/Chromium dependencies
    libglib2.0-0 libnss3 libnspr4 libdbus-1-3 libatk1.0-0 libatk-bridge2.0-0 \
    libcups2 libdrm2 libxkbcommon0 libatspi2.0-0 libxcomposite1 libxdamage1 \
    libxfixes3 libxrandr2 libgbm1 libasound2 libcairo2 \
    libx11-6 libx11-xcb1 libxcb1 libxext6 libxrender1 libxss1 libxtst6 \
    libxshmfence1 libgtk-3-0 libexpat1 libfontconfig1 fonts-liberation \
    xdg-utils libpango-1.0-0 libpangocairo-1.0-0 libpangoft2-1.0-0 libu2f-udev libvulkan1 \
    && rm -rf /var/lib/apt/lists/* && \
    corepack enable && (corepack prepare pnpm@latest --activate || npm install -g pnpm --force) && \
    mkdir -p /home/node/.local/bin && \
    npm install --prefix /home/node/.local/opencode --ignore-scripts --no-audit --no-fund \
      "opencode-linux-$(node -p process.arch)@${OPENCODE_VERSION}" && \
    ln -s "/home/node/.local/opencode/node_modules/opencode-linux-$(node -p process.arch)/bin/opencode" /home/node/.local/bin/opencode && \
    /home/node/.local/bin/opencode --version | grep -Fx "${OPENCODE_VERSION}" && \
    python3 -m venv /opt/argus && \
    /opt/argus/bin/pip install --no-cache-dir --upgrade pip && \
    /opt/argus/bin/pip install --no-cache-dir \
      "argus-skill @ https://github.com/microsoft/ArgusAgent/archive/${ARGUS_SOURCE_REVISION}.zip" && \
    /opt/argus/bin/argus --version | grep -F "${ARGUS_PACKAGE_VERSION}" && \
    mkdir -p /app/data && \
    chown -R node:node /home/node /opt/argus /app && \
    npm cache clean --force
COPY --from=runtime-assets --chown=node:node / /
USER node
ENV HOME=/home/node
ENV PATH="/opt/argus/bin:/home/node/.local/bin:/home/node/.opencode/bin:${PATH}"
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright
ENV PORT=7860 DATA_DIR=/app/data ARGUS_SKILL_HOME=/app/data/argus
ENV NODE_ENV=production AUTOMAKER_AUTO_LOGIN=false AUTOMAKER_DISABLE_AUTH=false AUTOMAKER_HIDE_API_KEY=true
ENV ALLOWED_ROOT_DIRECTORY=/app/data/projects
EXPOSE 7860
ENTRYPOINT ["./entrypoint.sh"]
