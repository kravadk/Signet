# Hosted Backend Setup

Use Vercel only for the static frontend (`Root Directory: web`). Do not put private
keys in the Vercel frontend project. The Signet backend runs as separate Docker web
services and exposes public URLs that are later wired into `web/config.js`.

## Services

Create these services from the same GitHub repo. The included `render.yaml` can be
used as a Render Blueprint, or you can create the services manually with the same
Dockerfile paths.

| Service | Dockerfile | Purpose |
| --- | --- | --- |
| `signet-llm-proxy` | `server/llm-proxy/Dockerfile` | Hosted Anthropic calls for Playground |
| `signet-sponsor` | `server/sponsor/Dockerfile` | Sponsored Sui transactions |
| `signet-salt` | `server/salt/Dockerfile` | zkLogin salt service |
| `signet-portal` | `server/portal/Dockerfile` | Portal/status/share links |
| `signet-indexer` | `server/Dockerfile.indexer` | Event cache + gateway API |
| `signet-importer` | `server/importer/Dockerfile` | Keyless GitHub import to Walrus |

## Values To Replace

Replace these placeholder values in the hosting dashboard after the services are
created:

```text
https://YOUR_VERCEL_DOMAIN
https://YOUR_LLM_SERVICE_DOMAIN
https://YOUR_SPONSOR_SERVICE_DOMAIN
https://YOUR_SALT_SERVICE_DOMAIN
https://YOUR_PORTAL_SERVICE_DOMAIN
https://YOUR_INDEXER_SERVICE_DOMAIN
```

## Secrets To Enter

Never commit these values.

### signet-llm-proxy

```env
ANTHROPIC_API_KEY=<new Anthropic key, not one pasted into chat>
ALLOWED_ORIGIN=https://YOUR_VERCEL_DOMAIN
RATE_LIMIT_PER_MIN=20
MAX_TOKENS=8000
```

### signet-sponsor

```env
SPONSOR_PRIVATE_KEY=<new funded testnet suiprivkey1, not one pasted into chat>
SUI_NETWORK=testnet
ALLOWED_PACKAGES=0x79816a1e711ae601afb2ea4ffa5ae83a906c0615ec0831673be8955fa11e4bd5,0x1fac353343e74dbf2757d6ea475127fcafc6dadbcf3737b4116f365eb7fbb61e
ALLOWED_ORIGIN=https://YOUR_VERCEL_DOMAIN
GAS_BUDGET=20000000
RATE_LIMIT_PER_MIN=15
WALLET_RATE_LIMIT_PER_MIN=20
IP_DAILY_LIMIT=250
WALLET_DAILY_LIMIT=100
DAILY_BUDGET_MIST=1000000000
FUNCTION_DAILY_LIMITS=publish_app=25,publish_app_v2=25,publish_remix_v3=25,update_app=50,*=500
SPONSOR_WRITE_MODE=open
ALLOWED_SENDERS=
STAKE_MIN_MIST=0
```

### signet-salt

Generate `SALT_SECRET` once and keep it stable:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

```env
SALT_SECRET=<generated hex>
GOOGLE_CLIENT_ID=<Google OAuth web client id>
ALLOWED_ORIGIN=https://YOUR_VERCEL_DOMAIN
JWKS_URL=https://www.googleapis.com/oauth2/v3/certs
ALLOWED_ISS=https://accounts.google.com,accounts.google.com
```

### signet-portal

```env
PUBLIC_ORIGIN=https://YOUR_PORTAL_SERVICE_DOMAIN
SERVICES=llm-proxy=https://YOUR_LLM_SERVICE_DOMAIN,sponsor=https://YOUR_SPONSOR_SERVICE_DOMAIN,salt=https://YOUR_SALT_SERVICE_DOMAIN,indexer=https://YOUR_INDEXER_SERVICE_DOMAIN/api
```

### signet-indexer

```env
SUI_NETWORK=testnet
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX=600
CSP_REPORT_ONLY=1
ERROR_TRACKING_DSN=
```

### signet-importer

```env
FORGE_NETWORK=testnet
ALLOWED_ORIGIN=https://YOUR_VERCEL_DOMAIN
MAX_FILES=2000
EPOCHS=30
CLONE_TIMEOUT_MS=60000
```

## Wire The Frontend

After all backend services are deployed, edit `web/config.js`:

```js
window.__WF_CONFIG = {
  sponsorUrl: "https://YOUR_SPONSOR_SERVICE_DOMAIN/sponsor",
  portalUrl: "https://YOUR_PORTAL_SERVICE_DOMAIN",
  llmProxyUrl: "https://YOUR_LLM_SERVICE_DOMAIN/llm",
  zkSaltUrl: "https://YOUR_SALT_SERVICE_DOMAIN/salt",
  zkProverUrl: "",
  zkGoogleClientId: "YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com"
};
```

Commit and push. Vercel will redeploy the frontend with these public backend URLs.

## Health Checks

Open these URLs after deploy:

```text
https://YOUR_LLM_SERVICE_DOMAIN/health
https://YOUR_SPONSOR_SERVICE_DOMAIN/health
https://YOUR_SALT_SERVICE_DOMAIN/health
https://YOUR_PORTAL_SERVICE_DOMAIN/health
https://YOUR_INDEXER_SERVICE_DOMAIN/api/health
https://YOUR_IMPORTER_SERVICE_DOMAIN/health
```
