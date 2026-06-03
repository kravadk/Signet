# Signet GitHub Importer

Keyless backend that turns a GitHub repo into a verifiable Signet snapshot, so the
web app can offer **Connect from GitHub** (browsers can't clone or build the
snapshot themselves — CORS + format).

```
POST /import  { "url": "https://github.com/owner/repo", "branch": "main" }
  -> { name, branch, treeHash, files, archiveBlob, manifestBlob }
GET  /health  -> { ok: true }
```

Flow: shallow-clone → `buildSnapshot` (the **same** code the CLI uses, so the
`treeHash` is byte-identical and independently verifiable) → upload the archive +
manifest to Walrus → return blob ids. **It signs nothing.** The web app then calls
`forge::create_repo` with the returned `manifestBlob`, signed by the user's wallet.

## Run

It imports the `app/` workspace's snapshot/Walrus libraries via `tsx`, so install
the app deps first (they resolve from `app/node_modules`):

```sh
npm --prefix ../../app install   # once
cp .env.example .env             # adjust if needed
FORGE_NETWORK=testnet npm start  # listens on :8795
```

Then point the web app at it: set `importProxyUrl` in `web/config.js` (or
`web/shared.js` defaults) to this service's URL.

## Safety

- Only `https://github.com/<owner>/<repo>` URLs are accepted (SSRF guard); owner,
  repo and branch are validated against a strict charset.
- Shallow clone (`--depth 1`), clone timeout, and a `MAX_FILES` cap bound abuse.
- No private keys, no on-chain signing — the worst case is an unwanted Walrus
  upload, which the per-IP front (reverse proxy / gateway) should rate-limit in
  production.

Testnet-oriented (free Walrus publisher). For mainnet, Walrus uploads spend WAL and
need the `walrus` CLI configured — out of scope for this keyless service.
