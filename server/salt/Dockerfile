# WalrusForge salt service — dependency-free (Node built-ins only). Context: server/salt
FROM node:18-alpine
WORKDIR /app
COPY package.json index.mjs lib.mjs ./
ENV PORT=8789
EXPOSE 8789
USER node
HEALTHCHECK --interval=30s --timeout=4s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:8789/health || exit 1
CMD ["node", "index.mjs"]
