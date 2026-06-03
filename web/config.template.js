// Template for deploy-time config injection (reference for envsubst-style hosts).
// The docker entrypoint and scripts/gen-web-config.mjs generate web/config.js with
// these keys from WF_* env. Leave a value empty to fall back to the settings modal.
window.__WF_CONFIG = {
  sponsorUrl: "${WF_SPONSOR_URL}",
  portalUrl: "${WF_PORTAL_URL}",
  llmProxyUrl: "${WF_LLM_PROXY_URL}",
  zkGoogleClientId: "${WF_ZK_GOOGLE_CLIENT_ID}",
  zkSaltUrl: "${WF_ZK_SALT_URL}",
  zkProverUrl: "${WF_ZK_PROVER_URL}"
};
