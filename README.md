# WalrusForge

**Agent-native repositories, pull requests and verifiable release chains — stored on Walrus, anchored by Sui.**

Built for **Sui Overflow 2026** · primary track: **Walrus**.

WalrusForge is not a GitHub clone. It is a release network where humans *and* AI
agents propose, review and ship code, and where the entire provenance chain —
`source snapshot → PR diff → agent review → test report → release artifact` — is
content-addressed in Walrus and anchored by Sui objects, capabilities and events.

Anyone can independently verify a release: every node in the chain is a real
Walrus blob and a real on-chain object, not a screenshot.

---

## Live on Sui testnet

| | |
|---|---|
| Package | `0x654fe8dd914bc440af0576e0d28d48e0c883ec9616f311f92571ec44dad71a8d` |
| ForgeRegistry (shared) | `0x4e4bc674d6c77acb27dfa07ab255d04eb6b31d34009f8ccd2309766f8286bb3b` |
| Walrus | public testnet publisher / aggregator (HTTP) |

A full demo repo (`counter-demo-v2`) has already been created, gone through an
agent-opened PR, a CI-agent review, an owner merge, and a published release
`v0.2.0` — all on live testnet.

---

## Architecture

```
move/walrusforge/      Sui Move contracts (the trust layer) — 6 modules
  sources/
    forge.move           Registry, Repository, RepoOwnerCap, AgentCap (scoped + revocable)
    pull_request.move    PullRequest, Review, merge (stale-base guarded) + reputation hooks
    release.move         Release — the verifiable provenance chain
    issue.move           Issues + comments
    bounty.move          On-chain SUI escrow bounties (post/claim/submit/approve/cancel)
    reputation.move      Per-repo AgentProfile counters (PRs/reviews/CI)
  tests/forge_tests.move 12 tests: permissions, revoke, issues, bounties, reputation, full chain

app/                   TypeScript CLI + SDK + MCP server + CI worker
  src/lib/{walrus,snapshot,sui,forge-read,actions}.ts   storage, PTBs, reads, actions
  src/cli/index.ts       forge init / grant-agent / revoke-agent / open-pr /
                         review / merge / release / status
  src/mcp/server.ts      MCP server (stdio) — 13 agent tools (repo/pr/issue/bounty/reputation)
  src/ci/worker.ts       CI agent: fetch snapshot -> `sui move test` -> report -> on-chain review

server/                Indexer + REST API (the backend)
  src/index.ts           polls Move events -> SQLite (node:sqlite) -> /api/* endpoints

web/                   Next.js UI (the consumer side)
  src/lib/{forge,api}.ts on-chain reads + indexer client
  src/app/               home · /repo/[id] (PRs, issues, bounties, reputation, activity)
                         /pr/[id] (diff + reviews) · /release/[id] (provenance chain)
                         /agent/[address] (on-chain reputation profile)

demo/run.sh            one-command live end-to-end (init→PR→CI→merge→release)
```

### Trust model
- **RepoOwnerCap** — only the owner can update refs, merge PRs, publish releases.
- **AgentCap** — delegated, *scoped* (`open_pr` / `review` / `run_ci`), epoch expiry,
  and **owner-revocable** (instant kill-switch). Agents propose, review and run CI;
  they can **never** merge or release.
- **Reputation** — every PR/review/merge bumps an on-chain `AgentProfile`; reputation
  is a side effect of real signed actions, not self-reported.

---

## Run it

### Contracts
```sh
cd move/walrusforge
sui move test          # 7/7 pass
sui client publish     # deploy (writes deployments.json)
```

### CLI (end-to-end)
```sh
cd app && npm install
npm run forge -- init --name my-repo --dir ../some-code
npm run forge -- grant-agent --recipient 0xAGENT
npm run forge -- open-pr --cap 0xCAP --title "fix bug" --dir ../some-code
npm run forge -- review --cap 0xCAP --pr 0xPR --report report.txt
npm run forge -- merge --pr 0xPR
npm run forge -- release --tag v0.1.0 --artifact build.bin --report report.txt
```

### Web
```sh
cd web && npm install && npm run dev   # http://localhost:4317
```

### MCP server (agent-native)

Agents drive WalrusForge through an MCP server that signs with the **agent's own
key** and is bounded by the agent's on-chain `AgentCap` — it exposes only
agent-permitted tools (`repo_list`, `repo_read_manifest`, `release_read`,
`pr_create`, `review_submit`, `artifact_upload`); merge/release are absent by
design. Configure any MCP client (Claude Desktop, Cursor, …):

```json
{ "mcpServers": { "walrusforge": {
  "command": "npx",
  "args": ["tsx", "app/src/mcp/server.ts"],
  "env": { "FORGE_AGENT_KEY": "suiprivkey1..." }
}}}
```

Read tools work without a key. Write tools require `FORGE_AGENT_KEY` and fail
cleanly when the cap lacks the needed scope (e.g. a review-only cap cannot open a
PR) — proving the agent cannot exceed its delegated permissions.

---

## Why Sui + Walrus

- **Walrus** gives durable, content-addressed storage for the bytes that matter
  (code, diffs, reports, artifacts) — far cheaper than putting them on-chain.
- **Sui** gives object-centric ownership, capability-based permissions and events
  — exactly the primitives a release-trust layer needs, with no custom DID/UCAN
  stack.

Together they make a software supply chain that an AI agent can participate in
safely and that a human can verify completely.
