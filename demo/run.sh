#!/usr/bin/env bash
# WalrusForge end-to-end demo (live Sui testnet + Walrus).
#
# Runs the full agent-native release workflow as a single script:
#   init -> grant agent -> agent opens PR -> CI worker tests+reviews ->
#   owner merges -> owner publishes release.
#
# Prereqs:
#   - Sui CLI in PATH (or set SUI=~/.sui-cli/sui.exe), funded testnet wallet
#   - cd app && npm install
#   - FORGE_AGENT_KEY (suiprivkey1...) for the agent identity that holds the cap.
#     FORGE_CI_KEY for the CI agent (defaults to FORGE_AGENT_KEY for a 1-wallet demo).
#
# Usage: FORGE_AGENT_KEY=suiprivkey1... bash demo/run.sh [repo-name]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="$ROOT/app"
SRC="$ROOT/demo/sample-repo"
NAME="${1:-counter-demo-$RANDOM}"
SUI="${SUI:-sui}"

forge() { ( cd "$APP" && npx tsx src/cli/index.ts "$@" ); }
state() { node -e "console.log(require('$SRC/.forge/state.json').$1)"; }

echo "==> 0. prepare a tiny Move sample repo"
rm -rf "$SRC"; mkdir -p "$SRC/sources"
cat > "$SRC/Move.toml" <<'TOML'
[package]
name = "counter"
edition = "2024"
[dependencies]
TOML
cat > "$SRC/sources/counter.move" <<'MOVE'
module counter::counter;
public struct Counter has key { id: UID, value: u64 }
public fun increment(c: &mut Counter) { c.value = c.value + 1; }
MOVE

echo "==> 1. forge init ($NAME)"
forge init --name "$NAME" --dir "$SRC" --branch main
REPO_ID="$(state repoId)"

AGENT_ADDR="${FORGE_AGENT_ADDR:-$($SUI client active-address)}"

echo "==> 2. grant an AgentCap (open_pr + review) to the agent"
GRANT="$(forge grant-agent --recipient "$AGENT_ADDR" --dir "$SRC" --label ci-bot)"
echo "$GRANT"
CAP="$(echo "$GRANT" | grep -oE '0x[0-9a-f]{64}' | head -1)"

echo "==> 3. agent proposes a change (adds reset()) and opens a PR"
cat >> "$SRC/sources/counter.move" <<'MOVE'
public fun reset(c: &mut Counter) { c.value = 0; }
MOVE
PR="$(forge open-pr --cap "$CAP" --title 'add reset()' --dir "$SRC")"
echo "$PR"
PRID="$(echo "$PR" | grep -oE '0x[0-9a-f]{64}' | head -1)"

echo "==> 4. CI worker runs 'sui move test', uploads report, reviews on-chain"
( cd "$APP" && FORGE_CI_KEY="${FORGE_CI_KEY:-$FORGE_AGENT_KEY}" \
    npx tsx src/ci/worker.ts --repo "$REPO_ID" --pr "$PRID" --cap "$CAP" )

echo "==> 5. owner merges the PR (ref advances)"
forge merge --pr "$PRID" --dir "$SRC"

echo "==> 6. owner publishes release v0.1.0 with the full provenance chain"
echo "counter v0.1.0 build artifact" > "$SRC/artifact.bin"
echo "sui move test: OK" > "$SRC/report.txt"
forge release --tag v0.1.0 --artifact "$SRC/artifact.bin" --report "$SRC/report.txt" --dir "$SRC"

echo ""
echo "==> DONE. Start the indexer + web UI and open the repo:"
echo "      npm --prefix server start   # indexer + API on :4318"
echo "      npm --prefix web run dev     # UI on :4317"
echo "    Repo id: $REPO_ID"
