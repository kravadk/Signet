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

