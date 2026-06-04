# Signet — sponsored-transaction service (backend P0)

Pays gas so a first-time user can run **value-free** Playground actions (record a
visit, star, flag, claim a `@handle`, publish/update an app) **without holding any
SUI**. Not a source of truth: it only co-signs gas for an allowlisted set of
`playground` calls. If it's down, users fall back to paying their own gas.

## Why it exists
Onboarding friction (P0): otherwise a new user needs testnet SUI before they can
even star or publish. With a sponsor, they connect a wallet and act immediately.

## Security model
The sponsor co-signs **only**:
- MoveCalls to an **allowlisted package** (`ALLOWED_PACKAGES`),
- in module `playground`,
- to a **value-free** function: `record_visit`, `star(_v2)`, `flag_app`, `set_hidden`,
  `claim_name`, `release_name`, `publish_app(_v2)`, `publish_remix_v3`, `update_app`.

Anything else — a different package/module, a non-MoveCall command, or a value-moving
call (`tip_app*`, `*_app_bounty`, `withdraw_treasury`) — is **rejected**, so the sponsor
can't be tricked into paying for arbitrary work or draining itself. Plus: per-IP,
per-wallet and per-function quotas, a daily sponsor budget, request-size cap, gas
budget cap, and CORS pinned to your origin.

Publish/update/remix sponsorship can be tightened with `SPONSOR_WRITE_MODE`:
- `open` - default, all validated users can use sponsored writes.
- `allowlist` - only `ALLOWED_SENDERS` can use sponsored publish/update/remix.
- `stake` - sender must have at least `STAKE_MIN_MIST` total SUI balance.

## Run locally
```bash
cd server/sponsor
npm install
cp .env.example .env   # set SPONSOR_PRIVATE_KEY (funded) + ALLOWED_PACKAGES
npm start              # -> Signet sponsor on :8788 · sponsor 0x…
curl localhost:8788/health
```

## API (matches the client sponsored flow)
- `POST /sponsor` — body `{ sender, txKindBytes }` (base64 `onlyTransactionKind`)
  → `{ txBytes, sponsorSignature }`
- `GET /health` → `{ ok, sponsor, network }`
- `GET /dashboard` → live balance, issued gas budget, rejected calls, rate-limit hits and quotas

Client: build `await tx.build({ client, onlyTransactionKind: true })`, POST it, have the
wallet sign the returned `txBytes`, then
`client.executeTransactionBlock({ transactionBlock: txBytes, signature: [userSig, sponsorSignature] })`.

## Deploy
Any Node 18+ host. Fund the sponsor wallet, keep its balance modest and rotatable,
lock `ALLOWED_ORIGIN`, keep `RATE_LIMIT_PER_MIN` + `GAS_BUDGET` conservative.
Then set the sponsor URL in the Playground LLM/onboarding settings.
