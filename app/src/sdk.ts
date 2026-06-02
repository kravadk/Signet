/**
 * Signet SDK — the programmatic surface over the on-chain release network
 * (Sui) and content storage (Walrus). Import it to read repos/PRs/releases,
 * verify a release's provenance chain, build/verify snapshots, and store/read
 * Walrus blobs — the same primitives the CLI and MCP server use.
 *
 *   import { verifyRelease, makeContext, listRepos } from "@signet/cli/sdk";
 *
 * (Consumed via tsx, a bundler, or after a build — the package ships TypeScript.)
 */

// ---- Context / deployment / signing ----
export {
  makeContext,
  makeContextWithKeypair,
  loadDeployment,
  loadKeypairFromKeystore,
  SCOPE_OPEN_PR,
  SCOPE_REVIEW,
} from "./lib/sui.js";
export type { Deployment, ForgeContext } from "./lib/sui.js";

// ---- High-level actions (reads + the shared provenance verifier) ----
export {
  verifyRelease,
  repoList,
  repoReadManifest,
  releaseRead,
  issueList,
  bountyList,
  agentReputation,
} from "./lib/actions.js";
export type { VerifyResult, VerifyStep } from "./lib/actions.js";

// ---- Direct on-chain reads ----
export {
  listRepos,
  getRepo,
  listReleases,
  getRelease,
  latestReleaseId,
  listIssues,
  getIssue,
  listBounties,
  getBounty,
  getReputation,
  fetchManifest,
} from "./lib/forge-read.js";
export type { Repo, PullRequest, Release, Issue, Bounty } from "./lib/forge-read.js";

// ---- Snapshots (build + verify the content tree-hash) ----
export {
  buildSnapshot,
  buildSnapshotFromMemory,
  parseManifest,
  verifyTreeHash,
  extractArchive,
  sha256,
} from "./lib/snapshot.js";
export type { Manifest, FileEntry } from "./lib/snapshot.js";

// ---- Walrus storage ----
export {
  storeBlob,
  storeBlobAuto,
  readBlob,
  readBlobText,
  blobUrl,
  walrusConfigFor,
} from "./lib/walrus.js";
export type { StoredBlob, WalrusConfig } from "./lib/walrus.js";
