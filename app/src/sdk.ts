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
  writePkg,
  postBountyV2,
  claimBounty,
  openDispute,
  resolveDispute,
  cancelExpired,
  closePr,
  transferObject,
  createPaymentRequest,
  payPaymentRequest,
  cancelPaymentRequest,
  SCOPE_OPEN_PR,
  SCOPE_REVIEW,
  SCOPE_RUN_CI,
  SCOPE_BITS,
  scopeNames,
  CAP_PRESETS,
} from "./lib/sui.js";
export type { Deployment, ForgeContext } from "./lib/sui.js";

// ---- High-level actions (reads + the shared provenance verifier) ----
export {
  verifyRelease,
  repoList,
  repoReadManifest,
  releaseRead,
  releaseAttestation,
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
  fileLeaf,
  computeMerkleRoot,
  merkleProof,
  verifyMerkleProof,
} from "./lib/snapshot.js";
export type { Manifest, FileEntry, MerkleProof } from "./lib/snapshot.js";

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

// ---- Memory/artifact records ----
export { artifactRecord, classifyArtifact } from "./lib/artifacts.js";
export type { ArtifactType, MemoryArtifact } from "./lib/artifacts.js";

// ---- Typed client facade ----
export {
  AgentClient,
  BountyClient,
  ForgeClient,
  IssueClient,
  PaymentClient,
  PlaygroundClient,
  ReleaseClient,
  signetClients,
  toSignetResult,
} from "./clients.js";
export type { ReadSource, ReverifyAnchor, SignetResult } from "./clients.js";
