# Signet portal — needs @mysten/sui + deployments.json. BUILD CONTEXT = repo root.
FROM node:18-alpine
WORKDIR /app
COPY server/portal/package.json server/portal/package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY server/portal/index.mjs server/portal/lib.mjs ./
# portal reads ../../move/signet/deployments.json relative to /app → /move/...
COPY move/signet/deployments.json /move/signet/deployments.json
ENV PORT=8790
EXPOSE 8790
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=8s --retries=3 \
  CMD wget -qO- http://localhost:8790/health || exit 1
CMD ["node", "index.mjs"]
