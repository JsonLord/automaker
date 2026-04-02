# Use official Node.js image
FROM node:22-slim

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ git curl ca-certificates \
    libglib2.0-0 libnss3 libnspr4 libdbus-1-3 libatk1.0-0 libatk-bridge2.0-0 \
    libcups2 libdrm2 libxkbcommon0 libatspi2.0-0 libxcomposite1 libxdamage1 \
    libxfixes3 libxrandr2 libgbm1 libasound2 libpango-1.0-0 libcairo2 \
    libx11-6 libx11-xcb1 libxcb1 libxext6 libxrender1 libxss1 libxtst6 \
    libxshmfence1 libgtk-3-0 libexpat1 libfontconfig1 fonts-liberation \
    xdg-utils libpangocairo-1.0-0 libpangoft2-1.0-0 libu2f-udev libvulkan1 \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Clone the repository
RUN git clone https://github.com/JsonLord/automaker.git .

# Copy local changes to ensure latest code with my modifications is used
COPY . .

# Install dependencies
RUN npm install

# Build shared packages
RUN npm run build:packages

# Build the UI
RUN npm run build --workspace=apps/ui

# Build the Server
RUN npm run build --workspace=apps/server

# Install Playwright Chromium
RUN npx playwright install chromium

# Install OpenCode CLI
RUN npm install -g opencode-ai

# Install GitHub CLI
RUN (type -p wget >/dev/null || (apt-get update && apt-get install -y wget)) \
    && mkdir -p -m 755 /etc/apt/keyrings \
    && wget -qO- https://cli.github.com/packages/githubcli-archive-keyring.gpg | tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update \
    && apt-get install gh -y

# Set environment variables for Hugging Face
ENV PORT=7860
ENV DATA_DIR=/app/data
ENV NODE_ENV=production
ENV HOME=/app

# Create data directory and config directories
RUN mkdir -p /app/data /app/.local/share/opencode /app/.config/opencode /app/.cache/opencode && chmod -R 777 /app

# Expose the mandatory port
EXPOSE 7860

# Copy entrypoint script
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Start the server via entrypoint
ENTRYPOINT ["/app/entrypoint.sh"]
