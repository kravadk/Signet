# Signet — LLM proxy (backend P0)

A tiny, dependency-free Anthropic relay so Playground users can build apps **without
pasting their own API key** (no BYOK). It only forwards `prompt → completion`; it is
**never a source of truth** — every publish/metric/gallery read still happens directly
on Sui + Walrus, and if this proxy is down the client transparently falls back to BYOK.

## Why it exists
Onboarding friction (P0): the static SPA otherwise needs the user to bring an Anthropic
key. This relay holds one key server-side and rate-limits usage, so a first-time visitor
can just type a prompt.

## Run locally
```bash
cd server/llm-proxy
cp .env.example .env        # put your real ANTHROPIC_API_KEY in it
ANTHROPIC_API_KEY=sk-ant-... npm start    # or: node index.mjs
# -> Signet LLM proxy on :8787
curl localhost:8787/health   # {"ok":true}
```

## Deploy
Any Node 18+ host works (Render, Railway, Fly, a VPS, etc.). Set the env vars from
`.env.example` in the host dashboard. Then **lock `ALLOWED_ORIGIN`** to your deployed
site origin (e.g. `https://signet.wal.app`) so only your site can spend your key.

## API (matches the client `callLLM` proxy mode)
- `POST /llm` — body `{ model, system, messages }` → `{ text }`
- `GET /health` → `{ ok: true }`

Hardening built in: `claude-*` model allowlist, `MAX_TOKENS` cap, per-IP rate limit
(`RATE_LIMIT_PER_MIN`), 256 KB request cap, CORS pinned to `ALLOWED_ORIGIN`.

## Wire the client
In the Playground **LLM settings** modal, switch mode to **Hosted proxy** and paste the
proxy URL (e.g. `https://your-proxy.example.com/llm`). The client stores it in
`localStorage` (`wf.llm`) and sends `{model, system, messages}` there instead of calling
Anthropic directly. Leave it on **BYOK** to use your own key.

> Note: the proxy spends *your* Anthropic credits for every user. Keep `ALLOWED_ORIGIN`
> locked, keep `RATE_LIMIT_PER_MIN` conservative, and watch usage.
