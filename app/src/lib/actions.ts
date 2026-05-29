/**
 * High-level WalrusForge actions, shared by the MCP server (and reusable by the
 * CLI). Each returns a plain structured object — no console output — so callers
 * decide how to present results. Composes the lib + read layers.
 */

import { storeBlob, blobUrl } from "./walrus.js";
import { buildSnapshotFromMemory } from "./snapshot.js";
import {
  type ForgeContext,
  openPrAsAgent,
  submitReviewAsAgent,
  openIssue,
  commentIssue,
  postBounty,
  claimBounty,
  submitBounty,
  createdOfType,
} from "./sui.js";
import {
  listRepos,
  getRepo,
  getRelease,
  fetchManifest,
  findReputationLedger,
  listIssues,
  listBounties,
  getReputation,
} from "./forge-read.js";

// Runtime clock — fine here (not inside a workflow script).
const nowMs = () => Date.now();

export interface FileInput {
  path: string;
  content: string;
}

// ===== Reads =====

export async function repoList() {
  const repos = await listRepos();
  return repos.map((r) => ({
    repoId: r.id,
    name: r.name,
    owner: r.owner,
    defaultBranch: r.defaultBranch,
    currentSnapshot: r.currentSnapshot,
    refVersion: r.refVersion,
    hasRelease: r.latestRelease !== null,
  }));
}

export async function repoReadManifest(args: { repoId: string }) {
  const repo = await getRepo(args.repoId);
  if (!repo) throw new Error(`Repository not found: ${args.repoId}`);
  const manifest = await fetchManifest(repo.currentSnapshot);
  return {
    name: repo.name,
    branch: repo.defaultBranch,
    refVersion: repo.refVersion,
    snapshotBlob: repo.currentSnapshot,
    snapshotBlobUrl: blobUrl(repo.currentSnapshot),
    treeHash: manifest?.treeHash ?? null,
    files: manifest?.files ?? [],
  };
}

export async function releaseRead(args: { releaseId: string }) {
  const rel = await getRelease(args.releaseId);
  if (!rel) throw new Error(`Release not found: ${args.releaseId}`);
  const sourceManifest = await fetchManifest(rel.sourceSnapshot);
  return {
    releaseId: rel.id,
    repoId: rel.repoId,
    version: rel.version,
    publishedBy: rel.publishedBy,
    chain: {
      source: {
        blob: rel.sourceSnapshot,
        url: blobUrl(rel.sourceSnapshot),
        files: sourceManifest?.files?.length ?? null,
      },
      artifact: { blob: rel.buildArtifact, url: blobUrl(rel.buildArtifact) },
      testReport: { blob: rel.testReport, url: blobUrl(rel.testReport) },
    },
  };
}

// ===== Writes (require an agent-signing context) =====

export async function prCreate(args: {
  ctx: ForgeContext;
  repoId: string;
  agentCapId: string;
  title: string;
  files: FileInput[];
}) {
  const repo = await getRepo(args.repoId);
  if (!repo) throw new Error(`Repository not found: ${args.repoId}`);
  const reputationId = await findReputationLedger(args.repoId);
  if (!reputationId) throw new Error(`Reputation ledger not found for repo ${args.repoId}`);

  const { archive, manifest } = buildSnapshotFromMemory({
    files: args.files,
    name: repo.name,
    branch: repo.defaultBranch,
    previousSnapshot: repo.currentSnapshot,
    nowEpochMs: nowMs(),
  });

  const archiveBlob = await storeBlob(archive);
  const manifestBlob = await storeBlob(
    JSON.stringify({ ...manifest, archiveBlob: archiveBlob.blobId }),
  );

  const res = await openPrAsAgent(args.ctx, {
    repoId: args.repoId,
    reputationId,
    agentCapId: args.agentCapId,
    headSnapshot: manifestBlob.blobId,
    diffManifest: manifestBlob.blobId,
    title: args.title,
  });
  const prId = createdOfType(res, "::pull_request::PullRequest")[0];

  return {
    prId,
    headBlob: manifestBlob.blobId,
    headUrl: blobUrl(manifestBlob.blobId),
    txDigest: res.digest,
  };
}

export async function reviewSubmit(args: {
  ctx: ForgeContext;
  repoId: string;
  prId: string;
  agentCapId: string;
  verdict: number; // 1 approve, 2 request-changes, 3 comment
  reportText: string;
}) {
  const reportBlob = await storeBlob(args.reportText);
  const reputationId = await findReputationLedger(args.repoId);
  if (!reputationId) throw new Error(`Reputation ledger not found for repo ${args.repoId}`);
  const res = await submitReviewAsAgent(args.ctx, {
    repoId: args.repoId,
    reputationId,
    prId: args.prId,
    agentCapId: args.agentCapId,
    verdict: args.verdict,
    reportBlob: reportBlob.blobId,
  });
  return {
    reviewBlob: reportBlob.blobId,
    reviewUrl: blobUrl(reportBlob.blobId),
    txDigest: res.digest,
  };
}

export async function artifactUpload(args: { content: string }) {
  const blob = await storeBlob(args.content);
  return { blobId: blob.blobId, url: blobUrl(blob.blobId) };
}

// ===== Issues =====

export async function issueList(args: { repoId: string }) {
  const issues = await listIssues(args.repoId);
  return issues.map((i) => ({
    issueId: i.id,
    author: i.author,
    title: i.title,
    status: i.status === 0 ? "open" : "closed",
    comments: i.commentCount,
  }));
}

export async function issueCreate(args: {
  ctx: ForgeContext;
  repoId: string;
  title: string;
  body: string;
}) {
  const bodyBlob = await storeBlob(args.body);
  const res = await openIssue(args.ctx, { repoId: args.repoId, title: args.title, bodyBlob: bodyBlob.blobId });
  const issueId = createdOfType(res, "::issue::Issue")[0];
  return { issueId, bodyBlob: bodyBlob.blobId, txDigest: res.digest };
}

export async function issueComment(args: {
  ctx: ForgeContext;
  issueId: string;
  body: string;
}) {
  const bodyBlob = await storeBlob(args.body);
  const res = await commentIssue(args.ctx, { issueId: args.issueId, bodyBlob: bodyBlob.blobId });
  return { bodyBlob: bodyBlob.blobId, txDigest: res.digest };
}

// ===== Bounties =====

export async function bountyList(args: { repoId: string }) {
  const bounties = await listBounties(args.repoId);
  const label = ["open", "claimed", "paid", "cancelled"];
  return bounties.map((b) => ({
    bountyId: b.id,
    funder: b.funder,
    title: b.title,
    amountMist: b.amount,
    status: label[b.status] ?? "unknown",
    claimant: b.claimant,
  }));
}

export async function bountyClaim(args: { ctx: ForgeContext; bountyId: string }) {
  const res = await claimBounty(args.ctx, { bountyId: args.bountyId });
  return { txDigest: res.digest };
}

export async function bountySubmit(args: {
  ctx: ForgeContext;
  bountyId: string;
  proof: string;
}) {
  const res = await submitBounty(args.ctx, { bountyId: args.bountyId, proof: args.proof });
  return { txDigest: res.digest };
}

export async function bountyPost(args: {
  ctx: ForgeContext;
  repoId: string;
  title: string;
  amountMist: number;
}) {
  const res = await postBounty(args.ctx, {
    repoId: args.repoId,
    title: args.title,
    amountMist: args.amountMist,
  });
  const bountyId = createdOfType(res, "::bounty::Bounty")[0];
  return { bountyId, txDigest: res.digest };
}

// ===== Reputation =====

export async function agentReputation(args: { repoId: string; agent: string }) {
  const rep = await getReputation(args.repoId, args.agent);
  return { repoId: args.repoId, agent: args.agent, ...rep };
}
