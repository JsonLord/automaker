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

# Set environment variables for Hugging Face
ENV PORT=7860
ENV DATA_DIR=/app/data
ENV NODE_ENV=production

# Create data directory
RUN mkdir -p /app/data && chmod 777 /app/data

# Expose the mandatory port
EXPOSE 7860

# Start the server
CMD ["node", "apps/server/dist/index.js"]
