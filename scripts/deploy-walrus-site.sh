#!/usr/bin/env bash
#
# Publish/update the Signet web SPA on Walrus Sites (testnet).
# Used by .github/workflows/deploy-web.yml and runnable locally.
#
# Requires `walrus` + `site-builder` on PATH (the workflow downloads pinned builds)
# and a funded testnet key. Env:
#   SUI_DEPLOY_KEY  (required) bech32 suiprivkey1…, funded with SUI + WAL; site owner.
#   SITE_OBJECT     (optional) existing Walrus Site object id to UPDATE (keeps the
#                   subdomain stable); if unset, a fresh `publish` is done.
#   EPOCHS          (optional) storage epochs, default 30.
#   WEB_DIR         (optional) directory to publish, default ./web.
#
# NOTE: site-builder flags/config vary by version — this is the testnet happy path;
# verify on the first real run and adjust the pinned version / flags if needed.
set -euo pipefail

: "${SUI_DEPLOY_KEY:?set SUI_DEPLOY_KEY (testnet, funded SUI+WAL)}"
EPOCHS="${EPOCHS:-30}"
WEB_DIR="${WEB_DIR:-web}"

# 1. Ensure a testnet sui env + import the deploy key as the active address.
sui client new-env --alias testnet --rpc https://fullnode.testnet.sui.io:443 >/dev/null 2>&1 || true
sui client switch --env testnet >/dev/null 2>&1 || true
# Import the key (idempotent: ignore "already imported"). site-builder signs with
# the active sui address.
printf '%s\n' "$SUI_DEPLOY_KEY" | sui keytool import --key-scheme ed25519 - >/dev/null 2>&1 || true
ADDR="$(sui client active-address 2>/dev/null || true)"
echo "[deploy] active address: ${ADDR:-unknown} · epochs=$EPOCHS · dir=$WEB_DIR"

# 2. Publish or update the site.
if [ -n "${SITE_OBJECT:-}" ]; then
  echo "[deploy] updating existing site $SITE_OBJECT"
  site-builder update --epochs "$EPOCHS" "$WEB_DIR" "$SITE_OBJECT"
else
  echo "[deploy] publishing a new site (record the printed object id into deployments.json -> walrusSite)"
  site-builder publish --epochs "$EPOCHS" "$WEB_DIR"
fi
echo "[deploy] done"
