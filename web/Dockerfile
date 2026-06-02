# WalrusForge static SPA. Generates config.js from WF_* env at start, then serves.
# BUILD CONTEXT = web/
FROM node:18-alpine
RUN npm i -g serve@14
WORKDIR /site
COPY . /site
RUN chmod +x /site/docker-entrypoint.sh
ENV PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=4s --start-period=4s --retries=3 \
  CMD wget -qO- http://localhost:8080/ || exit 1
ENTRYPOINT ["/site/docker-entrypoint.sh"]
