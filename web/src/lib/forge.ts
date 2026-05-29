/**
 * WalrusForge read layer for the web UI.
 *
 * Reads live on-chain objects from Sui testnet and fetches the referenced
 * Walrus blobs. Everything the UI shows is real: repo refs, PRs, reviews and
 * the release provenance chain all come from the deployed package + Walrus.
 */

import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";

export const DEPLOYMENT = {
  network: "testnet" as const,
  packageId: "0x654fe8dd914bc440af0576e0d28d48e0c883ec9616f311f92571ec44dad71a8d",
  forgeRegistry: "0x4e4bc674d6c77acb27dfa07ab255d04eb6b31d34009f8ccd2309766f8286bb3b",
};

export const WALRUS = {
  aggregator: "https://aggregator.walrus-testnet.walrus.space",
};

export const suiClient = new SuiClient({ url: getFullnodeUrl(DEPLOYMENT.network) });

export const explorerObject = (id: string) =>
  `https://suiscan.xyz/testnet/object/${id}`;
export const explorerTx = (digest: string) =>
  `https://suiscan.xyz/testnet/tx/${digest}`;
export const blobUrl = (blobId: string) => `${WALRUS.aggregator}/v1/blobs/${blobId}`;

// ===== Types =====

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
  status: number; // 0 open, 1 merged, 2 closed
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

export interface Manifest {
  name: string;
  branch: string;
  createdAtEpochMs: number;
  previousSnapshot: string | null;
  files: { path: string; sha256: string; size: number }[];
  treeHash: string;
  archiveBlob?: string;
}

const STATUS_LABEL = ["open", "merged", "closed"];
export const prStatusLabel = (s: number) => STATUS_LABEL[s] ?? "unknown";

// ===== On-chain reads =====

function f(obj: any): any {
  return obj?.data?.content?.fields ?? {};
}

export async function getRepo(id: string): Promise<Repo | null> {
  const obj = await suiClient.getObject({ id, options: { showContent: true } });
  const fields = f(obj);
  if (!fields.name) return null;
  return {
    id,
    name: fields.name,
    owner: fields.owner,
    defaultBranch: fields.default_branch,
    currentSnapshot: fields.current_snapshot,
    refVersion: Number(fields.ref_version),
    latestRelease: fields.latest_release ?? null,
  };
}

/** List repos by scanning RepoCreated events from the package. */
export async function listRepos(limit = 50): Promise<Repo[]> {
  const events = await suiClient.queryEvents({
    query: { MoveEventType: `${DEPLOYMENT.packageId}::forge::RepoCreated` },
    limit,
    order: "descending",
  });
  const ids = events.data
    .map((e) => (e.parsedJson as any)?.repo_id)
    .filter(Boolean) as string[];
  const repos = await Promise.all(ids.map((id) => getRepo(id).catch(() => null)));
  return repos.filter((r): r is Repo => r !== null);
}

/** List PRs for a repo by scanning PrOpened events. */
export async function listPullRequests(repoId: string, limit = 50): Promise<PullRequest[]> {
  const events = await suiClient.queryEvents({
    query: { MoveEventType: `${DEPLOYMENT.packageId}::pull_request::PrOpened` },
    limit,
    order: "descending",
  });
  const ids = events.data
    .filter((e) => (e.parsedJson as any)?.repo_id === repoId)
    .map((e) => (e.parsedJson as any)?.pr_id)
    .filter(Boolean) as string[];
  const prs = await Promise.all(ids.map((id) => getPullRequest(id).catch(() => null)));
  return prs.filter((p): p is PullRequest => p !== null);
}

export async function getPullRequest(id: string): Promise<PullRequest | null> {
  const obj = await suiClient.getObject({ id, options: { showContent: true } });
  const fields = f(obj);
  if (!fields.title && !fields.repo_id) return null;
  return {
    id,
    repoId: fields.repo_id,
    author: fields.author,
    baseSnapshot: fields.base_snapshot,
    headSnapshot: fields.head_snapshot,
    diffManifest: fields.diff_manifest,
    title: fields.title,
    status: Number(fields.status),
    reviewRefs: fields.review_refs ?? [],
  };
}

export async function getRelease(id: string): Promise<Release | null> {
  const obj = await suiClient.getObject({ id, options: { showContent: true } });
  const fields = f(obj);
  if (!fields.version) return null;
  return {
    id,
    repoId: fields.repo_id,
    version: fields.version,
    sourceSnapshot: fields.source_snapshot,
    buildArtifact: fields.build_artifact,
    testReport: fields.test_report,
    publishedBy: fields.published_by,
  };
}

// ===== Issues / bounties / reputation / activity (event-scanned, no backend) =====

export interface Issue {
  id: string; repoId: string; author: string; title: string;
  bodyBlob: string; status: number; commentCount: number;
}
export interface Bounty {
  id: string; repoId: string; funder: string; title: string;
  amount: number; status: number; claimant: string | null;
}

export async function getIssue(id: string): Promise<Issue | null> {
  const obj = await suiClient.getObject({ id, options: { showContent: true } });
  const x = (obj.data?.content as any)?.fields ?? {};
  if (!x.title && !x.repo_id) return null;
  return {
    id, repoId: x.repo_id, author: x.author, title: x.title,
    bodyBlob: x.body_blob, status: Number(x.status), commentCount: Number(x.comment_count),
  };
}

export async function listIssues(repoId: string, limit = 50): Promise<Issue[]> {
  const ev = await suiClient.queryEvents({
    query: { MoveEventType: `${DEPLOYMENT.packageId}::issue::IssueOpened` },
    limit, order: "descending",
  });
  const ids = ev.data.filter((e) => (e.parsedJson as any)?.repo_id === repoId)
    .map((e) => (e.parsedJson as any)?.issue_id).filter(Boolean) as string[];
  const rows = await Promise.all(ids.map((i) => getIssue(i).catch(() => null)));
  return rows.filter((r): r is Issue => r !== null);
}

export async function getBounty(id: string): Promise<Bounty | null> {
  const obj = await suiClient.getObject({ id, options: { showContent: true } });
  const x = (obj.data?.content as any)?.fields ?? {};
  if (x.amount === undefined) return null;
  const claimant = x.claimant?.fields?.vec?.[0] ?? x.claimant ?? null;
  return {
    id, repoId: x.repo_id, funder: x.funder, title: x.title,
    amount: Number(x.amount), status: Number(x.status),
    claimant: typeof claimant === "string" ? claimant : null,
  };
}

export async function listBounties(repoId: string, limit = 50): Promise<Bounty[]> {
  const ev = await suiClient.queryEvents({
    query: { MoveEventType: `${DEPLOYMENT.packageId}::bounty::BountyPosted` },
    limit, order: "descending",
  });
  const ids = ev.data.filter((e) => (e.parsedJson as any)?.repo_id === repoId)
    .map((e) => (e.parsedJson as any)?.bounty_id).filter(Boolean) as string[];
  const rows = await Promise.all(ids.map((i) => getBounty(i).catch(() => null)));
  return rows.filter((r): r is Bounty => r !== null);
}

export async function listReleases(repoId: string, limit = 50): Promise<Release[]> {
  const ev = await suiClient.queryEvents({
    query: { MoveEventType: `${DEPLOYMENT.packageId}::release::ReleasePublished` },
    limit, order: "descending",
  });
  const ids = ev.data.filter((e) => (e.parsedJson as any)?.repo_id === repoId)
    .map((e) => (e.parsedJson as any)?.release_id).filter(Boolean) as string[];
  const rows = await Promise.all(ids.map((i) => getRelease(i).catch(() => null)));
  return rows.filter((r): r is Release => r !== null);
}

export interface Reputation { agent: string; prsOpened: number; prsMerged: number; reviews: number; ciRuns: number; }

export async function listReputation(repoId: string, limit = 200): Promise<Reputation[]> {
  const ev = await suiClient.queryEvents({
    query: { MoveEventType: `${DEPLOYMENT.packageId}::reputation::ReputationUpdated` },
    limit, order: "descending",
  });
  const seen = new Map<string, Reputation>();
  for (const e of ev.data) {
    const p = e.parsedJson as any;
    if (p?.repo_id !== repoId || seen.has(p.agent)) continue; // newest wins (desc order)
    seen.set(p.agent, {
      agent: p.agent, prsOpened: Number(p.prs_opened), prsMerged: Number(p.prs_merged),
      reviews: Number(p.reviews), ciRuns: Number(p.ci_runs),
    });
  }
  return [...seen.values()].sort((a, b) => b.prsMerged - a.prsMerged);
}

export interface Activity { tx: string; seq: string; type: string; }

export async function listActivity(repoId: string, limit = 100): Promise<Activity[]> {
  const mods = ["forge", "pull_request", "issue", "bounty", "release", "reputation"];
  const all: Activity[] = [];
  for (const m of mods) {
    const ev = await suiClient.queryEvents({
      query: { MoveModule: { package: DEPLOYMENT.packageId, module: m } },
      limit, order: "descending",
    });
    for (const e of ev.data) {
      const p = e.parsedJson as any;
      if (p?.repo_id && p.repo_id !== repoId) continue;
      all.push({ tx: e.id.txDigest, seq: String(e.id.eventSeq), type: e.type.split("::").slice(-1)[0] });
    }
  }
  return all.slice(0, limit);
}

// ===== Walrus reads =====

export async function fetchBlobText(blobId: string): Promise<string | null> {
  try {
    const res = await fetch(blobUrl(blobId), { cache: "no-store" });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

export async function fetchManifest(blobId: string): Promise<Manifest | null> {
  const text = await fetchBlobText(blobId);
  if (!text) return null;
  try {
    return JSON.parse(text) as Manifest;
  } catch {
    return null;
  }
}

export function short(id: string, head = 6, tail = 4): string {
  if (!id) return "";
  if (id.length <= head + tail + 2) return id;
  return `${id.slice(0, head)}…${id.slice(-tail)}`;
}
