# Signet importer — imports the app/ snapshot + Walrus libs via tsx, so the build
# context must be the REPO ROOT:  docker build -f server/importer/Dockerfile .
FROM node:20-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /srv

# app workspace (provides src/lib/snapshot.ts + walrus.ts and their deps)
COPY app/package.json app/package-lock.json ./app/
RUN cd app && (npm ci --omit=dev || npm install --omit=dev)
COPY app ./app

# importer service (tsx only)
COPY server/importer/package.json ./server/importer/
RUN cd server/importer && npm install
COPY server/importer ./server/importer

WORKDIR /srv/server/importer
ENV PORT=8795 FORGE_NETWORK=testnet
EXPOSE 8795
HEALTHCHECK --interval=30s --timeout=4s --start-period=8s --retries=3 \
  CMD wget -qO- http://localhost:8795/health || exit 1
CMD ["npm", "start"]
