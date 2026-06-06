# Mainnet Runbook

This runbook prepares Signet for mainnet review. It does not authorize a deploy.

## Preflight

- Run `npm run ci:local`.
- Run `sui move test --path move/signet`.
- Confirm `move/signet/deployments.json` has the intended mainnet package and registry ids.
- Confirm sponsor, salt, portal, gateway and LLM proxy are configured with production origins.
- Confirm all signing keys are supplied through host secrets or local `.env` files.
- Confirm no `.env`, private key, SQLite cache or deployment output artifact is tracked.

## Dry Verification

```sh
node scripts/mainnet-readiness-check.mjs
npm run dev:doctor -- --profile mainnet
FORGE_NETWORK=mainnet npm --prefix app run forge -- verify --release <release-object-id>
```

## Deployment Boundary

Actual mainnet publish, upgrade, funded sponsor operation and third-party audit are separate steps.
They require explicit human approval, a funded key and a rollback/communication plan.

## Key rotation (REQUIRED before mainnet)

The current testnet deployer key is considered compromised and must NEVER touch mainnet.

1. Generate a fresh key on an offline/hardware signer; never reuse the testnet key.
2. Publish the mainnet package with the fresh key (manual, approved step).
3. Transfer the resulting `UpgradeCap` to a **multisig** (≥2-of-3); do not leave it on a hot key.
4. Record the new package id + `UpgradeCap` holder in `move/signet/deployments.json` (mainnet block).
5. Confirm CI/sponsor/release signers use mainnet keys from host secrets only (never committed).
6. Revoke/retire any old keys and rotate `SALT_SECRET` and service tokens.

## Rollback plan

Move packages are immutable and upgrades are additive, so "rollback" means stop using the bad
version, not deleting it.

- **Bad upgrade:** point `latestPackageId` (clients) back to the last-good package; old objects
  remain readable. Do not publish a fix under time pressure — prepare, test on testnet, re-approve.
- **Off-chain services:** redeploy the previous container image; `/health` + `/metrics` confirm
  recovery. Rate limits and error tracking are env-tunable without a code change.
- **Compromised key:** freeze deploys, rotate per the section above, and announce via the status
  page + repo SECURITY.md contact. The `UpgradeCap` multisig prevents a single-key takeover.
- **Communication:** post incident + ETA on the public `/status` page; update when resolved.

