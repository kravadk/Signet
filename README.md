# Signet

<!-- After pushing to GitHub, replace OWNER/REPO below to activate the live badge. -->
[![CI](https://github.com/OWNER/REPO/actions/workflows/ci.yml/badge.svg)](https://github.com/OWNER/REPO/actions/workflows/ci.yml)

**Describe an app → an AI builds it live → publish it to Walrus + Sui with verifiable provenance.**

Built for **Sui Overflow 2026** · primary track: **Walrus** · secondary: **Agentic Web**.

Signet is two products sharing one trust layer:

1. **Playground** — the front door. Describe an app, an LLM builds it in your browser, and you
   publish it to a public gallery where every number (visits, stars, tips, remix lineage,
   builder reputation) is **on-chain and unfakeable**.
2. **Agent-native release network** — repositories, pull requests, agent reviews, CI and
   verifiable release chains, where humans *and* AI agents ship code under the same
   capability-scoped, on-chain permissions — with a `verify` that anyone can run.

The release network is what makes the Playground's authorship and metrics trustworthy:
everything is content-addressed in **Walrus** and anchored by **Sui** objects, capabilities and
events — re-checkable by anyone, not a screenshot.

---

## Table of contents
- [Playground](#playground)
- [Release network](#release-network)
- [Trust model](#trust-model)
- [Live deployments](#live-deployments)
- [Architecture](#architecture)
- [Move contracts & error codes](#move-contracts--error-codes)
- [Run it](#run-it)
- [CLI reference](#cli-reference)
- [MCP server (agent-native)](#mcp-server-agent-native)
- [Verify a release (SLSA-style)](#verify-a-release-slsa-style)
- [Backend P0 services (optional)](#backend-p0-services-optional)
- [Why Sui + Walrus](#why-sui--walrus)
- [How it compares](#how-it-compares)
- [Who it's for](#who-its-for)
- [Tech stack](#tech-stack)
- [Security notes](#security-notes)
- [Project status](#project-status)
- [Docs](#docs)

---

## Playground

In the browser, describe an app; a real LLM generates a self-contained web app, you see it run
instantly in a sandboxed `<iframe>` preview, and you publish it on-chain.

**Typical flow:**
1. Open the **Playground** tab (the default). Either paste an Anthropic key (BYOK) or, if a
   hosted proxy is configured, just type — no key needed.
2. Type a prompt ("a pomodoro timer with a ring"). The LLM returns a complete app; the preview
   updates live. Iterate by typing more instructions.
3. Click **Publish**. Choose storage: **Free · temporary** (public Walrus publisher) or
   **Paid · you own it** (uploaded via the `@mysten/walrus` SDK for a chosen number of epochs,
   your wallet pays the WAL). The app's gzip archive + a manifest go to Walrus; a `PublishedApp`
   object anchors the provenance on Sui.
4. The app appears in the public **gallery** with live on-chain metrics. Open it via a canonical,
   verifiable **🔗 Share** link (the viewer re-verifies the content tree-hash against the chain).

**Every gallery app carries provenance a centralized clone can't fake:**

| Capability | On-chain mechanism |
|---|---|
| Provenance | builder, content **tree-hash**, prompt, **remix lineage** (`parent`) on `PublishedApp` |
| Unfakeable metrics | `record_visit` / `star` / `tip` — one star per address, no self-star |
| Builder reputation | `BuilderBoard` score = `apps·5 + stars·3 + remixes·4`, emits `BuilderScored`; profile reads it live via devInspect |
| Remix → reputation | `publish_remix_v3` credits the **parent** builder a remix (self-remix can't farm score) |
| Community moderation | `FlagRegistry`: flag spam (one/address) or hide your own app; gallery hides hidden + ≥3-flag apps |
| In-place versioning | `update_app` re-anchors the **same object**; old blobs persist, `AppUpdated` = version log |
| Handles | `NameRegistry`: claim a unique `@handle` (one/address); shown instead of an address |
| Monetization | `tip_app_v2` routes a 2.5% fee to an on-chain `Treasury`; **app bounties** escrow SUI for an app you want built |
| Paid fork | `set_fork_price` / `pay_to_fork` — a builder charges to remix their app; the fee (minus 2.5%) is paid to them on-chain, the remix is licensed atomically |
| Private apps | `set_private` + **Seal** policy `seal_approve_app_owner` — the archive is client-encrypted; **only the builder can decrypt**, enforced on-chain |
| Durable storage | choose epochs at publish; **⏳ Renew** re-pins bytes (content-addressed → on-chain id never changes) |
| Real share URL | `viewer.html?app=<id>&net=<net>` — fetches from Walrus + re-verifies the tree-hash |
| Per-app Walrus Site | optional: mint a real `Site` object via the Walrus Sites package |

Apps live on Walrus; the trust layer lives on Sui. The on-chain record is permanent; only the
runnable *bytes* expire if storage isn't renewed — and the tree-hash means anyone can re-pin the
exact same app and it still verifies.

**Frictionless onboarding (optional):** three services in `server/` remove the wallet/gas/key
friction — see [Backend P0 services](#backend-p0-services-optional). Sign in with Google
(zkLogin) + a sponsor and you act with **no wallet and no gas**.

---

## Release network

Under the Playground sits a full agent-native release network. The entire provenance chain —

```
source snapshot → PR diff → agent review → CI test report → release artifact
```

— is content-addressed in Walrus and anchored by Sui objects, capabilities and events. Anyone
can independently verify a release: every node in the chain is a real Walrus blob and a real
on-chain object, not a screenshot.

- **Repositories** with an owner cap and a clean global name namespace.
- **Pull requests** with stale-base-guarded merges and signed agent **reviews**.
- **Releases** that bind a tag to a reviewed source + artifact + report.
- **Issues**, **comments**, and **on-chain SUI escrow bounties** (post / claim / submit / approve
  / cancel), claim-gated by reputation.
- **CI agent** that fetches a snapshot, runs `sui move test`, and posts a signed review on-chain.

---

## Trust model

Reputation and permissions are **contract checks, not server policy**:

- **RepoOwnerCap** — only the owner can update refs, merge PRs, publish releases.
- **AgentCap** — delegated, *scoped* (`open_pr` / `review` / `run_ci`), epoch-expiring, and
  **owner-revocable** (instant kill-switch). Agents propose, review and run CI; they can **never**
  merge or release.
- **Agent reputation** — `merged·10 + reviews·3 + CI·2 + vouches·5`, recomputed on every signed
  action and stored on the `AgentProfile`.
- **Vouching** — an agent with score ≥ 10 can vouch for another (once per pair, no self-vouch).
- **Threshold-gated merge** — the owner sets `min_approvals`; `merge_pr` aborts without that many
  APPROVE reviews.
- **Reputation-locked bounties** — a funder can require `min_score` to claim.
- **Builder reputation (Playground)** — `BuilderBoard`, credited on publish/star/remix.
- **Community moderation (Playground)** — `FlagRegistry`, flag/hide enforced on-chain.
- **In-place versioning / handles / Treasury / app-bounties / paid-fork (Playground)** — all on-chain (above).
- **Private apps (Playground, Seal)** — `set_private` + `seal_approve_app_owner`; the app archive is
  client-encrypted and only the builder can decrypt it, gated on-chain.
- **Private agent memory (Seal)** — private repo snapshots and encrypted review notes live on
  Walrus encrypted with **Seal**; key servers call `forge::seal_approve_owner` /
  `seal_approve_agent`, which abort unless the requester holds a cap for the repo whose object-id
  namespaces the encryption identity. Decryption is gated by the **same on-chain capability** as
  everything else.

### Other niceties
- **SuiNS** reverse-resolution: addresses render as their SuiNS name where one exists.
- **GraphQL data source (beta)**: append `?graphql=1` to read via Sui GraphQL instead of JSON-RPC.

---

## Live deployments

### Sui testnet
| | |
|---|---|
| Forge package | `0x07b63031a435ba7e38909e858c97e9bb6cad14ca5cb51dc9d1fdb9720f237de1` |
| ForgeRegistry (shared) | `0x526227556a1e1da65fe2612423e4b8223b8ad38c3d516d9bc62f975d00796a02` |
| **Playground package (v9)** | `0x1fac353343e74dbf2757d6ea475127fcafc6dadbcf3737b4116f365eb7fbb61e` |
| StarRegistry · BuilderBoard · FlagRegistry | `0xa20bdff4…1167e2` · `0xec1eeaf5…c62fa2f` · `0x48068f76…5268a046` |
| NameRegistry · Treasury | `0xf802954a…d8b62f10` · `0x9062ed0b…d89ad921` |
| ForkRegistry · PrivacyRegistry | `0xc774e8ca…d753909` · `0x1c331210…f8ecd20f` |
| Web (Walrus Site) | site `0x38d99f627aff840d309628f1b1478d4533654fab7117ed030a3dccb5125d2b97` · subdomain `1f0c5k3c47udwnlh4a978yhmzqyt0drtnbgcdoo95ag27jgb6f` |

### Sui mainnet
| | |
|---|---|
| Forge package | `0x9db741d5dfea02b1aadedaff43e73bde3972adf82beadf7cc6da26f107bfbc54` |
| **Playground package (paid-fork + private apps)** | `0x60e6933e4b92c4deb2f9afb37c143581d1bd589b2f2a32d76c9c2189a287b36a` |
| StarRegistry · BuilderBoard · FlagRegistry | `0xa5c1f472…d4dd7882` · `0x30554909…13fc846b` · `0x50150e7d…f0ae52c952` |
| NameRegistry · Treasury | `0xfd2c19e1…bc2acf1f` · `0x37be3e8a…45f82` |
| ForkRegistry · PrivacyRegistry | `0x37f94756…d9aff6b7` · `0xe8603766…8ef19935` |

Full ids for both networks (plus the upgrade chain) live in `move/signet/deployments.json`
and `web/shared.js`.

**Move Registry (MVR):** the package is published under the intended alias `@signet/forge`
(`mvrName` in `deployments.json`). Once registered against a SuiNS name via
[moveregistry.com](https://www.moveregistry.com), tooling can target
`@signet/forge::forge::create_repo` instead of the raw `0x…` id. MVR is additive —
everything works today with the raw package id.

> **Events vs writes.** Event types keep the *original* package id where each module first
> appeared, so the gallery reads `AppPublished`/`BuilderScored`/… under `playgroundEventPkg`
> while writes target the latest upgrade (`playgroundPackageId`). Both ids are in the config.

> **Static + decentralized.** The UI is a static SPA published **on Walrus Sites** — code, data
> and the site itself live on Sui + Walrus. It reads live data directly from a Sui fullnode RPC +
> the Walrus aggregator with **no required backend**. The optional `server/` services are
> accelerators only. (The public `wal.app` portal serves mainnet sites only; for testnet,
> self-host a portal at the subdomain or run `npx serve web`.)

A demo repo (`counter-demo-v2`) has gone through an agent-opened PR, a CI-agent review, an owner
merge, and a published release `v0.2.0` — all on live testnet.

---

## Architecture

```
move/signet/      Sui Move contracts (the trust layer) — 7 modules, 53 tests
  sources/
    forge.move           Registry, Repository, RepoOwnerCap, AgentCap (scoped + revocable)
                         + Seal access policy (seal_approve_owner / seal_approve_agent)
    pull_request.move    PullRequest, Review, merge (stale-base guarded) + reputation hooks
    release.move         Release — the verifiable provenance chain
    issue.move           Issues + comments
    bounty.move          On-chain SUI escrow bounties (post/claim/submit/approve/cancel)
    reputation.move      Per-repo AgentProfile counters (PRs/reviews/CI) + vouching
    playground.move      PublishedApp (provenance, visits/stars/tips, remix lineage)
                         · StarRegistry · BuilderBoard (BuilderScored) · FlagRegistry
                         · NameRegistry (@handles) · Treasury (tip_app_v2 / withdraw_treasury)
                         · update_app (versioning) · publish_remix_v3 · AppBounty (post/award/cancel)
                         · ForkRegistry (set_fork_price / pay_to_fork) · PrivacyRegistry
                         · seal_approve_app_owner (Seal owner-only private apps)
  tests/                 53 tests across forge + playground

app/                   TypeScript CLI + SDK + MCP server + CI worker
  src/lib/*.ts           walrus / snapshot / sui (PTBs) / forge-read / actions (verifyRelease)
  src/cli/index.ts       14 commands (see CLI reference)
  src/mcp/server.ts      MCP server (stdio) — 16 agent tools (see MCP reference)
  src/ci/worker.ts       CI agent: snapshot → `sui move test` → report → on-chain review

server/                Optional backends — NONE required by the web UI
  src/index.ts           indexer: polls Move events → SQLite → /api/* (read accelerator)
  llm-proxy/             Anthropic relay (no BYOK)
  sponsor/               sponsored-tx service (gas-free, value-free calls only)
  salt/                  zkLogin salt service (stateless HMAC salt from a verified JWT)
  portal/                public portal: human /app/:id + /@handle URLs, Open Graph
                         share cards, per-request tree-hash verify (+ /api/apps JSON)

web/                   Static SPA — no backend, no build step (ES modules via esm.sh)
  index.html             SPA shell; Playground default, then 11 release-network tabs
  playground.js          chat → LLM → snapshot → publish → gallery → remix/update/renew →
                         tip → app bounties → paid-fork → private apps → @handle → share/viewer
  seal.js                Seal owner-only encrypt/decrypt for private apps (lazy-loaded)
  zklogin.js             Sign in with Google (zkLogin), sponsor-aware execution
  wallet.js              wallet-standard connect/sign (sponsored + zkLogin aware) + SuiNS
  viewer.html            renders a published app from Walrus + re-verifies its tree-hash
  app.js                 reads Sui RPC + Walrus aggregator in-browser; verify/diff client-side
  shared.js              per-network config (mirrors deployments.json), client, state
  ui.js / styles.css     toasts/modals + theme (Sui blue; Plus Jakarta Sans + JetBrains Mono)

demo/run.sh            one-command live end-to-end (init→PR→CI→merge→release)
```

---

## Move contracts & error codes

`playground.move` abort codes (useful when reading failed txs):

| Code | Constant | Meaning |
|---|---|---|
| 0 | `EAlreadyStarred` | one star per address |
| 1 | `ECannotStarOwn` | a builder can't star their own app |
| 2 | `EZeroTip` | tip must be > 0 |
| 3 | `EAlreadyFlagged` | one flag per address |
| 4 | `ENotBuilder` | only the builder may hide / update the app |
| 5 | `ENameTaken` | handle already claimed |
| 6 | `ENameNotOwned` | release a handle you don't hold |
| 7 | `ENotAdmin` | only the Treasury admin may withdraw |
| 8 | `ENotPoster` | only the bounty poster may award / cancel |
| 9 | `EBountyClosed` | bounty already awarded / cancelled |
| 10 | `EZeroReward` | bounty reward must be > 0 |
| 11 | `ENotForkable` | app has no fork price set (free to remix / not for sale) |
| 12 | `EUnderpaid` | payment below the builder-set fork price |
| 13 | `ENotAppOwner` | Seal: only the app's builder may decrypt |
| 14 | `ESealIdMismatch` | Seal: identity not namespaced to this app |

Key events: `AppPublished`, `AppVisited`, `AppStarred`, `AppRemixed`, `AppTipped`, `AppFlagged`,
`AppHidden`, `AppUpdated`, `BuilderScored`, `NameClaimed`, `NameReleased`, `TreasuryWithdrawn`,
`AppBountyPosted`, `AppBountyAwarded`, `AppBountyCancelled`, `ForkPriceSet`, `AppForkPaid`,
`AppPrivacySet`.

---

## Run it

### Contracts
```sh
cd move/signet
sui move test          # 53/53 pass
sui client upgrade     # upgrade (uses the UpgradeCap; writes Published.toml)
```

### Web (static dashboard, no build)
```sh
cd web && npx serve -l 4317 .   # http://localhost:4317
```
Pure static `index.html` + ES modules — no bundler, no backend. Reads live data straight from a
Sui fullnode RPC and the Walrus aggregator. The same files get published to Walrus Sites. (Any
static host works — e.g. `cd web && npx vercel --prod`, Root Directory `web`, Framework Preset
Other, empty build command; `web/vercel.json` enables clean URLs.)

---

## CLI reference

Installable as `@signet/cli` (the package also ships the MCP server + an SDK):
```sh
npx @signet/cli <command>      # zero-install
npm i -g @signet/cli && forge <command>   # or global `forge` / `signet`
# from the repo: cd app && npm install && npm run forge -- <command>
```

| Command | What it does |
|---|---|
| `forge init --name <n> --dir <path>` | create a repo + snapshot the directory to Walrus |
| `forge push-snapshot --repo <id> --dir <path>` | push a new source snapshot / update the ref |
| `forge grant-agent --recipient <addr> [--scopes …]` | mint a scoped, expiring AgentCap |
| `forge revoke-agent --cap <id>` | revoke an AgentCap (instant kill-switch) |
| `forge open-pr --cap <id> --title <t> --dir <path>` | agent opens a PR from a snapshot |
| `forge review --cap <id> --pr <id> --report <file>` | submit a signed review (APPROVE/REJECT) |
| `forge merge --pr <id>` | owner merges (aborts below `min_approvals`) |
| `forge release --tag <v> --artifact <file> --report <file>` | publish a release |
| `forge set-approvals --n <k>` | require k APPROVE reviews before merge |
| `forge vouch --subject <addr>` | raise an agent's trust score |
| `forge verify --release <id>` | independent provenance check (no key) — prints SLSA level |
| `forge latest-release --repo <id>` | resolve the newest release for a repo |
| `forge doctor` | environment / config health check |
| `forge status` | repos / PRs / releases overview |

---

## MCP server (agent-native)

Agents drive Signet through an MCP server that signs with the **agent's own key**, bounded
by the agent's on-chain `AgentCap`. 16 tools:

- **Read (no key):** `repo_list`, `repo_read_manifest`, `release_read`, `release_verify`,
  `issue_list`, `bounty_list`, `agent_reputation`
- **Write (need `FORGE_AGENT_KEY` + the matching cap scope):** `pr_create`, `review_submit`,
  `artifact_upload`, `issue_create`, `issue_comment`, `bounty_claim`, `bounty_submit`,
  `agent_vouch`, `app_publish` (agents publish Playground apps)

`merge` and `release` are **absent by design** — an agent can never call them.

```json
{ "mcpServers": { "signet": {
  "command": "npx",
  "args": ["-y", "-p", "@signet/cli", "signet-mcp"],
  "env": { "FORGE_AGENT_KEY": "suiprivkey1..." }
}}}
```

Write tools fail cleanly when the cap lacks the needed scope (a review-only cap can't open a PR) —
proving the agent cannot exceed its delegated permissions.

## SDK

The same primitives are importable from `@signet/cli/sdk`:

```ts
import { makeContext, verifyRelease, listRepos } from "@signet/cli/sdk";

const ctx = makeContext("testnet");
const repos = await listRepos(ctx);
const result = await verifyRelease(ctx, releaseId);   // SLSA-style provenance check
console.log(result.level, result.steps);
```

(The package ships TypeScript and runs via `tsx`; import it from a `tsx`/bundler context.)

---

## Verify a release (SLSA-style)

`forge verify` (and the web **Verify** tab, and the MCP `release_verify` tool — three surfaces,
one read-only verifier) walks the provenance chain and re-checks it independently:

1. every blob is fetchable on Walrus,
2. the source manifest's `treeHash` recomputes from the actual files,
3. a merged, *reviewed* PR's head matches the released source.

So the code that was reviewed is provably the code that was released. It prints per-step PASS/FAIL
and a **SLSA-style level**: L1 (source+artifact) · L2 (+ signed review) · L3 (+ full chain
matches). No key, no account, no trust in us.

---

## Backend P0 services (optional)

All in `server/`, Node 18+, **accelerators not sources of truth** — reads/writes that matter stay
on Sui + Walrus, and the client degrades to the self-serve path if a service is absent.

### `server/llm-proxy` — build without an Anthropic key
Holds one key server-side, forwards `prompt → completion`. Model allowlist, `max_tokens` cap,
per-IP rate limit, CORS-locked.
```sh
cd server/llm-proxy && ANTHROPIC_API_KEY=sk-ant-... npm start   # :8787
```

### `server/sponsor` — act without SUI (gas-free)
Co-signs gas for **value-free** playground calls only (record_visit, star, flag, set_hidden,
claim_name, publish, update); rejects value-moving calls (tip/bounty/withdraw) and anything
off-package. Verified end-to-end on testnet (empty wallet acted on-chain; value-moving rejected).
```sh
cd server/sponsor && npm install
SPONSOR_PRIVATE_KEY=suiprivkey1... ALLOWED_PACKAGES=0x77dcd2cf... npm start   # :8788
```

### `server/salt` + `web/zklogin.js` — sign in with Google (no wallet)
Stateless salt = `HMAC(SALT_SECRET, iss|aud|sub)` after verifying the Google `id_token`
(RS256 vs JWKS, exp/iss/aud). The client runs the official Sui zkLogin flow (ephemeral key →
Google → salt → `jwtToAddress` → proof from a zk prover → `zkSignAndExecute`). With the sponsor:
**no wallet, no gas**.
```sh
cd server/salt && SALT_SECRET=<long-random> GOOGLE_CLIENT_ID=...apps.googleusercontent.com npm start  # :8789
```

### `server/portal` — human URLs + share cards
Serves each app at `/app/:id` and each builder at `/@handle` with **server-rendered Open Graph
meta** (link previews in chat apps & social — which a static SPA can't emit), re-verifying the
tree-hash against the chain on every request, with graceful expired-bytes handling. Also exposes
`GET /api/apps`. Network ids come from `deployments.json`.
```sh
cd server/portal && npm install && PUBLIC_ORIGIN=https://your.domain npm start   # :8790
```
Set the portal URL in Playground **settings** → 🔗 Share then emits `<portal>/app/<id>`.

Configure the URLs in Playground **settings**. To go live you provide the infra: host the
services, fund the sponsor wallet (keep it modest/rotatable), register a Google OAuth client.

---

## Why Sui + Walrus

- **Walrus** — durable, content-addressed storage for the bytes that matter (code, diffs, reports,
  artifacts, Playground apps) — far cheaper than on-chain.
- **Sui** — object-centric ownership, capability-based permissions and events: exactly the
  primitives a release-trust layer needs, with no custom DID/UCAN stack. **zkLogin** and
  **sponsored transactions** make it usable by people with no wallet and no gas. **Seal** gates
  decryption of private memory by the same caps.

---

## What makes it different

Both the release network and the app gallery are built so that **every claim is independently
verifiable** — provenance and metrics are on-chain artifacts, not a server's word:

- **Storage** — Walrus (erasure-coded, Sui-certified), not a centralized blob store.
- **Identity & permissions** — Sui object capabilities (`AgentCap`): scoped, expiring, revocable.
- **Trust anchor** — Sui objects + events; nothing depends on a server staying honest.
- **Release provenance** — a verifiable chain with a read-only `verify` (SLSA-style level).
- **Agent & builder trust** — on-chain scores + vouching + `BuilderBoard`, not off-chain gossip.
- **Private memory** — Seal-encrypted and gated by the same on-chain caps.
- **App gallery** — on-chain visits / stars / tips / remix lineage + moderation; unfakeable.
- **Onboarding** — zkLogin + sponsored tx + LLM proxy: usable with no wallet, no gas, no key.

---

## Who it's for

- **AI agents** — first-class actors. An agent holds its own key and a scoped, expiring,
  owner-revocable `AgentCap`, and acts through the MCP server. It can propose, review, run CI and
  publish Playground apps — but **never** merge or release.
- **Repo owners / developers** — create repos, grant/revoke agent caps, merge PRs and publish
  releases via the CLI (local keystore).
- **App builders (Playground)** — anyone: connect a wallet *or* sign in with Google (zkLogin),
  build an app, publish it, earn on-chain reputation and tips.
- **Verifiers (anyone)** — open the web dashboard or run `forge verify` to independently confirm
  any release's full provenance chain. No account, no trust in us.

---

## Tech stack

- **Contracts:** Sui Move (edition 2024), 7 modules, 53 tests; Seal access policy.
- **Storage:** Walrus (HTTP publisher/aggregator on testnet; `@mysten/walrus` SDK for owned blobs).
- **App layer:** TypeScript — CLI (commander), `@mysten/sui` SDK, MCP server (stdio), CI worker,
  optional SQLite indexer.
- **Web:** dependency-free static SPA — ES modules via esm.sh, `@mysten/sui@1.18.0`,
  `@mysten/wallet-standard`, `@mysten/walrus`, `@mysten/sui/zklogin`. No bundler, no build step.
- **Onboarding services:** Node 18+ (mostly dependency-free) — LLM proxy, sponsor, salt.
- **LLM:** Anthropic (BYOK in-browser, or via the hosted proxy).

---

## Security notes

- Generated apps render in a `sandbox="allow-scripts"` iframe (no `allow-same-origin`, no popups)
  with a strict CSP (`default-src 'none'`, `connect-src 'none'`) and meta-refresh stripping.
- Publish guards: 512 KB cap, ≤ 24 files, path sanitization (no traversal/absolute).
- The sponsor only co-signs value-free, allowlisted calls; value transfers are never sponsored.
- The salt service verifies the OIDC JWT before issuing a salt; `SALT_SECRET` is a master key.
- All user/LLM/on-chain text is escaped before rendering; toasts use `textContent`.

---

## Project status

- ✅ **Contracts** live on **testnet + mainnet** (incl. paid-fork + Seal private apps); 53/53 tests.
- ✅ **Playground** end-to-end: build → publish (free/paid) → gallery → remix/update/renew → tip →
  bounties → handles → profile → share/viewer.
- ✅ **Release network** + `verify` (3 surfaces) + MCP (16 tools) + CLI (14 commands).
- ✅ **Onboarding code** (LLM proxy, sponsor — E2E-tested on testnet; zkLogin + salt — salt
  unit-tested). Going live needs you to host the services + register a Google OAuth client + fund
  a sponsor wallet.
- ⚠️ A human-readable `*.wal.app` per-app URL needs a public portal / SuiNS (the verifiable
  viewer share-URL already works).

---

## Docs
- `server/*/README.md` — per-service setup for the onboarding accelerators.
