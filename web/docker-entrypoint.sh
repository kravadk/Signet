#!/bin/sh
# Generate config.js from WF_* env at container start so the static SPA auto-wires
# to the deployed services (no manual settings entry). Then serve the static site.
set -e
cat > /site/config.js <<EOF
window.__WF_CONFIG = {
  sponsorUrl: "${WF_SPONSOR_URL:-}",
  portalUrl: "${WF_PORTAL_URL:-}",
  llmProxyUrl: "${WF_LLM_PROXY_URL:-}",
  zkGoogleClientId: "${WF_ZK_GOOGLE_CLIENT_ID:-}",
  zkSaltUrl: "${WF_ZK_SALT_URL:-}",
  zkProverUrl: "${WF_ZK_PROVER_URL:-}"
};
EOF
echo "wrote /site/config.js"
exec serve /site -l 8080
