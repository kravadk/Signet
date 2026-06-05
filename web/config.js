// Deploy-time config for the Signet web SPA. Loaded (plain <script>) before
// app.js; shared.js reads window.__WF_CONFIG. PRECEDENCE: defaults → __WF_CONFIG →
// ?query → localStorage.
//
// EMPTY = standalone mode (the default for a plain Vercel/static deploy): the app
// reads Sui RPC + Walrus directly, the LLM uses BYOK, the wallet pays gas, and
// share links use the built-in viewer.html. Everything still works — the optional
// backends are accelerators, never required.
//
// To wire the optional services (sponsor / portal / llm-proxy / zkLogin), set the
// URLs below, e.g.:
//   window.__WF_CONFIG = {
//     sponsorUrl:  'https://sponsor.example.com/sponsor',
//     portalUrl:   'https://signet.example.com',
//     llmProxyUrl: 'https://llm.example.com/llm',
//     zkSaltUrl:   'https://salt.example.com/salt',
//     zkProverUrl: 'https://prover.example.com/v1',
//     zkGoogleClientId: '<google-oauth-client-id>',
//   };
//
// NOTE: `npm run gen:web-config` overwrites this file with localhost URLs for the
// local Docker/dev stack — do NOT commit that output; production stays empty.
window.__WF_CONFIG = {
  sponsorUrl: 'https://signet-sponsor.onrender.com/sponsor',
  portalUrl: 'https://signet-portal.onrender.com',
  llmProxyUrl: 'https://signet-llm-proxy.onrender.com/llm',
  zkSaltUrl: 'https://signet-salt.onrender.com/salt',
  zkProverUrl: '',
  zkGoogleClientId: '893414924200-4j28fh1986ru14enu1nm1h48r2ldq1k5.apps.googleusercontent.com',
};
