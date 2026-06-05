# Self-Audit Checklist

| Threat | Mitigation | Test | Residual risk |
| --- | --- | --- | --- |
| Unauthorized repo mutation | `RepoOwnerCap` and scoped `AgentCap` checks | Move tests for owner, revoked, expired and missing-scope caps | Compromised owner key can still act |
| Stale PR merge | Base snapshot equality check before merge | Stale merge Move tests and release verification tests | Off-chain UI must surface stale state clearly |
| Low-quality bounty claim | Minimum score and proof/deadline terms | Bounty score, proof and payout tests | Human funder arbitration remains subjective |
| Fake release provenance | Release v2 direct `merged_pr_id` plus fallback verification | CLI, web and MCP verify tests | Cached gateway data must be reverified |
| Private app data leak | Seal-encrypted archives and owner/member policy checks | Workspace invite/revoke tests and private app e2e | Browser-side decrypted content is visible to authorized users |
| Sponsor abuse | Package/function allowlist, per-IP/wallet/function quotas and daily gas cap | Sponsor unit tests including IP and wallet limits | Distributed abuse can still exhaust budget |
| RPC/indexer drift | Cursor-per-module backfill, sync reports and reverify anchors | Indexer dry-run and RPC outage e2e | Public RPC outages delay UX |
| Webhook spoofing | HMAC signature when a webhook secret is set | Delivery code signs payloads | Receivers must validate signatures |
| XSS in generated apps | Sandboxed iframe and CSP on previews/viewer | Portal inliner tests and e2e smoke | User-generated HTML remains untrusted content |
| Mainnet misconfiguration | Mainnet runbook, readiness check and no implicit deploy in CI | `scripts/mainnet-readiness-check.mjs` | Human approval process must be followed |

