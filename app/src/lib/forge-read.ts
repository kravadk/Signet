/**
 * Read layer for Signet (CLI/MCP side).
 *
 * Lists and fetches on-chain objects (repos, PRs, releases) by scanning package
 * events, and pulls the referenced Walrus blobs. Mirrors web/src/lib/forge.ts so
 * the `app` package is self-contained. Read-only: no signing, no writes.
 */

import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import { loadDeployment } from "./sui.js";
import { readBlobText, blobUrl } from "./walrus.js";
import { parseManifest, type Manifest } from "./snapshot.js";

// Network from FORGE_NETWORK env (testnet | mainnet), default testnet. Keeps the
// read layer aligned with the signing context the CLI/MCP/seed use.
const NETWORK = process.env.FORGE_NETWORK === "mainnet" ? "mainnet" : "testnet";
const deployment = loadDeployment(NETWORK);
const PACKAGE = deployment.packageId;
const client = new SuiClient({ url: getFullnodeUrl(NETWORK) });

/**
 * Paginate an event query across ALL pages (cursor loop) so lists aren't silently
 * capped at one page. `max` is a safety backstop against an unbounded log.
 */
async function queryAllEvents(
  query: any,
  { order = "descending", max = 1000, pageLimit = 50 }: { order?: "ascending" | "descending"; max?: number; pageLimit?: number } = {},
): Promise<any[]> {
  const out: any[] = [];
  let cursor: any = null;
  do {
    let page;
    try { page = await client.queryEvents({ query, cursor, limit: pageLimit, order }); }
    catch { break; }
    out.push(...page.data);
    cursor = page.nextCursor;
    if (!page.hasNextPage || out.length >= max) break;
  } while (cursor);
  return out;
}

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
  const data = await queryAllEvents({ MoveEventType: `${PACKAGE}::forge::RepoCreated` }, { pageLimit: limit });
  const ids = data
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

/** All OPEN pull requests (status 0), optionally filtered to one repo. Paginated. */
export async function listOpenPullRequests(repoId?: string): Promise<PullRequest[]> {
  const data = await queryAllEvents({ MoveEventType: `${PACKAGE}::pull_request::PrOpened` });
  const ids = data.map((e) => (e.parsedJson as any)?.pr_id).filter(Boolean) as string[];
  const prs = await Promise.all(ids.map((id) => getPullRequest(id).catch(() => null)));
  return prs.filter(
    (p): p is PullRequest => p !== null && p.status === 0 && (!repoId || p.repoId === repoId),
  );
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
  const data = await queryAllEvents({ MoveEventType: `${PACKAGE}::release::ReleasePublished` }, { pageLimit: limit });
  const ids = data
    .filter((e) => (e.parsedJson as any)?.repo_id === repoId)
    .map((e) => (e.parsedJson as any)?.release_id)
    .filter(Boolean) as string[];
  const releases = await Promise.all(ids.map((id) => getRelease(id).catch(() => null)));
  return releases.filter((r): r is Release => r !== null);
}

/**
 * Most recent release id across the whole network (any repo), by scanning
 * ReleasePublished events. Used by CI/`forge latest-release` to pick a release
 * to verify without hardcoding an id. Returns null if the network has none.
 */
export async function latestReleaseId(limit = 20): Promise<string | null> {
  const events = await client.queryEvents({
    query: { MoveEventType: `${PACKAGE}::release::ReleasePublished` },
    limit,
    order: "descending",
  });
  for (const e of events.data) {
    const id = (e.parsedJson as any)?.release_id;
    if (id) return id as string;
  }
  return null;
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
  const data = await queryAllEvents({ MoveEventType: `${PACKAGE}::issue::IssueOpened` }, { pageLimit: limit });
  const ids = data
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
  const data = await queryAllEvents({ MoveEventType: `${PACKAGE}::bounty::BountyPosted` }, { pageLimit: limit });
  const ids = data
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
  const data = await queryAllEvents({ MoveEventType: `${PACKAGE}::forge::RepoCreated` });
  const ev = data.find((e) => (e.parsedJson as any)?.repo_id === repoId);
  if (!ev) return null;
  const digest = ev.id.txDigest;
  const tx = await client.getTransactionBlock({ digest, options: { showObjectChanges: true } });
  const change = (tx.objectChanges ?? []).find(
    (o: any) => o.type === "created" && String(o.objectType).endsWith("::reputation::RepoReputation"),
  );
  return change ? (change as any).objectId : null;
}

const ZERO_REP = { prsOpened: 0, prsMerged: 0, reviews: 0, ciRuns: 0, vouches: 0, score: 0, lastEpoch: 0 };

export async function getReputation(repoId: string, agent: string) {
  const ledgerId = await findReputationLedger(repoId);
  if (!ledgerId) return null;
  // Read the AgentProfile straight from the on-chain RepoReputation ledger's
  // `profiles: Table<address, AgentProfile>`. This is the authoritative state —
  // exact, with no event-window cap that could silently return zeros for an
  // agent whose latest ReputationUpdated event fell outside a paginated scan.
  const ledger = await client.getObject({ id: ledgerId, options: { showContent: true } });
  const tableId = (ledger.data?.content as any)?.fields?.profiles?.fields?.id?.id;
  if (!tableId) return { ...ZERO_REP };
  try {
    const field = await client.getDynamicFieldObject({
      parentId: tableId,
      name: { type: "address", value: agent },
    });
    const p = (field.data?.content as any)?.fields?.value?.fields;
    if (!p) return { ...ZERO_REP }; // genuinely-new agent: no profile entry yet
    return {
      prsOpened: Number(p.prs_opened ?? 0),
      prsMerged: Number(p.prs_merged ?? 0),
      reviews: Number(p.reviews ?? 0),
      ciRuns: Number(p.ci_runs ?? 0),
      vouches: Number(p.vouches ?? 0),
      score: Number(p.score ?? 0),
      lastEpoch: Number(p.last_epoch ?? 0),
    };
  } catch {
    // No dynamic field for this agent => no profile yet.
    return { ...ZERO_REP };
  }
}

export { blobUrl };
