/**
 * Read layer for WalrusForge (CLI/MCP side).
 *
 * Lists and fetches on-chain objects (repos, PRs, releases) by scanning package
 * events, and pulls the referenced Walrus blobs. Mirrors web/src/lib/forge.ts so
 * the `app` package is self-contained. Read-only: no signing, no writes.
 */

import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import { loadDeployment } from "./sui.js";
import { readBlobText, blobUrl } from "./walrus.js";
import { parseManifest, type Manifest } from "./snapshot.js";

const deployment = loadDeployment("testnet");
const PACKAGE = deployment.packageId;
const client = new SuiClient({ url: getFullnodeUrl("testnet") });

export interface Repo {
  id: string;
  name: string;
  owner: string;
  defaultBranch: string;
  currentSnapshot: string;
  refVersion: number;
  latestRelease: string | null;
}

export interface PullRequest {
  id: string;
  repoId: string;
  author: string;
  baseSnapshot: string;
  headSnapshot: string;
  diffManifest: string;
  title: string;
  status: number;
  reviewRefs: string[];
}

export interface Release {
  id: string;
  repoId: string;
  version: string;
  sourceSnapshot: string;
  buildArtifact: string;
  testReport: string;
  publishedBy: string;
}

function fields(obj: any): any {
  return obj?.data?.content?.fields ?? {};
}

export async function getRepo(id: string): Promise<Repo | null> {
  const obj = await client.getObject({ id, options: { showContent: true } });
  const f = fields(obj);
  if (!f.name) return null;
  return {
    id,
    name: f.name,
    owner: f.owner,
    defaultBranch: f.default_branch,
    currentSnapshot: f.current_snapshot,
    refVersion: Number(f.ref_version),
    latestRelease: f.latest_release ?? null,
  };
}

export async function listRepos(limit = 50): Promise<Repo[]> {
  const events = await client.queryEvents({
    query: { MoveEventType: `${PACKAGE}::forge::RepoCreated` },
    limit,
    order: "descending",
  });
  const ids = events.data
    .map((e) => (e.parsedJson as any)?.repo_id)
    .filter(Boolean) as string[];
  const repos = await Promise.all(ids.map((id) => getRepo(id).catch(() => null)));
  return repos.filter((r): r is Repo => r !== null);
}

export async function getPullRequest(id: string): Promise<PullRequest | null> {
  const obj = await client.getObject({ id, options: { showContent: true } });
  const f = fields(obj);
  if (!f.title && !f.repo_id) return null;
  return {
    id,
    repoId: f.repo_id,
    author: f.author,
    baseSnapshot: f.base_snapshot,
    headSnapshot: f.head_snapshot,
    diffManifest: f.diff_manifest,
    title: f.title,
    status: Number(f.status),
    reviewRefs: f.review_refs ?? [],
  };
}

export async function getRelease(id: string): Promise<Release | null> {
  const obj = await client.getObject({ id, options: { showContent: true } });
  const f = fields(obj);
  if (!f.version) return null;
  return {
    id,
    repoId: f.repo_id,
    version: f.version,
    sourceSnapshot: f.source_snapshot,
    buildArtifact: f.build_artifact,
    testReport: f.test_report,
    publishedBy: f.published_by,
  };
}

/** List releases for a repo by scanning ReleasePublished events. */
export async function listReleases(repoId: string, limit = 50): Promise<Release[]> {
  const events = await client.queryEvents({
    query: { MoveEventType: `${PACKAGE}::release::ReleasePublished` },
    limit,
    order: "descending",
  });
  const ids = events.data
    .filter((e) => (e.parsedJson as any)?.repo_id === repoId)
    .map((e) => (e.parsedJson as any)?.release_id)
    .filter(Boolean) as string[];
  const releases = await Promise.all(ids.map((id) => getRelease(id).catch(() => null)));
  return releases.filter((r): r is Release => r !== null);
}

export interface Issue {
  id: string;
  repoId: string;
  author: string;
  title: string;
  bodyBlob: string;
  status: number;
  commentCount: number;
}

export interface Bounty {
  id: string;
  repoId: string;
  funder: string;
  title: string;
  amount: number;
  escrow: number;
  status: number;
  claimant: string | null;
  proof: string | null;
}

export async function listIssues(repoId: string, limit = 50): Promise<Issue[]> {
  const events = await client.queryEvents({
    query: { MoveEventType: `${PACKAGE}::issue::IssueOpened` },
    limit,
    order: "descending",
  });
  const ids = events.data
    .filter((e) => (e.parsedJson as any)?.repo_id === repoId)
    .map((e) => (e.parsedJson as any)?.issue_id)
    .filter(Boolean) as string[];
  const issues = await Promise.all(ids.map((id) => getIssue(id).catch(() => null)));
  return issues.filter((i): i is Issue => i !== null);
}

export async function getIssue(id: string): Promise<Issue | null> {
  const obj = await client.getObject({ id, options: { showContent: true } });
  const f = fields(obj);
  if (!f.title && !f.repo_id) return null;
  return {
    id,
    repoId: f.repo_id,
    author: f.author,
    title: f.title,
    bodyBlob: f.body_blob,
    status: Number(f.status),
    commentCount: Number(f.comment_count),
  };
}

export async function listBounties(repoId: string, limit = 50): Promise<Bounty[]> {
  const events = await client.queryEvents({
    query: { MoveEventType: `${PACKAGE}::bounty::BountyPosted` },
    limit,
    order: "descending",
  });
  const ids = events.data
    .filter((e) => (e.parsedJson as any)?.repo_id === repoId)
    .map((e) => (e.parsedJson as any)?.bounty_id)
    .filter(Boolean) as string[];
  const bounties = await Promise.all(ids.map((id) => getBounty(id).catch(() => null)));
  return bounties.filter((b): b is Bounty => b !== null);
}

export async function getBounty(id: string): Promise<Bounty | null> {
  const obj = await client.getObject({ id, options: { showContent: true } });
  const f = fields(obj);
  if (f.amount === undefined) return null;
  const claimant = f.claimant?.fields?.vec?.[0] ?? f.claimant ?? null;
  const proof = f.proof?.fields?.vec?.[0] ?? f.proof ?? null;
  return {
    id,
    repoId: f.repo_id,
    funder: f.funder,
    title: f.title,
    amount: Number(f.amount),
    escrow: Number(f.escrow),
    status: Number(f.status),
    claimant: typeof claimant === "string" ? claimant : null,
    proof: typeof proof === "string" ? proof : null,
  };
}

export async function fetchManifest(blobId: string): Promise<Manifest | null> {
  try {
    const text = await readBlobText(blobId);
    return parseManifest(text);
  } catch {
    return null;
  }
}

/**
 * Find the shared RepoReputation ledger id for a repo. It is created in the same
 * tx as the repo (RepoCreated event), so we read that tx's object changes.
 */
export async function findReputationLedger(repoId: string): Promise<string | null> {
  const events = await client.queryEvents({
    query: { MoveEventType: `${PACKAGE}::forge::RepoCreated` },
    limit: 100,
    order: "descending",
  });
  const ev = events.data.find((e) => (e.parsedJson as any)?.repo_id === repoId);
  if (!ev) return null;
  const digest = ev.id.txDigest;
  const tx = await client.getTransactionBlock({ digest, options: { showObjectChanges: true } });
  const change = (tx.objectChanges ?? []).find(
    (o: any) => o.type === "created" && String(o.objectType).endsWith("::reputation::RepoReputation"),
  );
  return change ? (change as any).objectId : null;
}

export async function getReputation(repoId: string, agent: string) {
  const ledgerId = await findReputationLedger(repoId);
  if (!ledgerId) return null;
  // Reputation is event-derived; sum ReputationUpdated for this agent (latest wins).
  const events = await client.queryEvents({
    query: { MoveEventType: `${PACKAGE}::reputation::ReputationUpdated` },
    limit: 200,
    order: "descending",
  });
  const latest = events.data
    .map((e) => e.parsedJson as any)
    .find((p) => p?.repo_id === repoId && p?.agent === agent);
  if (!latest) return { prsOpened: 0, prsMerged: 0, reviews: 0, ciRuns: 0 };
  return {
    prsOpened: Number(latest.prs_opened),
    prsMerged: Number(latest.prs_merged),
    reviews: Number(latest.reviews),
    ciRuns: Number(latest.ci_runs),
  };
}

export { blobUrl };
