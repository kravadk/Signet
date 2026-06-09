# Deploying the optional services

The Signet web app and CLI work **without any backend** — every read/write goes straight to
Sui + Walrus. These services are *accelerators*: deploy the ones whose feature you want, set the
matching `WF_*` URL so the web app can reach them, and the corresponding UI lights up. Anything
left undeployed degrades calmly (the app says the feature isn't enabled and falls back).

| Service (`server/…`) | Enables in the app | Required env to run it | Web wiring (`WF_*`) |
| --- | --- | --- | --- |
| `llm-proxy` | Playground **Build** without users bringing their own LLM key | `ANTHROPIC_API_KEY` (+`PORT`, `ALLOWED_ORIGIN`) | `WF_LLM_PROXY_URL` → `…/llm` |
| `sponsor` | **Gas-free** signing for value-free actions + the Dashboard sponsor widget | `SPONSOR_PRIVATE_KEY` (funded testnet), `ALLOWED_PACKAGES` | `WF_SPONSOR_URL` → `…/sponsor` |
| `salt` | **zkLogin** "Sign in with Google" (walletless) | `SALT_SECRET` (≥16 chars), `GOOGLE_CLIENT_ID` | `WF_ZK_SALT_URL` → `…/salt` + `WF_ZK_GOOGLE_CLIENT_ID` |
| `portal` | Human URLs + share/OG cards (`/app/:id`, `/@handle`) | `PUBLIC_ORIGIN` | `WF_PORTAL_URL` |
| `importer` | One-click **Import from GitHub** in the web (CLI `forge import` needs nothing) | `FORGE_NETWORK=testnet` | `WF_IMPORT_URL` → `…/import` |
| `src` (gateway) | Hosted indexer + `/verify` `/metrics` `/status` `/webhooks` | `FORGE_NETWORK`, `PORT` | (read adapter / dashboards) |

## 1. Run a service

Each service is a small Node 18+ app. Local:

```sh
ANTHROPIC_API_KEY=sk-ant-…  node server/llm-proxy/index.mjs       # :8787
SPONSOR_PRIVATE_KEY=suiprivkey1…  node server/sponsor/index.mjs   # :8788
SALT_SECRET=…  GOOGLE_CLIENT_ID=…  node server/salt/index.mjs     # :8789
PUBLIC_ORIGIN=https://…  node --import tsx server/portal/index.mjs   # :8790
FORGE_NETWORK=testnet  node --import tsx server/importer/index.mjs   # :8795
```

Or everything at once for local dev (also writes `web/config.js`): `npm run dev:all`.
Docker: each dir has a `Dockerfile`; `docker compose up --build` runs the whole stack.

Hosted (Render/Railway/Fly/Vercel functions): point the platform at the service dir (or the
Dockerfile), set the env above, and note the public URL.

## 2. Wire the URLs into the web app

The web reads service URLs from `web/config.js`, generated from `WF_*` env:

```sh
WF_LLM_PROXY_URL=https://your-llm.example.com/llm \
WF_SPONSOR_URL=https://your-sponsor.example.com/sponsor \
WF_ZK_SALT_URL=https://your-salt.example.com/salt \
WF_ZK_GOOGLE_CLIENT_ID=…apps.googleusercontent.com \
WF_PORTAL_URL=https://your-portal.example.com \
WF_IMPORT_URL=https://your-importer.example.com/import \
  npm run gen:web-config        # writes web/config.js
```

On Vercel, set those as project env vars and run `gen:web-config` in the build step (or edit
`web/config.js` directly). Leaving a `WF_*` unset simply keeps that feature off.

## 3. Production hardening (env-gated, optional)

- **Distributed rate limiting:** set `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`
  (alias `RATE_LIMIT_REDIS_*`) on every service → limits are shared across instances; unset →
  in-memory; any Redis error fails open. Tune with `RATE_LIMIT_PER_MIN`.
- **Error tracking:** set `ERROR_TRACKING_DSN` → structured errors are POSTed there; unset → no-op.
- **Walrus freshness:** the `renew.yml` (re-pin blobs) and `seed.yml` (keep the gallery non-empty)
  GitHub Actions run weekly; `seed.yml` needs the `FORGE_SEED_KEY` repo secret.

## Security

Never commit keys. `SPONSOR_PRIVATE_KEY`, `SALT_SECRET`, `ANTHROPIC_API_KEY`, `FORGE_SEED_KEY`
live only in host secrets / a git-ignored `.env`. Use a **testnet** key for the sponsor; the
mainnet key custody model is in [../SECURITY.md](../SECURITY.md).
