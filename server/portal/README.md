# WalrusForge — public portal

Gives every published Playground app a **clean, human URL with rich link previews**, and a
builder a `@handle` page — something a static SPA can't do (it can't emit per-app Open Graph
meta). The portal re-verifies the content **tree-hash against the on-chain anchor** on every
request before rendering the app in a sandboxed iframe.

Not a source of truth: every byte comes from Sui + Walrus and is re-verified per request — the
portal only gives the bytes a shareable face (canonical URL + og:/twitter: card).

## Routes
- `GET /app/:id[?net=mainnet]` — the app, with og card + a `✓ verified` / `⚠ unverified` /
  `⚠ expired` provenance badge. Expired-bytes apps show the permanent on-chain record + a re-pin hint.
- `GET /@:handle[?net=mainnet]` — builder profile (their apps, totals) with an og card.
- `GET /api/apps[?net=&limit=]` — JSON list of published apps (a read API the indexer lacks).
- `GET /health` — `{ ok, nets }`.

## Run
```sh
cd server/portal && npm install
PUBLIC_ORIGIN=https://your.domain npm start   # :8790
curl localhost:8790/health
curl "localhost:8790/api/apps?limit=5"
```
Network object ids come from `move/walrusforge/deployments.json` automatically.

## Deploy
Any Node 18+ host. Point a domain at it and set `PUBLIC_ORIGIN` so canonical/og URLs are right;
put a CDN in front (responses are cacheable per id). The Playground's 🔗 Share can then point at
`PUBLIC_ORIGIN/app/<id>` for previews that render in chat apps and social.

## Security
The app is rendered in `sandbox="allow-scripts"` (no `allow-same-origin`) with a strict CSP
(`default-src 'none'`, `connect-src 'none'`) and meta-refresh stripping — same posture as the
in-app viewer. All on-chain/LLM strings are HTML-escaped before they reach the page.
