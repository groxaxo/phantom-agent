FROM node:22-bookworm-slim

# System deps for Chromium
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    chromium-sandbox \
    fonts-liberation \
    fonts-noto-color-emoji \
    libgbm1 \
    libnss3 \
    libxss1 \
    libasound2 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libdrm2 \
    libx11-xcb1 \
    xdg-utils \
    dumb-init \
    procps \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev 2>/dev/null || npm install --omit=dev

# Copy source and build
COPY tsconfig.json ./
COPY scripts/ ./scripts/
COPY src/ ./src/
RUN npm run build

# Point to Chromium
ENV CHROME_PATH=/usr/bin/chromium
ENV HEADLESS=true
ENV LOG_LEVEL=info

ENTRYPOINT ["dumb-init", "--", "node", "dist/phantom-agent.mjs"]
