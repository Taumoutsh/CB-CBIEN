# Image Playwright officielle : Chromium et ses dépendances déjà installés, même version que le paquet npm
FROM mcr.microsoft.com/playwright:v1.63.0-noble

ENV TZ=Europe/Paris \
    NODE_ENV=production \
    DATA_DIR=/data

# curl : appels à l'API Telegram
RUN apt-get update && apt-get install -y --no-install-recommends curl tzdata \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY *.js ./

# Match programmé, conservé entre deux redémarrages
VOLUME /data

CMD ["node", "bot.js"]
