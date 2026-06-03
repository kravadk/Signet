/**
 * High-level Signet actions, shared by the MCP server (and reusable by the
 * CLI). Each returns a plain structured object — no console output — so callers
 * decide how to present results. Composes the lib + read layers.
 */

import { storeBlobAuto, blobUrl, readBlob } from "./walrus.js";
import { buildSnapshotFromMemory, verifyTreeHash } from "./snapshot.js";
import {
  type ForgeContext,
  openPrAsAgent,
  submitReviewAsAgent,
  openIssue,
  commentIssue,
  postBounty,
  claimBounty,
  submitBounty,
  vouch,
  publishApp,
  createdOfType,
} from "./sui.js";
import {
  listRepos,
  getRepo,
  getRelease,
  getPullRequest,
  fetchManifest,
  findReputationLedger,
  listIssues,
  listBounties,
  getReputation,
} from "./forge-read.js";
import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import { loadDeployment } from "./sui.js";

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

export async function releaseAttestation(args: { releaseId: string }) {
  const rel = await getRelease(args.releaseId);
  if (!rel) throw new Error(`Release not found: ${args.releaseId}`);
  const [repo, manifest, verify] = await Promise.all([
    getRepo(rel.repoId),
    fetchManifest(rel.sourceSnapshot),
    verifyRelease(args.releaseId),
  ]);
  const mergedPr = rel.mergedPrId ? await getPullRequest(rel.mergedPrId).catch(() => null) : null;
  return {
    _type: "https://in-toto.io/Statement/v1",
    subject: [{
      name: `${repo?.name ?? rel.repoId}@${rel.version}`,
      digest: { treeHash: manifest?.treeHash ?? rel.sourceSnapshot },
    }],
    predicateType: "https://slsa.dev/provenance/v1",
    predicate: {
      buildDefinition: {
        buildType: "https://signet.dev/release/v2",
        externalParameters: {
          network: _vNet,
          packageId: _vPkg,
          repoId: rel.repoId,
          releaseId: rel.id,
          mergedPrId: rel.mergedPrId ?? null,
          version: rel.version,
        },
        resolvedDependencies: [
          { uri: `sui:package:${_vPkg}`, digest: { suiObjectId: _vPkg } },
          { uri: `sui:repo:${rel.repoId}`, digest: { suiObjectId: rel.repoId } },
          ...(mergedPr ? [{ uri: `sui:pr:${mergedPr.id}`, digest: { suiObjectId: mergedPr.id } }] : []),
          { uri: `walrus:blob:${rel.sourceSnapshot}`, digest: { treeHash: manifest?.treeHash ?? "" } },
          { uri: `walrus:blob:${rel.buildArtifact}` },
          { uri: `walrus:blob:${rel.testReport}` },
        ],
      },
      runDetails: {
        builder: { id: "signet-forge" },
        metadata: {
          invocationId: rel.id,
          verificationLevel: verify.levelLabel,
          verified: verify.pass,
        },
      },
    },
  };
}

// ===== Verify (read-only provenance check) =====

const _vNet = process.env.FORGE_NETWORK === "mainnet" ? "mainnet" : "testnet";
const _vClient = new SuiClient({ url: getFullnodeUrl(_vNet) });
const _vPkg = loadDeployment(_vNet).packageId;

export interface VerifyStep {
  key: string;
  label: string;
  ok: boolean;
  detail: string;
}

export interface VerifyResult {
  releaseId: string;
  version: string | null;
  repoId: string | null;
  pass: boolean;
  level: number; // SLSA-style: 0 fail, 1 source+artifact, 2 +reviewed, 3 +chain matches
  levelLabel: string;
  steps: VerifyStep[];
}

/** Is a Walrus blob fetchable from the aggregator? (availability = integrity backbone) */
async function blobAvailable(blobId: string): Promise<boolean> {
  if (!blobId) return false;
  try {
    await readBlob(blobId);
    return true;
  } catch {
    return false;
  }
}

/**
 * Independently verify a release's provenance chain. Read-only: reads the
 * on-chain Release + Walrus blobs and re-checks integrity. No keys needed.
 *
 * Steps (in-toto / Sigstore-Rekor inspired):
 *  1. Release object exists on-chain.
 *  2. Source / artifact / report blobs are all available on Walrus.
 *  3. Source manifest's treeHash recomputes correctly (content integrity).
 *  4. A merged PR's head snapshot matches the release source (the code that was
 *     reviewed is the code that was released).
 * SLSA-style level: 1 = source+artifact present, 2 = a signed review exists in
 * the chain, 3 = treeHash verifies AND PR-head == release-source.
 */
export async function verifyRelease(releaseId: string): Promise<VerifyResult> {
  const steps: VerifyStep[] = [];
  const rel = await getRelease(releaseId);
  if (!rel) {
    return {
      releaseId, version: null, repoId: null, pass: false, level: 0,
      levelLabel: "unverified",
      steps: [{ key: "exists", label: "Release object on-chain", ok: false, detail: "not found" }],
    };
  }
  steps.push({ key: "exists", label: "Release object on-chain", ok: true, detail: rel.id });

  // 2. blob availability
  const [srcOk, artOk, repOk] = await Promise.all([
    blobAvailable(rel.sourceSnapshot),
    blobAvailable(rel.buildArtifact),
    blobAvailable(rel.testReport),
  ]);
  steps.push({ key: "src", label: "Source snapshot on Walrus", ok: srcOk, detail: rel.sourceSnapshot });
  steps.push({ key: "art", label: "Build artifact on Walrus", ok: artOk, detail: rel.buildArtifact });
  steps.push({ key: "rep", label: "Test report on Walrus", ok: repOk, detail: rel.testReport });

  // 3. treeHash integrity of the source manifest
  const manifest = await fetchManifest(rel.sourceSnapshot);
  const treeOk = manifest ? verifyTreeHash(manifest) : false;
  steps.push({
    key: "tree", label: "Source treeHash recomputes", ok: treeOk,
    detail: manifest ? `${manifest.files.length} files · ${manifest.treeHash.slice(0, 12)}…` : "manifest unavailable",
  });

  // 4. Prefer the v2 direct ReleaseLinked -> merged PR edge. Old releases fall
  // back to scanning merged PR events by source snapshot.
  let chainOk = false;
  let reviewedOk = false;
  let chainDetail = "no merged PR matched the release source";
  if (rel.mergedPrId) {
    const pr = await getPullRequest(rel.mergedPrId).catch(() => null);
    if (pr) {
      chainOk = pr.repoId === rel.repoId && pr.status === 1 && pr.headSnapshot === rel.sourceSnapshot;
      reviewedOk = (pr.reviewRefs?.length ?? 0) > 0;
      chainDetail = `ReleaseLinked PR ${rel.mergedPrId.slice(0, 10)}вЂ¦` +
        (chainOk ? " head == release source" : " does not match release source") +
        (reviewedOk ? ` В· ${pr.reviewRefs.length} signed review(s)` : " В· no review");
    } else {
      chainDetail = `ReleaseLinked PR ${rel.mergedPrId.slice(0, 10)}вЂ¦ not found`;
    }
  }
  if (!chainOk) try {
    // Cursor-paginate PrMerged so a release's PR isn't missed when the repo has
    // more than one page of merges (correctness, not just the most-recent page).
    const prIds: string[] = [];
    let cursor: any = null;
    do {
      const page = await _vClient.queryEvents({
        query: { MoveEventType: `${_vPkg}::pull_request::PrMerged` },
        cursor, limit: 50, order: "descending",
      });
      for (const e of page.data) {
        if ((e.parsedJson as any)?.repo_id !== rel.repoId) continue;
        const id = (e.parsedJson as any)?.pr_id;
        if (id) prIds.push(id as string);
      }
      cursor = page.nextCursor;
      if (!page.hasNextPage || prIds.length >= 500) break;
    } while (cursor);
    for (const prId of prIds) {
      const pr = await getPullRequest(prId).catch(() => null);
      if (!pr) continue;
      if (pr.headSnapshot === rel.sourceSnapshot) {
        chainOk = true;
        reviewedOk = (pr.reviewRefs?.length ?? 0) > 0;
        chainDetail = `PR ${prId.slice(0, 10)}… head == release source` +
          (reviewedOk ? ` · ${pr.reviewRefs.length} signed review(s)` : " · no review");
        break;
      }
    }
  } catch {
    chainDetail = "could not scan merged PRs";
  }
  steps.push({ key: "reviewed", label: "Signed review in the chain", ok: reviewedOk, detail: reviewedOk ? chainDetail : "no signed review found" });
  steps.push({ key: "chain", label: "Reviewed code == released code", ok: chainOk, detail: chainDetail });

  // SLSA-style level
  const baseOk = srcOk && artOk; // L1
  let level = 0;
  if (baseOk) level = 1;
  if (baseOk && reviewedOk) level = 2;
  if (baseOk && reviewedOk && treeOk && chainOk) level = 3;
  const levelLabel = level === 0 ? "unverified" : `SLSA-style L${level}`;
  const pass = steps.every((s) => s.ok);

  return {
    releaseId: rel.id, version: rel.version, repoId: rel.repoId,
    pass, level, levelLabel, steps,
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

  const archiveBlob = await storeBlobAuto(archive);
  const manifestBlob = await storeBlobAuto(
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

/** Publish a Playground app: store the app files on Walrus, anchor on-chain.
   Lets an agent build + publish an app via MCP, with verifiable provenance. */
export async function publishPlaygroundApp(args: {
  ctx: ForgeContext;
  name: string;
  prompt: string;
  category?: string;
  files: FileInput[];
  parent?: string | null;
}) {
  const { archive, manifest } = buildSnapshotFromMemory({
    files: args.files,
    name: args.name,
    branch: "main",
    previousSnapshot: args.parent ?? null,
    nowEpochMs: nowMs(),
  });
  const archiveBlob = await storeBlobAuto(archive);
  const manifestBlob = await storeBlobAuto(
    JSON.stringify({ ...manifest, archiveBlob: archiveBlob.blobId, playground: { kind: "playground-app", prompt: args.prompt, category: args.category ?? "other", parent: args.parent ?? null } }),
  );
  const res = await publishApp(args.ctx, {
    name: args.name,
    prompt: args.prompt,
    manifestBlob: manifestBlob.blobId,
    archiveBlob: archiveBlob.blobId,
    treeHash: manifest.treeHash,
    category: args.category ?? "other",
    parent: args.parent ?? null,
  });
  const appId = createdOfType(res, "::playground::PublishedApp")[0];
  return {
    appId,
    manifestBlob: manifestBlob.blobId,
    archiveBlob: archiveBlob.blobId,
    url: blobUrl(manifestBlob.blobId),
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
  const reportBlob = await storeBlobAuto(args.reportText);
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
  const blob = await storeBlobAuto(args.content);
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
  const bodyBlob = await storeBlobAuto(args.body);
  const res = await openIssue(args.ctx, { repoId: args.repoId, title: args.title, bodyBlob: bodyBlob.blobId });
  const issueId = createdOfType(res, "::issue::Issue")[0];
  return { issueId, bodyBlob: bodyBlob.blobId, txDigest: res.digest };
}

export async function issueComment(args: {
  ctx: ForgeContext;
  issueId: string;
  body: string;
}) {
  const bodyBlob = await storeBlobAuto(args.body);
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

export async function bountyClaim(args: { ctx: ForgeContext; bountyId: string; repoId: string }) {
  const reputationId = await findReputationLedger(args.repoId);
  if (!reputationId) throw new Error(`Reputation ledger not found for repo ${args.repoId}`);
  const res = await claimBounty(args.ctx, { bountyId: args.bountyId, reputationId });
  return { txDigest: res.digest };
}

export async function agentVouch(args: { ctx: ForgeContext; repoId: string; subject: string }) {
  const reputationId = await findReputationLedger(args.repoId);
  if (!reputationId) throw new Error(`Reputation ledger not found for repo ${args.repoId}`);
  const res = await vouch(args.ctx, { reputationId, subject: args.subject });
  return { reputationId, txDigest: res.digest };
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
