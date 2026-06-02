# WalrusForge — zkLogin salt service (backend P0)

Issues a **stable, per-user salt** so a zkLogin user's Sui address is the same on
every login — **without a database**. The salt is `HMAC(SALT_SECRET, iss|aud|sub)`
truncated to 128 bits, returned only after the Google `id_token` is cryptographically
verified (RS256 vs Google JWKS, plus `exp` / `iss` / `aud` checks).

Part of the no-wallet onboarding (P0-1): combined with the client zkLogin flow
(`web/zklogin.js`) and the sponsor service, a user signs in with Google and acts on
Sui with **no wallet and no gas**.

## Why stateless HMAC
A zkLogin address derives from `(iss, aud, sub, salt)`. The salt must be stable per
user and unknown to others. Deriving it as an HMAC of the verified identity gives a
deterministic salt with **no storage** to lose or leak — only `SALT_SECRET` matters.
Rotating `SALT_SECRET` rotates everyone's address, so set it once and keep it safe.

## Run locally
```bash
cd server/salt
cp .env.example .env     # set SALT_SECRET (long random) + GOOGLE_CLIENT_ID
npm start                # -> WalrusForge salt service on :8789
curl localhost:8789/health
```

## API
- `POST /salt` — body `{ jwt }` (Google id_token) → `{ salt }` (decimal string < 2^128)
- `GET /health` → `{ ok: true }`

## Deploy
Any Node 18+ host. Set `SALT_SECRET` (treat like a master key), `GOOGLE_CLIENT_ID`,
and lock `ALLOWED_ORIGIN`. The client calls `/salt` after Google sign-in, then derives
the address (`jwtToAddress`) and requests a proof from a zk prover (Mysten-hosted or
self-hosted). See `web/zklogin.js`.

> The salt service never sees a private key and can't move funds — it only maps a
> verified Google identity to a deterministic salt.
