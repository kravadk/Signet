# Signet sponsor service — needs @mysten/sui. Context: server/sponsor
FROM node:18-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY index.mjs lib.mjs ./
ENV PORT=8788
EXPOSE 8788
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=8s --retries=3 \
  CMD wget -qO- http://localhost:8788/health || exit 1
CMD ["node", "index.mjs"]
