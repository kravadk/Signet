# Signet — Function & API Reference

The canonical, exhaustive list of everything callable in Signet, by layer. The
on-chain Move package is the source of truth; the CLI, MCP server, SDK and web app
are surfaces over it; the backend services are optional accelerators.

- **Move package (testnet):** see `move/signet/deployments.json` (`latestPackageId`, v12).
- Layer map: **Move** (on-chain) → **SDK** (`app/src`) → **CLI** / **MCP** / **Web** (callers).
- Trust note: every write is a capability-checked Move call; every read is re-verifiable
  against Sui + Walrus. See [SECURITY.md](SECURITY.md) for invariants.

---

## 1. On-chain Move API (8 modules)

Listed as **actions** (entry / state-changing `public fun`) and **accessors** (read-only getters).
Upgrades are additive; `*_v2`/`*_v3` are newer variants kept alongside originals.

### `forge` — repositories & capabilities
- **Actions:** `create_repo` · `update_ref` · `set_min_approvals` · `grant_agent_cap` · `revoke_agent_cap` · `set_latest_release`
- **Guards:** `assert_owner` · `assert_agent_scope` · `assert_not_agent_merge` · `is_cap_revoked`
- **Accessors:** `repo_owner` · `repo_name` · `repo_count` · `current_snapshot` · `default_branch` · `ref_version` · `latest_release` · `min_approvals` · `owner_cap_repo` · `agent_cap_id` · `agent_cap_repo` · `agent_cap_scopes` · `scope_open_pr` · `scope_review` · `scope_run_ci`

### `pull_request` — PRs & reviews
- **Actions:** `open_pr_as_owner` · `open_pr_as_agent` · `submit_review_as_owner` · `submit_review_as_agent` · `merge_pr` · `close_pr`
- **Accessors:** `pr_repo` · `pr_author` · `pr_base` · `pr_head` · `pr_status` · `pr_approvals` · `pr_review_count` · `pr_diff_manifest` · `review_blob` · `review_reporter` · `review_verdict` · `status_open|merged|closed` · `verdict_approve|request_changes|comment`

### `release` — verifiable releases
- **Actions:** `publish_release` · `publish_release_v2` (direct merged-PR→release link) · `link_release` · `link_repo` · `link_merged_pr`
- **Accessors:** `release_repo` · `release_version` · `release_source` · `release_artifact` · `release_test_report` · `release_publisher`

### `issue` — issues & comments
- **Actions:** `open_issue` · `comment_issue` · `close_issue` · `close_issue_as_owner`
- **Accessors:** `issue_repo` · `issue_author` · `issue_title` · `issue_body` · `issue_status` · `issue_comment_count` · `comment_author` · `comment_body` · `comment_issue_id` · `status_open|closed`

### `bounty` — escrowed bounties & disputes
- **Actions:** `post_bounty` · `post_bounty_v2` (deadline + proof) · `claim_bounty` · `submit_bounty` · `approve_bounty` · `approve_bounty_v2` (fee→treasury) · `cancel_bounty` · `cancel_expired` · `open_dispute` · `resolve_dispute` · `resolve_dispute_v2` (partial payout)
- **Accessors:** `bounty_repo` · `bounty_funder` · `bounty_claimant` · `bounty_amount` · `bounty_escrow_value` · `bounty_min_score` · `bounty_proof` · `bounty_status` · `fee_bps` · `terms_bounty` · `terms_deadline_ms` · `terms_proof_required` · `dispute_opener` · `dispute_payout_bps` · `dispute_resolved` · `status_open|claimed|paid|disputed|cancelled`

### `payment` — payment requests / invoices (v12)
- **Actions:** `create_request` · `pay` (refunds overpayment) · `cancel`
- **Accessors:** `request_creator` · `request_recipient` · `request_payer` · `request_amount` · `request_label` · `request_paid` · `request_cancelled` · `request_created_at_ms` · `request_expires_at_ms`
- **Error codes:** `e_zero_amount` · `e_underpaid` · `e_already_closed` · `e_expired` · `e_not_controller`

### `reputation` — scores & SLA
- **Actions (`public(package)` — sibling modules only):** `bump_pr_opened` · `bump_pr_merged` · `bump_review` · `bump_ci_run` · `note_disputed` · `note_expired`
- **Public:** `vouch` · `create_reliability_ledger` · `new_ledger` · `share_ledger`
- **Accessors:** `score` · `score_of` · `profile` · `prs_opened` · `prs_merged` · `reviews` · `ci_runs` · `vouches` · `top_runner` · `reliability_of` · `rel_disputed` · `rel_expired` · `ledger_repo` · `last_epoch`

### `playground` — AI app gallery & economy
- **Publish/edit:** `publish_app` · `publish_app_v2` · `publish_remix_v3` · `update_app` · `update_app_v2`
- **Engagement/moderation:** `record_visit` · `star` · `star_v2` · `flag_app` · `set_hidden`
- **Economy:** `tip_app` · `tip_app_v2` · `post_app_bounty` · `award_app_bounty` · `cancel_app_bounty` · `set_fork_price` · `pay_to_fork` · `create_treasury` · `deposit_fee` · `withdraw_treasury`
- **Privacy/teams (Seal):** `set_private` · `invite_workspace_member` · `revoke_workspace_member` · `is_workspace_member` · `create_privacy_registry` · `create_workspace_registry` · `create_flag_registry` · `create_fork_registry` · `create_name_registry` · `create_builder_board` · `create_registry`
- **Handles:** `claim_name`
- **Accessors:** `builder` · `builder_apps` · `builder_remixes` · `builder_score` · `stars` · `visits` · `tips_total` · `flag_count` · `is_hidden` · `is_private` · `fork_price` · `parent` · `tree_hash` · `release_name` · `name_owner` · `name_of_owner` · `bounty_open|poster|reward|winner` · `treasury_admin` · `treasury_balance`

> `init_for_testing` (forge, playground) is `#[test_only]`.

---

## 2. CLI — `forge` / `signet` (24 commands)

`init` · `import` (GitHub→on-chain) · `push-snapshot` · `grant-agent` · `revoke-agent` ·
`open-pr` · `review` · `merge` · `close-pr` · `release` · `set-approvals` · `vouch` ·
`verify` · `prove-file` (per-file Merkle proof) · `attestation` (SLSA/in-toto) ·
`latest-release` · `status` · `doctor` · `renew` (re-pin Walrus) · `post-bounty-v2` ·
`claim-bounty` · `open-dispute` · `resolve-dispute` · `cancel-expired`

Run: `npm --prefix app run forge -- <command> [options]` (or the published `forge` bin).

---

## 3. MCP server — agent tools (22)

**Signet writes (scoped `AgentCap`):** `pr_create` · `review_submit` · `artifact_upload` ·
`issue_create` · `issue_comment` · `bounty_claim` · `bounty_submit` · `agent_vouch` · `app_publish`
**Signet reads:** `repo_list` · `repo_read_manifest` · `release_read` · `release_verify` ·
`issue_list` · `bounty_list` · `agent_reputation`
**Sui primitives:** `sui_balance` · `sui_object` · `sui_tx` (read/dry-run) · `sui_events` ·
`sui_faucet_testnet` · `signet_tool_manifest`

Value-moving tools support `dryRun` before signing. Start: `npm --prefix app run mcp`.

---

## 4. SDK — `@signet/cli/sdk`

- **Context/sign:** `makeContext` · `makeContextWithKeypair` · `loadDeployment` · `loadKeypairFromKeystore` · `writePkg`
- **Write builders:** `closePr` · `postBountyV2` · `claimBounty` · `openDispute` · `resolveDispute` · `cancelExpired` · `createPaymentRequest` · `payPaymentRequest` · `cancelPaymentRequest`
- **Scopes/presets:** `SCOPE_OPEN_PR` · `SCOPE_REVIEW` · `SCOPE_RUN_CI` · `SCOPE_BITS` · `scopeNames` · `CAP_PRESETS`
- **Reads + verify:** `verifyRelease` · `repoList` · `repoReadManifest` · `releaseRead` · `releaseAttestation` · `issueList` · `bountyList` · `agentReputation`
- **Direct reads:** `listRepos` · `getRepo` · `listReleases` · `getRelease` · `latestReleaseId` · `listIssues` · `getIssue` · `listBounties` · `getBounty` · `getReputation` · `fetchManifest`
- **Snapshots/Merkle:** `buildSnapshot` · `buildSnapshotFromMemory` · `parseManifest` · `verifyTreeHash` · `extractArchive` · `sha256` · `fileLeaf` · `computeMerkleRoot` · `merkleProof` · `verifyMerkleProof`
- **Walrus:** `storeBlob` · `storeBlobAuto` · `readBlob` · `readBlobText` · `blobUrl` · `walrusConfigFor`
- **Artifacts:** `artifactRecord` · `classifyArtifact`
- **Typed clients:** `ForgeClient` · `ReleaseClient` · `BountyClient` · `IssueClient` · `PaymentClient` · `PlaygroundClient` · `AgentClient` · `signetClients` · `toSignetResult`
- **Types:** `Deployment` · `ForgeContext` · `VerifyResult` · `VerifyStep` · `Repo` · `PullRequest` · `Release` · `Issue` · `Bounty` · `Manifest` · `FileEntry` · `MerkleProof` · `StoredBlob` · `WalrusConfig` · `ArtifactType` · `MemoryArtifact` · `ReadSource` · `ReverifyAnchor` · `SignetResult`

---

## 5. Web app (`/app`)

**Wallet-signed actions:** `actGrantAgent` · `actOpenIssue` · `actPostBounty` · `actMergePr` ·
`actClosePr` · `actSetApprovals` · `actVouch` · `actOpenDispute` · `actResolveDispute` ·
`actImportFromGitHub`
**Playground actions:** publish / `update_app(_v2)` / `publish_remix_v3` · star · tip · flag ·
set-hidden · set-private + workspace invite/revoke (Seal) · set-fork-price / pay-to-fork ·
post/award app-bounty · claim-name · **payment** create / pay / cancel · per-file **"⛓ prove"** (Merkle)
**Views:** Playground · Dashboard · Repositories · Pull Requests · Releases · Packages · Agents ·
Issues · Bounties · Payments · Activity · Verify · Trust · Walrus · MCP
**Read transport:** JSON-RPC (default) · GraphQL (`?graphql=1`) · gRPC (`?grpc=1`) — each degrades
honestly to JSON-RPC with a visible source badge.
**Onboarding:** wallet-standard connect · zkLogin (Google) · sponsored (gas-free) tx.

---

## 6. Backend services (optional accelerators) — endpoints

Each service is self-contained, env-tunable, and degrade-safe (the app works without them).

| Service | Routes |
| --- | --- |
| **gateway** (`server/src`, indexer) | `/verify` `/apps` `/agents` `/packages` `/bounties` `/payments` `/webhooks` `/api/schema` `/api/sync-report` `/api/status` `/status` `/metrics` `/health` `/api/health` |
| **sponsor** | `/sponsor` `/dashboard` `/health` |
| **salt** (zkLogin) | `/salt` `/metrics` `/health` |
| **portal** (human URLs/OG) | `/app/:id` `/@:handle` `/api/apps` `/status` `/metrics` `/health` |
| **importer** (GitHub) | `/import` `/metrics` `/health` |
| **llm-proxy** | `/llm` `/health` |

---

## 7. Operations & hardening (env-gated)

- **Rate limiting:** per-IP, `RATE_LIMIT_PER_MIN` (degrade-safe — disabled at `<=0`, only rejects over the limit). Active on gateway, sponsor, salt, portal, importer, llm-proxy.
- **Error tracking:** `captureError` — always logs; additionally POSTs to `ERROR_TRACKING_DSN` (alias `ERROR_DSN`/`SENTRY_DSN`) when set, else no-op.
- **Metrics:** Prometheus `/metrics` (`signet_*` counters + `signet_up`) on gateway, salt, portal, importer.
- **Health/status:** `/health` on every service; public `/status` on gateway + portal.
- **Headers (web):** CSP (report-only), HSTS, `X-Frame-Options: SAMEORIGIN`, `frame-ancestors 'self'`, `nosniff`, Referrer/Permissions-Policy — `web/vercel.json`.
- **CI gates:** Move tests, app typecheck+unit, server unit, Playwright e2e, coverage (c8), CodeQL, OpenSSF Scorecard, Dependabot.

---

For deeper docs: [README.md](README.md) (overview + run-it) · [SECURITY.md](SECURITY.md)
(invariants, threat model, disclosure).
