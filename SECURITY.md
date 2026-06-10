# Security Policy

Signet is a **trust layer** — verifiable agent work, releases, reputation, bounties and
payments on Sui + Walrus. Because trust *is* the product, this document states the security
model, the invariants each on-chain module enforces, the known risks, and how to report a
vulnerability. It is written to be audit-ready: an external reviewer should be able to read
this file and the `move/signet/sources/*.move` modules side by side.

---

## Reporting a Vulnerability

**Do not open a public issue for an undisclosed vulnerability.**

- Preferred: GitHub private vulnerability reporting (Security → *Report a vulnerability*).
- Email: `kravchukdima159@gmail.com` (maintainer `kravadk`).

Please include: affected component + version/tag (Move package id or commit), reproduction or
proof of concept, impact/exploitability, and a suggested mitigation if known.

### Coordinated disclosure timeline (targets)

- Acknowledgement within **3 business days**
- Initial triage within **7 calendar days**
- Status updates at least every **14 calendar days** until resolved
- Public disclosure after a fix ships, or by coordinated agreement with the reporter

---

## Scope

In scope:

- The Move package `move/signet/sources/*.move` (testnet package — see `move/signet/deployments.json`).
- The CLI / SDK / MCP server under `app/` (key handling, transaction building, verification).
- The static web app under `web/` (transaction building, read adapters, wallet handling).
- Backend services under `server/` (gateway, sponsor, salt, portal, importer) — input handling,
  SSRF, secret handling, webhook signing.

Out of scope: third-party infrastructure (Sui fullnodes, Walrus aggregators/publishers, RPC
providers), the underlying Sui/Move runtime, and any deployment using a key not controlled by
this project.

---

## On-chain invariants (per module)

These are the properties each module is designed to enforce. Move's resource model and the
capability pattern are the primary controls; abort codes are the enforcement points.

### `forge` — repositories & capabilities
- **Owner authority** is a `RepoOwnerCap` object, not an address list. `assert_owner` checks the
  cap belongs to the repo.
- **Agents are scoped, expiring capabilities.** `AgentCap` carries a scope bitmask
  (`open_pr` / `review` / `run_ci`) and an expiry; `assert_agent_scope` rejects out-of-scope or
  revoked/expired caps. `revoke_agent_cap` flips a revoked flag checked by `is_cap_revoked`.
- **Agents can never merge.** `assert_not_agent_merge` blocks merge by an agent cap regardless of
  scope — merge is owner-only by construction.

### `pull_request` — PRs & reviews
- **Stale-base guard:** a PR records its base snapshot; merge advances the repo ref. State is a
  status enum (`open` / `merged` / `closed`); `merge_pr`/`close_pr` assert `status == open`.
- **Review verdicts are typed** (approve / request_changes / comment) and reference a Walrus blob
  (`review_blob`) — reviews are content-addressed, not free text on-chain.
- **Approval threshold** (`min_approvals`, owner-set) is enforced before a merge is meaningful.

### `release` — verifiable releases
- A release links repo + merged PR + source snapshot + artifact + test report. The
  **provenance chain** (repo → PR → reviews/CI → release) is reconstructable on-chain and
  re-verifiable off-chain (`forge verify`, Merkle inclusion proofs over the source manifest).

### `bounty` — escrowed bounties & disputes
- **Escrow safety:** funds are held in the `Bounty` object. Payout transfers the **exact** amount
  to the claimant; the remainder is refunded to the funder; the protocol fee goes to the treasury.
- **State guards:** abort on operations against a bounty in the wrong state
  (`status_open/claimed/paid/disputed/cancelled`); `cancel_expired` only after the deadline.
- **Disputes** (`open_dispute` → `resolve_dispute_v2`) split escrow by `payout_bps` (0–10000),
  bounded, with the fee routed to treasury and the rest refunded — no path mints or double-spends.

### `payment` — payment requests (v12)
- **Escrow correctness:** `pay` requires `paid_amount >= amount` (`e_underpaid`), transfers the
  exact `amount` to the recipient, and **refunds any overpayment** to the payer.
- **State guards:** `e_already_closed` (no double-pay / pay-after-cancel), `e_expired` (deadline),
  `e_not_controller` (only creator cancels), `e_zero_amount` (no zero-value requests).

### `reputation` — scores & SLA
- **Bump-only, package-gated:** score mutators are `public(package)` — only sibling Signet modules
  (on real PR/review/CI/merge events) can bump them; no external direct writes.
- `ReliabilityLedger` records disputed/expired outcomes (`note_disputed`/`note_expired`) so SLA
  (`reliability_of`) reflects real failures, not just successes.

### `playground` — apps & economy
- Tips/forks/bounties move coins through escrow with the same exact-transfer + refund discipline.
- Private apps use **Seal** (`seal_approve_app_owner`/`seal_approve_app_member`) for access control;
  membership is an on-chain workspace registry.

### `governance` — autonomous Treasury spending (live on testnet in v13)
- **No back-door spend.** `playground::pay_from_treasury` is `public(package)`, so only in-package
  governance logic can disburse treasury funds; no external caller can. The admin `withdraw_treasury`
  stays a separate owner-only path (the admin may renounce to leave governance as the sole route).
- **Vote integrity:** one vote per address (`VecSet` of voters), weight = on-chain `builder_score`;
  zero-score addresses cannot vote; votes only count before `voting_ends_ms`.
- **Timelock + quorum + binding:** `execute` aborts before `voting_ends_ms + timelock_ms`, below
  `QUORUM`, or against a different Treasury than the proposal's `treasury_id`. `execute` is a
  permissionless crank — anyone can settle a passed/failed proposal; there is no privileged executor.

### `subscription` — recurring & streaming payments (live on testnet in v13)
- **Exact funding + refund:** `create_subscription` requires `funded >= amount_per_period * periods`
  and refunds overpayment to the payer (mirrors `payment`); a stream escrows its full amount up front.
- **Time-gated, payee-only claims:** `claim_due` pays only matured periods
  (`now >= next_claim_at_ms + k·period_ms`); `claim_stream` releases `total·elapsed/duration − claimed`
  (u128 intermediate, capped at total).
- **Cancellation conserves value:** cancelling a subscription refunds all unclaimed escrow to the
  payer; cancelling a stream pays the payee everything vested-but-unclaimed and refunds the remainder.

### Upgrade model
- **Additive upgrades only** (`v1 → v12`): new modules/functions, no breaking changes to existing
  storage or signatures. Clients resolve `latestPackageId`; old objects remain readable.
- Trade-off vs. a version-gating model (e.g. Magma's `ErrPackageVersionDeprecated`): Signet does
  **not** abort calls to superseded package versions on-chain. This keeps old objects usable and
  upgrades non-breaking; the cost is that a client could deliberately target an old version. Reads
  always resolve the latest package; writes are routed to it by `writePkg()`.

---

## Capability-scope matrix

| Action                    | Anyone | `AgentCap` (scoped) | `RepoOwnerCap` |
| ------------------------- | :----: | :-----------------: | :------------: |
| Read repos/PRs/releases   |   yes  |        yes          |      yes       |
| Open PR                   |   no   |  yes (`open_pr`)    |      yes       |
| Submit review             |   no   |  yes (`review`)     |      yes       |
| Run CI / post report      |   no   |  yes (`run_ci`)     |      yes       |
| **Merge PR**              |   no   |  **never**          |      yes       |
| Close PR / set approvals  |   no   |        no           |      yes       |
| Grant / revoke agent cap  |   no   |        no           |      yes       |
| Publish release           |   no   |        no           |      yes       |
| Resolve dispute           |   no   |        no           | yes (repo owner)|

---

## Repository ownership & protection model

What protects an imported/created repo, and what does not:

- **Write authority is capability-gated, on-chain.** Only the holder of that repo's
  `RepoOwnerCap` can `update_ref` / `merge_pr` / `close_pr` / `set_min_approvals` /
  grant·revoke agent caps / `publish_release`. No address without the cap can mutate the
  repo. Agents act only via a scoped, expiring `AgentCap` and **can never merge or release**.
- **Integrity is tamper-evident.** Every snapshot is content-addressed (SHA-256 tree-hash +
  Merkle root); any change to the anchored source is detectable by re-verification.
- **Source is public, not confidential.** The snapshot lives in public Walrus and the manifest
  is on-chain — anyone can read the code by blob id. This is by design (provenance must be
  independently verifiable). Private repos would require a separate Seal-encryption flow
  (currently only Playground apps support private mode).
- **`RepoOwnerCap` is `key + store` → transferable.** Ownership can be rotated to a clean key
  or, recommended for any real deployment, a **multisig** address with **no contract change**
  (`forge transfer-owner --to <addr>`). This is how to make control "not depend on one key":
  hold the cap (and the package `UpgradeCap`) in a k-of-n Sui multisig so a single compromised
  key cannot take over.

**Self-custody caveat:** a dApp cannot make an arbitrary user's key unhackable — each repo's
owner is responsible for the key/multisig that holds its `RepoOwnerCap`. Signet provides the
capability model, tamper-evidence, and the transfer/rotate path; key custody is the owner's.
There is **no** in-contract DAO/timelock over **repo ownership or recovery** — that would add audit
surface and UX cost without proportionate benefit; robustness there comes from multisig custody. (The
opt-in `governance` module *does* add reputation-weighted voting + a timelock, but only over
**Treasury spending** — an economic path — never over a repo's owner cap.)

---

## Known risks & mitigations

1. **Compromised deployer key (testnet + mainnet).** The deployer key `0x9de8…dea2` holds **both**
   the testnet `UpgradeCap` (`0x699b…`) and the mainnet `UpgradeCap` (`0xdfb585…`) and is considered
   compromised. It has been used for manual, gated package upgrades on both networks (incl. the v13
   upgrade adding `governance` + `subscription`). **The outstanding hardening step is to transfer
   both `UpgradeCap`s (and the admin/registry objects) to a fresh key or a k-of-n multisig**
   (`forge transfer-owner` / `sui client transfer` of the cap) — until then, anyone holding the
   leaked key can upgrade or take over the packages. **Mainnet must not be treated as production
   until the cap is rotated.** All deploy/upgrade actions remain manual and gated — never automated.
2. **CI release signing.** Releases are currently signed with a project key. A keyless / remote-signer
   model (cf. zktx-io GitSigner, Sigstore) is the intended hardening so no private key sits in CI.
3. **gRPC read transport.** The web read adapter attempts a real `@mysten/sui` gRPC read and falls
   back to JSON-RPC on failure, reporting the **actual** error (no silent or faked transport). The
   gRPC Core API has no event query, so events always read over JSON-RPC even in gRPC mode.
4. **Off-chain services are accelerators, not trust roots.** The gateway/indexer/sponsor/importer
   speed up reads and onboarding but are never authoritative — every claim is re-verifiable directly
   against Sui + Walrus. The importer enforces an SSRF allow-list on clone URLs.
5. **Secrets.** `.env`, `app/.agent.env` and keystores are git-ignored; only `.example` placeholders
   are committed. No `suiprivkey1…` material is ever committed.

---

## Test & verification coverage

- **Move unit tests:** 80/80 passing (`sui move test --path move/signet`) — incl. `governance` and `subscription` (live on testnet in v13).
- **TS unit tests:** 17/17 (`npm --prefix app test`) incl. snapshot tree-hash + Merkle proofs.
- **On-chain e2e (real testnet key):** 18/18 (`app/scripts/e2e-onchain.mjs`) — full chain
  init → grant-agent → PR → review → merge → release → verify → bounty → dispute → reliability →
  payment create/pay.
- **Browser e2e:** Playwright (chromium + mobile) with a mock wallet and RPC interception.
- **Independent verification:** anyone can re-check a release with `forge verify`, per-file Merkle
  inclusion proofs, and the on-chain provenance chain — no trust in this project required.

---

## Supported versions

Pre-1.0, testnet. Security fixes target the latest `master` and the latest deployed Move package
recorded in `move/signet/deployments.json`. Older package versions remain readable but are not
separately patched.
