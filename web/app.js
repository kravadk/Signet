/* ============================================================
   Signet Dashboard — bootstrap, routing, render.
   Shared config/state/helpers live in shared.js; wallet + write
   actions in wallet.js; toast/search/settings UI in ui.js.
   ============================================================ */

import {
  CFG, CFG_READY, SETTINGS, sui, STATE,
  explorerObject, explorerAddress, explorerTx, blobUrl, walruscanBlob,
  short, formatAddress, isValidSuiAddress, isValidSuiObjectId, MIST, suiAmount,
  PR_STATUS, prStatusLabel, ISSUE_STATUS, issueStatusLabel,
  BOUNTY_STATUS, bountyStatusLabel,
  $, fields, escapeHtml, withTimeout, saveSettings,
  decodeSuiError,
  SCOPE_OPEN_PR, SCOPE_REVIEW, SCOPE_RUN_CI, SCOPE_NAMES, scopeChips, scoreTier,
} from './shared.js';
import {
  readGetObject, readMultiGetObjects, readQueryEvents,
  readSourceLabel, readSourceSnapshot,
} from './data-source.js';
import { Transaction } from 'https://esm.sh/@mysten/sui@1.30.0/transactions';
import { toast, copyText, copyBtn, openModal, closeModal, relativeTime, skeletonCards, skeletonRows, skeletonList } from './ui.js';
import {
  wireWallet, renderConnect, loadMyCaps, ownerCapFor, agentCapFor, signAndRun, signAndRunCreated, recoverPendingTx,
  resolveName, nameOrShort, actOpenIssue, actPostBounty, actGrantAgent, actMergePr, actClosePr,
  actVouch, actSetApprovals, actOpenDispute, actResolveDispute, actImportFromGitHub,
} from './wallet.js';
import { wirePlayground, renderPlaygroundView, loadGallery } from './playground.js';
import { beginZkLogin, completeZkLoginFromRedirect, restoreZkLogin, zkConfigured } from './zklogin.js';

/* ============================================================
   On-chain reads (event-scan + getObject), mirror of forge.ts
   ============================================================ */

/** Batch-fetch objects (collapses N+1 getObject into multiGetObjects, max 50/call),
 *  map each through `parse(fieldsObj, id)` → non-null results. */
async function multiGet(ids, parse) {
  const out = [];
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const objs = await withTimeout(readMultiGetObjects({ ids: batch, options: { showContent: true } }), 15000, 'objects');
    for (let j = 0; j < objs.length; j++) {
      const x = objs[j]?.data?.content?.fields ?? {};
      const r = parse(x, batch[j]);
      if (r) out.push(r);
    }
  }
  return out;
}

function parseRepo(x, id) {
  if (!x.name) return null;
  return {
    id, name: x.name, owner: x.owner, defaultBranch: x.default_branch,
    currentSnapshot: x.current_snapshot, refVersion: Number(x.ref_version),
    latestRelease: x.latest_release ?? null, minApprovals: Number(x.min_approvals ?? 0),
  };
}
async function getRepo(id) {
  const obj = await readGetObject({ id, options: { showContent: true } });
  return parseRepo(fields(obj), id);
}

/* Paginate an event query across ALL pages (cursor loop) so lists aren't silently
   capped at one page. `max` is a safety backstop against an unbounded log. */
async function queryAllEvents(query, { order = 'descending', max = 1000, pageLimit = 50 } = {}) {
  const out = []; let cursor = null;
  do {
    let page;
    page = await withTimeout(readQueryEvents({ query, cursor, limit: pageLimit, order }), 15000, 'events');
    out.push(...page.data);
    cursor = page.nextCursor;
    if (!page.hasNextPage || out.length >= max) break;
  } while (cursor);
  return out;
}

async function listRepos() {
  const data = await queryAllEvents({ MoveEventType: `${CFG.packageId}::forge::RepoCreated` });
  const ids = data.map((e) => e.parsedJson?.repo_id).filter(Boolean);
  return multiGet(ids, parseRepo);
}

function parsePr(x, id) {
  if (!x.title && !x.repo_id) return null;
  return {
    id, repoId: x.repo_id, author: x.author, baseSnapshot: x.base_snapshot,
    headSnapshot: x.head_snapshot, diffManifest: x.diff_manifest, title: x.title,
    status: Number(x.status), reviewRefs: x.review_refs ?? [], approvals: Number(x.approvals ?? 0),
  };
}
async function getPullRequest(id) {
  const obj = await readGetObject({ id, options: { showContent: true } });
  return parsePr(fields(obj), id);
}

async function listAllPullRequests() {
  const data = await queryAllEvents({ MoveEventType: `${CFG.packageId}::pull_request::PrOpened` });
  const ids = data.map((e) => e.parsedJson?.pr_id).filter(Boolean);
  const meta = new Map(data.map((e) => [e.parsedJson?.pr_id, { tx: e.id?.txDigest || '', ts: Number(e.timestampMs || 0) }]).filter(([id]) => id));
  const prs = await multiGet(ids, parsePr);
  for (const p of prs) Object.assign(p, meta.get(p.id) || {});
  return prs;
}

function parseRelease(x, id) {
  if (!x.version) return null;
  return {
    id, repoId: x.repo_id, version: x.version, sourceSnapshot: x.source_snapshot,
    buildArtifact: x.build_artifact, testReport: x.test_report, publishedBy: x.published_by,
    mergedPrId: null,
  };
}
async function getRelease(id) {
  const obj = await readGetObject({ id, options: { showContent: true } });
  return parseRelease(fields(obj), id);
}

async function listAllReleases() {
  const data = await queryAllEvents({ MoveEventType: `${CFG.packageId}::release::ReleasePublished` });
  const ids = data.map((e) => e.parsedJson?.release_id).filter(Boolean);
  const [releases, links] = await Promise.all([multiGet(ids, parseRelease), releaseLinksMap()]);
  for (const r of releases) r.mergedPrId = links.get(r.id) || null;
  return releases;
}

async function releaseLinksMap() {
  const data = await queryAllEvents({ MoveEventType: `${CFG.packageId}::release::ReleaseLinked` }, { max: 2000 });
  const links = new Map();
  for (const e of data) {
    const p = e.parsedJson;
    if (p?.release_id && p?.merged_pr_id && !links.has(p.release_id)) links.set(p.release_id, p.merged_pr_id);
  }
  return links;
}

async function listAllReputation() {
  const data = await queryAllEvents({ MoveEventType: `${CFG.packageId}::reputation::ReputationUpdated` }, { max: 2000 });
  const seen = new Map();
  for (const e of data) {
    const p = e.parsedJson;
    if (!p?.agent || seen.has(p.agent)) continue; // newest wins (desc)
    seen.set(p.agent, {
      agent: p.agent, prsOpened: Number(p.prs_opened), prsMerged: Number(p.prs_merged),
      reviews: Number(p.reviews), ciRuns: Number(p.ci_runs),
      vouches: Number(p.vouches ?? 0), score: Number(p.score ?? 0), lastEpoch: Number(p.last_epoch ?? 0),
    });
  }
  return [...seen.values()].sort((a, b) => b.score - a.score);
}

/** Map recipient address -> their AgentCap grant (scope/expiry/revoked). */
async function listAgentCaps() {
  const [grants, revokes] = await Promise.all([
    queryAllEvents({ MoveEventType: `${CFG.packageId}::forge::AgentCapGranted` }),
    queryAllEvents({ MoveEventType: `${CFG.packageId}::forge::AgentCapRevoked` }),
  ]);
  const revoked = new Set(revokes.map((e) => e.parsedJson?.cap_id).filter(Boolean));
  const byAgent = new Map(); // recipient -> {capId, scopes, expires, repoId, revoked}
  for (const e of grants) {
    const p = e.parsedJson; if (!p?.recipient || byAgent.has(p.recipient)) continue;
    byAgent.set(p.recipient, {
      capId: p.cap_id, scopes: Number(p.scopes), expires: Number(p.expires_at_epoch),
      repoId: p.repo_id, revoked: revoked.has(p.cap_id),
    });
  }
  return byAgent;
}

function parseIssue(x, id) {
  if (!x.title && !x.repo_id) return null;
  return {
    id, repoId: x.repo_id, author: x.author, title: x.title,
    bodyBlob: x.body_blob, status: Number(x.status), commentCount: Number(x.comment_count),
  };
}
async function getIssue(id) {
  const obj = await readGetObject({ id, options: { showContent: true } });
  return parseIssue(fields(obj), id);
}

async function listAllIssues() {
  const data = await queryAllEvents({ MoveEventType: `${CFG.packageId}::issue::IssueOpened` });
  const ids = data.map((e) => e.parsedJson?.issue_id).filter(Boolean);
  return multiGet(ids, parseIssue);
}

function parseBounty(x, id) {
  if (x.amount === undefined) return null;
  const claimant = x.claimant?.fields?.vec?.[0] ?? (typeof x.claimant === 'string' ? x.claimant : null);
  const proof = x.proof?.fields?.vec?.[0] ?? (typeof x.proof === 'string' ? x.proof : null);
  return {
    id, repoId: x.repo_id, funder: x.funder, title: x.title,
    amount: Number(x.amount), status: Number(x.status),
    claimant: typeof claimant === 'string' ? claimant : null,
    proof: typeof proof === 'string' ? proof : null,
    minScore: Number(x.min_score ?? 0),
  };
}
async function getBounty(id) {
  const obj = await readGetObject({ id, options: { showContent: true } });
  return parseBounty(fields(obj), id);
}

async function listAllBounties() {
  const data = await queryAllEvents({ MoveEventType: `${CFG.packageId}::bounty::BountyPosted` });
  const ids = data.map((e) => e.parsedJson?.bounty_id).filter(Boolean);
  const meta = new Map(data.map((e) => [e.parsedJson?.bounty_id, { tx: e.id?.txDigest || '', ts: Number(e.timestampMs || 0) }]).filter(([id]) => id));
  const bounties = await multiGet(ids, parseBounty);
  for (const b of bounties) Object.assign(b, meta.get(b.id) || {});
  return bounties;
}

function optValue(v) {
  return v?.fields?.vec?.[0] ?? v?.vec?.[0] ?? (typeof v === 'string' || typeof v === 'number' ? v : null);
}

function parsePayment(x, id) {
  if (x.amount === undefined) return null;
  const expiresAt = Number(optValue(x.expires_at_ms) ?? 0) || null;
  const closed = x.paid ? 1 : x.cancelled ? 2 : 0;
  return {
    id,
    creator: x.creator,
    recipient: x.recipient,
    label: x.label || '',
    amount: Number(x.amount),
    status: closed || (expiresAt && expiresAt <= Date.now() ? 3 : 0),
    payer: optValue(x.payer),
    createdAt: Number(x.created_at_ms ?? 0),
    expiresAt,
  };
}

async function getPayment(id) {
  const obj = await readGetObject({ id, options: { showContent: true } });
  return parsePayment(fields(obj), id);
}

async function listAllPayments() {
  const data = await queryAllEvents({ MoveEventType: `${CFG.writePackageId || CFG.packageId}::payment::PaymentRequested` });
  const ids = data.map((e) => e.parsedJson?.request_id).filter(Boolean);
  const meta = new Map(data.map((e) => [e.parsedJson?.request_id, { tx: e.id?.txDigest || '', ts: Number(e.timestampMs || 0) }]).filter(([id]) => id));
  const payments = await multiGet(ids, parsePayment);
  for (const p of payments) Object.assign(p, meta.get(p.id) || {});
  return payments;
}

async function listReviewEvents() {
  const data = await queryAllEvents({ MoveEventType: `${CFG.packageId}::pull_request::ReviewSubmitted` }, { max: 2000 });
  return data.map((e) => {
    const p = e.parsedJson || {};
    return {
      reviewId: p.review_id, prId: p.pr_id, reviewer: p.reviewer,
      verdict: Number(p.verdict ?? 0), reportBlob: p.report_blob,
      tx: e.id?.txDigest || '', ts: Number(e.timestampMs || 0),
    };
  }).filter((x) => x.reviewId && x.reviewer);
}

async function listVouchEvents() {
  const data = await queryAllEvents({ MoveEventType: `${CFG.packageId}::reputation::AgentVouched` }, { max: 2000 });
  return data.map((e) => {
    const p = e.parsedJson || {};
    return { repoId: p.repo_id, voucher: p.voucher, subject: p.subject, tx: e.id?.txDigest || '', ts: Number(e.timestampMs || 0) };
  }).filter((x) => x.subject && x.voucher);
}

async function listBountyLifecycleEvents() {
  const [claimed, submitted, paid] = await Promise.all([
    queryAllEvents({ MoveEventType: `${CFG.packageId}::bounty::BountyClaimed` }, { max: 2000 }),
    queryAllEvents({ MoveEventType: `${CFG.packageId}::bounty::BountySubmitted` }, { max: 2000 }),
    queryAllEvents({ MoveEventType: `${CFG.packageId}::bounty::BountyPaid` }, { max: 2000 }),
  ]);
  const mapEvent = (e) => ({ ...(e.parsedJson || {}), tx: e.id?.txDigest || '', ts: Number(e.timestampMs || 0) });
  return { claimed: claimed.map(mapEvent), submitted: submitted.map(mapEvent), paid: paid.map(mapEvent) };
}

/* ---------- Walrus: manifest + archive (file tree) ---------- */

async function fetchManifest(blobId) {
  if (!blobId) return null;
  if (STATE.manifestCache.has(blobId)) return STATE.manifestCache.get(blobId);
  try {
    const res = await fetch(blobUrl(blobId), { cache: 'no-store' });
    if (!res.ok) return null;
    const m = JSON.parse(await res.text());
    STATE.manifestCache.set(blobId, m);
    return m;
  } catch { return null; }
}

async function fetchBlobText(blobId) {
  if (!blobId) return null;
  try {
    const res = await fetch(blobUrl(blobId), { cache: 'no-store' });
    if (!res.ok) return null;
    return await res.text();
  } catch { return null; }
}

/** Inflate a buildSnapshot archive in the browser. Mirrors extractArchive
 *  in app/src/lib/snapshot.ts: gzip, then length-prefixed (uint32 BE pathLen,
 *  uint32 BE dataLen, path bytes, data bytes) entries. */
async function fetchArchive(blobId) {
  if (!blobId) return null;
  if (STATE.archiveCache.has(blobId)) return STATE.archiveCache.get(blobId);
  try {
    const res = await fetch(blobUrl(blobId), { cache: 'no-store' });
    if (!res.ok) return null;
    const gz = new Uint8Array(await res.arrayBuffer());
    const ds = new DecompressionStream('gzip');
    const flatBuf = await new Response(
      new Blob([gz]).stream().pipeThrough(ds)
    ).arrayBuffer();
    const flat = new Uint8Array(flatBuf);
    const dv = new DataView(flat.buffer, flat.byteOffset, flat.byteLength);
    const out = new Map();
    let off = 0;
    const dec = new TextDecoder();
    while (off < flat.length) {
      const pathLen = dv.getUint32(off, false); off += 4;
      const dataLen = dv.getUint32(off, false); off += 4;
      const path = dec.decode(flat.subarray(off, off + pathLen)); off += pathLen;
      const data = flat.subarray(off, off + dataLen); off += dataLen;
      out.set(path, data);
    }
    STATE.archiveCache.set(blobId, out);
    return out;
  } catch (e) { console.warn('archive inflate failed', e); return null; }
}

/* ---------- Verify (provenance chain) — mirrors app/src/lib/actions.verifyRelease ---------- */

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Recompute the manifest tree hash and compare (== verifyTreeHash in snapshot.ts). */
async function verifyTreeHashBrowser(manifest) {
  if (!manifest || !Array.isArray(manifest.files) || !manifest.treeHash) return false;
  const recomputed = await sha256Hex(manifest.files.map((e) => `${e.path}:${e.sha256}`).join('\n'));
  return recomputed === manifest.treeHash;
}

/** Build + verify a Merkle inclusion proof for one file, client-side. Mirrors
 *  snapshot.ts: leaf = sha256("path:sha256"); parent = sha256(left+right); odd dup. */
async function merkleVerifyBrowser(manifest, path) {
  if (!manifest?.files || !manifest.merkleRoot) return null;
  const idx = manifest.files.findIndex((f) => f.path === path);
  if (idx < 0) return null;
  let level = [];
  for (const f of manifest.files) level.push(await sha256Hex(`${f.path}:${f.sha256}`));
  let leaf = level[idx], i = idx; const siblings = [];
  while (level.length > 1) {
    const isRight = i % 2 === 1; const sib = isRight ? i - 1 : i + 1;
    siblings.push({ hash: sib < level.length ? level[sib] : level[i], left: isRight });
    const next = [];
    for (let k = 0; k < level.length; k += 2) {
      const L = level[k]; const R = k + 1 < level.length ? level[k + 1] : L;
      next.push(await sha256Hex(L + R));
    }
    level = next; i = Math.floor(i / 2);
  }
  let h = leaf;
  for (const s of siblings) h = s.left ? await sha256Hex(s.hash + h) : await sha256Hex(h + s.hash);
  return { ok: h === level[0] && level[0] === manifest.merkleRoot, root: level[0], depth: siblings.length };
}

async function blobAvailableBrowser(blobId) {
  if (!blobId) return false;
  try {
    const res = await fetch(blobUrl(blobId), { cache: 'no-store' });
    return res.ok;
  } catch { return false; }
}

/** Independently verify a release in the browser. Same steps as the CLI/MCP. */
async function verifyReleaseBrowser(releaseId) {
  const steps = [];
  const rel = STATE.releases.find((x) => x.id === releaseId);
  if (!rel) {
    return { releaseId, version: null, pass: false, level: 0, levelLabel: 'unverified',
      steps: [{ label: 'Release object on-chain', ok: false, detail: 'not found in current data' }] };
  }
  steps.push({ label: 'Release object on-chain', ok: true, detail: short(rel.id) });

  const [srcOk, artOk, repOk] = await Promise.all([
    blobAvailableBrowser(rel.sourceSnapshot),
    blobAvailableBrowser(rel.buildArtifact),
    blobAvailableBrowser(rel.testReport),
  ]);
  steps.push({ label: 'Source snapshot on Walrus', ok: srcOk, detail: short(rel.sourceSnapshot) });
  steps.push({ label: 'Build artifact on Walrus', ok: artOk, detail: short(rel.buildArtifact) });
  steps.push({ label: 'Test report on Walrus', ok: repOk, detail: short(rel.testReport) });

  const manifest = await fetchManifest(rel.sourceSnapshot);
  const treeOk = await verifyTreeHashBrowser(manifest);
  steps.push({ label: 'Source treeHash recomputes', ok: treeOk,
    detail: (manifest && Array.isArray(manifest.files)) ? `${manifest.files.length} files · ${(manifest.treeHash || '').slice(0, 12)}…` : 'manifest unavailable' });

  // merged PR whose head == release source
  let chainOk = false, reviewedOk = false, chainDetail = 'no merged PR matched the release source';
  if (rel.mergedPrId) {
    const pr = STATE.prs.find((p) => p.id === rel.mergedPrId);
    if (pr) {
      chainOk = pr.repoId === rel.repoId && pr.status === 1 && pr.headSnapshot === rel.sourceSnapshot;
      reviewedOk = (pr.reviewRefs?.length || 0) > 0;
      chainDetail = `ReleaseLinked PR ${short(rel.mergedPrId)}` + (chainOk ? ' head == release source' : ' does not match release source') +
        (reviewedOk ? ` signed reviews: ${pr.reviewRefs.length}` : ' no review');
    } else {
      chainDetail = `ReleaseLinked PR ${short(rel.mergedPrId)} not loaded`;
    }
  }
  if (!chainOk) {
  const mergedPrs = STATE.prs.filter((p) => p.repoId === rel.repoId && p.status === 1);
  for (const pr of mergedPrs) {
    if (pr.headSnapshot === rel.sourceSnapshot) {
      chainOk = true;
      reviewedOk = (pr.reviewRefs?.length || 0) > 0;
      chainDetail = `PR ${short(pr.id)} head == release source` + (reviewedOk ? ` · ${pr.reviewRefs.length} signed review(s)` : ' · no review');
      break;
    }
  }
  }
  steps.push({ label: 'Signed review in the chain', ok: reviewedOk, detail: reviewedOk ? chainDetail : 'no signed review found' });
  steps.push({ label: 'Reviewed code == released code', ok: chainOk, detail: chainDetail });

  const baseOk = srcOk && artOk;
  let level = 0;
  if (baseOk) level = 1;
  if (baseOk && reviewedOk) level = 2;
  if (baseOk && reviewedOk && treeOk && chainOk) level = 3;
  const levelLabel = level === 0 ? 'unverified' : `SLSA-style L${level}`;
  const pass = steps.every((s) => s.ok);
  return { releaseId: rel.id, version: rel.version, pass, level, levelLabel, steps };
}

async function releaseAttestationBrowser(releaseId) {
  const rel = STATE.releases.find((x) => x.id === releaseId);
  if (!rel) throw new Error('release not loaded');
  const [verify, manifest] = await Promise.all([verifyReleaseBrowser(releaseId), fetchManifest(rel.sourceSnapshot)]);
  const repo = STATE.repos.find((r) => r.id === rel.repoId);
  return {
    _type: 'https://in-toto.io/Statement/v1',
    subject: [{
      name: `${repo?.name || rel.repoId}@${rel.version}`,
      digest: { treeHash: manifest?.treeHash || rel.sourceSnapshot },
    }],
    predicateType: 'https://slsa.dev/provenance/v1',
    predicate: {
      buildDefinition: {
        buildType: 'https://signet.dev/release/v2',
        externalParameters: {
          network: CFG.network,
          packageId: CFG.packageId,
          repoId: rel.repoId,
          releaseId: rel.id,
          mergedPrId: rel.mergedPrId,
          version: rel.version,
        },
        resolvedDependencies: [
          { uri: `sui:package:${CFG.packageId}`, digest: { suiObjectId: CFG.packageId } },
          { uri: `walrus:blob:${rel.sourceSnapshot}`, digest: { treeHash: manifest?.treeHash || '' } },
          { uri: `walrus:blob:${rel.buildArtifact}` },
          { uri: `walrus:blob:${rel.testReport}` },
        ],
      },
      runDetails: {
        builder: { id: 'signet-forge' },
        metadata: { invocationId: rel.id, verificationLevel: verify.levelLabel, verified: verify.pass },
      },
    },
  };
}

function downloadJson(name, value) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
}

/** Render a verify result into a host element. */
function renderVerifyResult(host, result) {
  const badge = result.pass
    ? `<span class="vbadge pass">✓ ${escapeHtml(result.levelLabel)} · Verified provenance</span>`
    : `<span class="vbadge fail">✗ Unverified</span>`;
  const r = STATE.releases.find((x) => x.id === result.releaseId) || {};
  const linkedPr = r.mergedPrId ? STATE.prs.find((p) => p.id === r.mergedPrId) : null;
  const releaseGraph = r.mergedPrId
    ? '<h3 class="detail-h3">Release graph</h3>' +
      '<div class="prov-chain">' +
        '<div class="prov-node g"><div class="prov-label">Repo</div><a class="prov-blob link mono" target="_blank" rel="noreferrer" href="' + explorerObject(r.repoId) + '">' + short(r.repoId) + '</a></div>' +
        '<span class="prov-arrow">→</span>' +
        '<div class="prov-node b"><div class="prov-label">Merged PR</div><a class="prov-blob link mono" target="_blank" rel="noreferrer" href="' + explorerObject(r.mergedPrId) + '">' + short(r.mergedPrId) + '</a></div>' +
        '<span class="prov-arrow">→</span>' +
        '<div class="prov-node v"><div class="prov-label">Reviews / CI</div><span class="prov-blob mono">' + (linkedPr ? ((linkedPr.reviewRefs?.length || 0) + ' report(s)') : 'not loaded') + '</span></div>' +
        '<span class="prov-arrow">→</span>' +
        '<div class="prov-node release"><div class="prov-label">Release</div><a class="prov-blob link mono" target="_blank" rel="noreferrer" href="' + explorerObject(r.id) + '">' + short(r.id) + '</a></div>' +
      '</div>'
    : '<h3 class="detail-h3">Release graph</h3>' +
      '<div class="prov-chain">' +
        '<div class="prov-node g"><div class="prov-label">Repo</div><a class="prov-blob link mono" target="_blank" rel="noreferrer" href="' + explorerObject(r.repoId || '') + '">' + short(r.repoId || '') + '</a></div>' +
        '<span class="prov-arrow">→</span>' +
        '<div class="prov-node b"><div class="prov-label">Source snapshot</div><span class="prov-blob mono">' + short(r.sourceSnapshot || '') + '</span></div>' +
        '<span class="prov-arrow">→</span>' +
        '<div class="prov-node release"><div class="prov-label">Release</div><a class="prov-blob link mono" target="_blank" rel="noreferrer" href="' + explorerObject(r.id || result.releaseId) + '">' + short(r.id || result.releaseId) + '</a></div>' +
      '</div>' +
      '<div class="cmd-note" style="margin:8px 0 14px">Legacy release: no direct PR link; verification falls back to matching merged PR head snapshots.</div>';
  host.innerHTML =
    '<div class="verify-result">' +
      '<div class="verify-top">' + badge + '</div>' +
      releaseGraph +
      '<div class="verify-steps">' +
        result.steps.map((s) =>
          '<div class="vstep ' + (s.ok ? 'ok' : 'bad') + '">' +
            '<span class="vmark">' + (s.ok ? '✓' : '✗') + '</span>' +
            '<span class="vlabel">' + escapeHtml(s.label) + '</span>' +
            '<span class="vdetail mono">' + escapeHtml(s.detail) + '</span>' +
          '</div>'
        ).join('') +
      '</div>' +
    '</div>';
}

/** Per-module event counts + daily buckets for the chart + a flat feed. */
async function listActivity() {
  const mods = ['forge', 'pull_request', 'issue', 'bounty', 'release', 'reputation', 'payment'];
  const perMod = {};
  let total = 0;
  const tsBuckets = new Map(); // epochMs(day) -> count
  const feed = [];
  for (const m of mods) {
    // Cursor-paginated per module (capped) so counts/feed aren't silently truncated.
    const data = await queryAllEvents({ MoveModule: { package: CFG.packageId, module: m } }, { max: 500 });
    perMod[m] = data.length;
    total += data.length;
    for (const e of data) {
      const t = Number(e.timestampMs || 0);
      feed.push({
        type: e.type.split('::').slice(-1)[0],
        module: m,
        tx: e.id?.txDigest || '',
        ts: t,
        sender: e.sender || '',
      });
      if (!t) continue;
      const day = new Date(t); day.setHours(0, 0, 0, 0);
      const key = day.getTime();
      tsBuckets.set(key, (tsBuckets.get(key) || 0) + 1);
    }
  }
  feed.sort((a, b) => b.ts - a.ts);
  return { perMod, total, tsBuckets, feed };
}

/* ============================================================
   Render
   ============================================================ */

const monthFmt = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' });
const fullFmt = new Intl.DateTimeFormat('en', { month: 'long', day: 'numeric', year: 'numeric' });

let chartData = []; // [{ key, label, full, v }]
let chartModule = 'all'; // active Activity-Overview filter (real, drives the chart)
const agentFilters = { q: '', scope: 'all', minScore: 0, reliability: 'all', recent: 'all' };

// Build per-day buckets from the live feed, optionally filtered to one module.
function bucketsForModule(mod) {
  const feed = STATE.activity.feed || [];
  const buckets = new Map();
  for (const e of feed) {
    if (mod !== 'all' && e.module !== mod) continue;
    if (!e.ts) continue;
    const day = new Date(e.ts); day.setHours(0, 0, 0, 0);
    const key = day.getTime();
    buckets.set(key, (buckets.get(key) || 0) + 1);
  }
  return buckets;
}

function renderChart(tsBuckets) {
  const buckets = tsBuckets || bucketsForModule(chartModule);
  const barsEl = $('bars');
  const entries = [...buckets.entries()].sort((a, b) => a[0] - b[0]).slice(-8);
  if (!entries.length) {
    barsEl.innerHTML = '<div class="empty-state" style="grid-column:1/-1">No timestamped events yet.</div>';
    return;
  }
  const max = Math.max(...entries.map((e) => e[1]), 1);
  chartData = entries.map(([key, v]) => {
    const d = new Date(Number(key));
    return { key, v, label: monthFmt.format(d), full: fullFmt.format(d), h: Math.max(8, Math.round((v / max) * 100)) };
  });

  const lastIdx = chartData.length - 1;
  barsEl.innerHTML = '';
  chartData.forEach((d, i) => {
    const wrap = document.createElement('div');
    wrap.className = 'bar-wrap' + (i === lastIdx ? ' active' : '');
    wrap.dataset.i = i;
    wrap.innerHTML =
      '<div class="bar" style="height:' + d.h + '%">' +
        (i === lastIdx ? '<div class="cap"><span class="nub"></span><div class="body"><i></i><i></i><i></i></div></div>' : '') +
      '</div><div class="bar-month">' + d.label + '</div>';
    barsEl.appendChild(wrap);
  });
  wireChart(lastIdx);
}

function wireChart(initialIdx) {
  const barsEl = $('bars');
  const tooltip = $('tooltip');
  const tDate = $('tDate');
  const tVal = $('tVal');
  let activeIndex = initialIdx;

  function positionTooltip(index) {
    const wrap = barsEl.children[index];
    if (!wrap) return;
    const bar = wrap.querySelector('.bar');
    const chart = tooltip.parentElement;
    const cRect = chart.getBoundingClientRect();
    const bRect = bar.getBoundingClientRect();
    tooltip.style.display = 'block';
    tooltip.style.left = (bRect.left - cRect.left + bRect.width / 2) + 'px';
    tooltip.style.top = (bRect.top - cRect.top - 18) + 'px';
    tDate.textContent = chartData[index].full;
    tVal.textContent = chartData[index].v + ' events';
  }
  function setActive(index) {
    [...barsEl.children].forEach((w) => {
      w.classList.remove('active');
      const cap = w.querySelector('.cap');
      if (cap) cap.remove();
    });
    const wrap = barsEl.children[index];
    wrap.classList.add('active');
    const bar = wrap.querySelector('.bar');
    if (!bar.querySelector('.cap')) {
      const cap = document.createElement('div');
      cap.className = 'cap';
      cap.innerHTML = '<span class="nub"></span><div class="body"><i></i><i></i><i></i></div>';
      bar.appendChild(cap);
    }
    activeIndex = index;
    positionTooltip(index);
  }
  [...barsEl.children].forEach((wrap, i) => {
    wrap.addEventListener('mouseenter', () => positionTooltip(i));
    wrap.addEventListener('mouseleave', () => positionTooltip(activeIndex));
    wrap.addEventListener('click', () => setActive(i));
  });
  const initTip = () => positionTooltip(activeIndex);
  requestAnimationFrame(initTip);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(initTip);
  setTimeout(initTip, 200);
  window.addEventListener('resize', initTip);
}

function statusIcon(status) {
  if (status === 1) // merged
    return '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="9" r="2.5"/><path d="M6 8.5v7M8.5 6H14a2 2 0 0 1 2 2v.5"/></svg>';
  if (status === 2) // closed
    return '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><path d="M6 8.5v7"/><path d="M15 4l5 5M20 4l-5 5"/></svg>';
  return '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="12" r="2.5"/><path d="M8.5 6H14a2 2 0 0 1 2 2v1.5M8.5 18H14a2 2 0 0 0 2-2v-1.5"/></svg>';
}

let allPRs = [];
function renderPRTable(filter = 'all') {
  const body = $('delBody');
  const rows = filter === 'all' ? allPRs : allPRs.filter((p) => prStatusLabel(p.status) === filter);
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="5"><div class="empty-state">No pull requests' + (filter === 'all' ? ' yet' : ' with status “' + filter + '”') + '.</div></td></tr>';
    return;
  }
  body.innerHTML = rows.map((p) => {
    const st = prStatusLabel(p.status);
    return '<tr>' +
      '<td><a class="td-id link" target="_blank" rel="noreferrer" href="' + explorerObject(p.id) + '">' + short(p.id) + '</a></td>' +
      '<td>' + escapeHtml(p.title || '(untitled)') + '</td>' +
      '<td><a class="mono link" target="_blank" rel="noreferrer" href="' + explorerObject(p.author) + '">' + short(p.author) + '</a></td>' +
      '<td class="mono" style="color:var(--tx-2)">' + (p.reviewRefs?.length || 0) + '</td>' +
      '<td><span class="status ' + st + '">' + statusIcon(p.status) + st.charAt(0).toUpperCase() + st.slice(1) + '</span></td>' +
    '</tr>';
  }).join('');
}

function renderReleases(releases, repoNameById) {
  const list = $('buyList');
  if (!releases.length) {
    list.innerHTML = '<div class="empty-state">No releases published yet.</div>';
    return;
  }
  list.innerHTML = releases.map((r) =>
    '<div class="buy-item">' +
      '<div class="buy-thumb"><svg class="ico" viewBox="0 0 24 24" fill="none" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 1 1-3.5-6.6"/><path d="M9 12l2 2 4-5"/></svg></div>' +
      '<div class="buy-info">' +
        '<div class="buy-name" title="' + escapeHtml(r.version + ' · ' + (repoNameById.get(r.repoId) || short(r.repoId))) + '">' + escapeHtml(r.version) + ' · ' + escapeHtml(repoNameById.get(r.repoId) || short(r.repoId)) + '</div>' +
        '<div class="buy-row"><span class="k">Status :</span><span class="pill released">Released</span></div>' +
        '<div class="buy-row"><span class="k">By :</span><a class="v link" target="_blank" rel="noreferrer" href="' + explorerObject(r.publishedBy) + '">' + short(r.publishedBy) + '</a></div>' +
        '<div class="buy-row"><span class="k">Chain :</span>' +
          '<a class="v link" target="_blank" rel="noreferrer" href="' + blobUrl(r.sourceSnapshot) + '">source</a>›' +
          '<a class="v link" target="_blank" rel="noreferrer" href="' + blobUrl(r.buildArtifact) + '">artifact</a>›' +
          '<a class="v link" target="_blank" rel="noreferrer" href="' + blobUrl(r.testReport) + '">report</a>' +
        '</div>' +
      '</div>' +
    '</div>'
  ).join('');
}

function renderReputation(reps) {
  const list = $('repList');
  if (!reps.length) {
    list.innerHTML = '<div class="empty-state">No agent activity recorded yet.</div>';
    return;
  }
  list.innerHTML = reps.map((r) =>
    '<div class="rep-item">' +
      '<div class="rep-av">' + (r.agent ? r.agent.slice(2, 4).toUpperCase() : '··') + '</div>' +
      '<div class="rep-meta">' +
        '<a class="rep-addr link" target="_blank" rel="noreferrer" href="' + explorerObject(r.agent) + '">' + short(r.agent) + '</a>' +
        '<div class="rep-stats">' +
          '<span><b>' + r.prsOpened + '</b> PRs</span>' +
          '<span><b>' + r.prsMerged + '</b> merged</span>' +
          '<span><b>' + r.reviews + '</b> reviews</span>' +
          '<span><b>' + r.ciRuns + '</b> CI</span>' +
        '</div>' +
      '</div>' +
    '</div>'
  ).join('');
}

function sponsorDashboardUrl() {
  const u = SETTINGS.sponsorUrl || '';
  if (!u) return '';
  return u.endsWith('/sponsor') ? u.slice(0, -'/sponsor'.length) + '/dashboard' : u.replace(/\/$/, '') + '/dashboard';
}

async function renderSponsorDashboard() {
  const el = $('sponsorDash');
  if (!el) return;
  const url = sponsorDashboardUrl();
  const panel = $('sponsorPanel');
  if (!url) {
    // Gas is user-paid by default — the sponsor is optional, so hide the whole panel
    // rather than show a permanently "not enabled" card. Clear any skeleton first so no
    // stale loader lingers in the DOM.
    el.innerHTML = '';
    if (panel) panel.style.display = 'none';
    return;
  }
  if (panel) panel.style.display = '';
  el.innerHTML = '<div class="empty-state loading-pulse">Loading sponsor status...</div>';
  try {
    const d = await withTimeout(fetch(url).then((r) => {
      if (!r.ok) throw new Error('sponsor ' + r.status);
      return r.json();
    }), 6000, 'sponsor dashboard');
    const issuedGasBudget = Number(d.gasBudgetIssuedMist ?? d.spendEstimatedMist ?? 0);
    const pct = d.dailyBudgetMist ? Math.round((issuedGasBudget / Number(d.dailyBudgetMist)) * 100) : 0;
    el.innerHTML =
      '<div class="rep-item">' +
        '<div class="rep-meta" style="width:100%">' +
          '<div class="buy-row"><span class="k">Status :</span><span class="pill ' + (d.ok ? 'released' : 'closed') + '">' + (d.ok ? 'ready' : 'not ready') + '</span></div>' +
          '<div class="buy-row"><span class="k">Balance :</span><span class="v mono">' + suiAmount(Number(d.balanceMist || 0)) + ' SUI</span></div>' +
          '<div class="buy-row"><span class="k">Gas budget issued :</span><span class="v mono">' + suiAmount(issuedGasBudget) + ' / ' + suiAmount(Number(d.dailyBudgetMist || 0)) + ' SUI (' + pct + '%)</span></div>' +
          '<div class="buy-row"><span class="k">Rejected :</span><span class="v mono">' + Number(d.rejected || 0) + '</span></div>' +
          '<div class="buy-row"><span class="k">Rate-limit hits :</span><span class="v mono">' + Number(d.rateLimitHits || 0) + '</span></div>' +
          '<div class="buy-row"><span class="k">Write mode :</span><span class="v mono">' + escapeHtml(d.quotas?.writeMode || 'open') + '</span></div>' +
        '</div>' +
      '</div>';
  } catch (e) {
    el.innerHTML = '<div class="empty-state">Gas-free sponsorship is offline right now — actions still work, signed with your own wallet.</div>';
  }
}


function setStat(id, value) {
  const el = $(id);
  if (el) el.textContent = value;
}

function setNavCount(id, n) {
  const el = $(id);
  if (el) el.textContent = String(n);
}

/** A command panel. If `walletAction` is given AND a wallet is connected, also
 *  shows a primary button that signs the action in-browser. CLI is the fallback. */
function cmdPanel(title, cmd, note, walletAction) {
  let actionHtml = '';
  if (walletAction && STATE.wallet) {
    const id = 'wa-' + Math.random().toString(36).slice(2, 8);
    walletActions[id] = walletAction.fn;
    actionHtml = `<button class="cmd-action" data-wa="${id}">${escapeHtml(walletAction.label)}</button>`;
  }
  return '<div class="cmd-panel">' +
    '<div class="cmd-head"><span class="cmd-title">' + escapeHtml(title) + '</span>' +
    actionHtml +
    '<button class="cmd-copy" data-cmd="' + escapeHtml(cmd) + '" onclick="__wfCopy(this)">Copy</button></div>' +
    '<pre class="cmd-body"><code>' + escapeHtml(cmd) + '</code></pre>' +
    '<div class="cmd-note">' + escapeHtml(note || (STATE.wallet ? 'Sign in-browser, or run in your terminal.' : 'Connect a wallet to do this in-browser, or run it in your terminal.')) + '</div>' +
  '</div>';
}
const walletActions = {};
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-wa]');
  if (b && walletActions[b.dataset.wa]) walletActions[b.dataset.wa]();
});

function statError(id) {
  const el = $(id);
  if (el) el.innerHTML = '<span class="stat-err" title="failed to load — refresh to retry">—</span>';
}

function renderReadSourceBadge() {
  const src = readSourceSnapshot();
  const label = readSourceLabel();
  const badgeTxt = $('netBadgeTxt');
  if (badgeTxt) badgeTxt.textContent = `${CFG.network} · ${label}`;
  const badge = $('netBadge');
  if (!badge) return;
  const other = CFG.network === 'mainnet' ? 'testnet' : 'mainnet';
  const extra = src.lastError ? ` Last read error: ${src.lastError}` : '';
  badge.classList.toggle('degraded', Boolean(src.degraded || src.partial));
  badge.setAttribute('data-tip', `Sui ${CFG.network} · ${label} · click to switch to ${other}.${extra}`);
}

/* ============================================================
   Load everything live
   ============================================================ */

async function loadData() {
  // network not deployed yet (e.g. mainnet before publish) — show a clear notice.
  if (!CFG_READY) {
    $('pkgShort').textContent = CFG.network + ' — not deployed';
    const msg = '<div class="empty-state">Signet is not yet deployed on <b>' + CFG.network +
      '</b>. Switch to testnet (remove ?network=mainnet) or publish the package and fill its address.</div>';
    ['reposGrid', 'prsList', 'releasesList', 'agentsGrid', 'packageTrust', 'issuesList', 'bountiesList', 'paymentsList', 'activityFeed', 'buyList', 'repList'].forEach((id) => { const el = $(id); if (el) el.innerHTML = msg; });
    ['statRepos', 'statPrs', 'statReleases', 'ovTotal'].forEach((id) => { const el = $(id); if (el) el.textContent = '—'; });
    return;
  }
  // package + owner header
  $('pkgShort').textContent = short(CFG.packageId);
  $('pkgLink').href = explorerObject(CFG.packageId);

  // Walrus Storage tab — endpoints follow the active network (testnet/mainnet)
  const aggHost = CFG.walrusAggregator.replace(/^https?:\/\//, '');
  const pubHost = CFG.walrusPublisher.replace(/^https?:\/\//, '');
  const aggEl = $('walAggregator');
  if (aggEl) { aggEl.textContent = aggHost; aggEl.href = CFG.walrusAggregator; }
  const pubEl = $('walPublisher');
  if (pubEl) pubEl.textContent = pubHost;

  // Network labels (badge + owner card) follow the active network, not a literal.
  // Use the active read source (Live RPC / GraphQL / gRPC / degraded) — do NOT
  // hard-code "live", which would hide the real transport selected via ?graphql/?grpc.
  const badgeTxt = $('netBadgeTxt');
  if (badgeTxt) badgeTxt.textContent = `${CFG.network} · ${readSourceLabel()}`;
  const badge = $('netBadge');
  if (badge) {
    const other = CFG.network === 'mainnet' ? 'testnet' : 'mainnet';
    badge.setAttribute('data-tip', `Sui ${CFG.network} · click to switch to ${other}`);
    badge.classList.add('net-switch');
    if (!badge.dataset.wired) {
      badge.dataset.wired = '1';
      // The `sui` RPC client is a module singleton, so switching networks must reload
      // the page (the ?network= query also persists to localStorage via pickNetwork).
      badge.addEventListener('click', () => {
        const next = CFG.network === 'mainnet' ? 'testnet' : 'mainnet';
        try { localStorage.setItem('wf.network', next); } catch {}
        location.search = '?network=' + next;
      });
    }
  }
  renderReadSourceBadge();
  const ownerNet = $('ownerNet');
  if (ownerNet) ownerNet.textContent = 'Sui ' + CFG.network;

  // skeleton placeholders on first load (not on refresh, to avoid flicker)
  if (!STATE.loaded) {
    const setSkel = (id, html) => { const el = $(id); if (el) el.innerHTML = html; };
    setSkel('reposGrid', skeletonCards(4));
    setSkel('prsList', skeletonCards(3));
    setSkel('releasesList', skeletonCards(2));
    setSkel('agentsGrid', skeletonCards(3));
    setSkel('issuesList', skeletonCards(2));
    setSkel('bountiesList', skeletonCards(2));
    setSkel('paymentsList', skeletonCards(2));
    setSkel('activityFeed', skeletonList(5));
    setSkel('buyList', skeletonList(3));
    setSkel('repList', skeletonList(3));
    setSkel('sponsorDash', skeletonList(1));
    setSkel('delBody', skeletonRows(4));
  }

  try {
    // withTimeout turns a hung fullnode into the same empty-state fallback as a
    // rejection, so a slow RPC can never leave a view spinning forever.
    const [repos, prs, releases, reps, issues, bounties, payments, activity, agentCaps, reviewEvents, vouchEvents, bountyEvents] = await Promise.all([
      withTimeout(listRepos(), 15000, 'repos'),
      withTimeout(listAllPullRequests(), 15000, 'prs'),
      withTimeout(listAllReleases(), 15000, 'releases'),
      withTimeout(listAllReputation(), 15000, 'reputation'),
      withTimeout(listAllIssues(), 15000, 'issues'),
      withTimeout(listAllBounties(), 15000, 'bounties'),
      withTimeout(listAllPayments(), 15000, 'payments'),
      withTimeout(listActivity(), 15000, 'activity'),
      withTimeout(listAgentCaps(), 15000, 'caps'),
      withTimeout(listReviewEvents(), 15000, 'reviews'),
      withTimeout(listVouchEvents(), 15000, 'vouches'),
      withTimeout(listBountyLifecycleEvents(), 15000, 'bounty lifecycle'),
    ]);

    // Current epoch (best-effort) — lets the agents view flag expired / soon-to-expire
    // AgentCaps honestly instead of always showing "active".
    try { STATE.epoch = Number((await withTimeout(sui.getLatestSuiSystemState(), 8000, 'epoch'))?.epoch ?? 0) || null; }
    catch { STATE.epoch = STATE.epoch ?? null; }

    // owner from first repo (owner card may be absent — guard each element)
    const ownerAddrEl = $('ownerAddr');
    if (repos[0]?.owner) {
      if (ownerAddrEl) ownerAddrEl.textContent = short(repos[0].owner);
      const ownerAvEl = $('ownerAv');
      if (ownerAvEl) ownerAvEl.textContent = repos[0].owner.slice(2, 4).toUpperCase();
      const ownerLinkEl = $('ownerLink');
      if (ownerLinkEl) ownerLinkEl.href = explorerObject(repos[0].owner);
    } else if (ownerAddrEl) {
      ownerAddrEl.textContent = 'no repos';
    }

    // stat cards
    setStat('statRepos', String(repos.length));
    const openPrs = prs.filter((p) => p.status === 0).length;
    setStat('statPrs', String(openPrs));
    setStat('statReleases', String(releases.length));
    setStat('ovTotal', String(activity.total));
    $('navRepoCount').textContent = String(repos.length);
    $('navReleaseCount').textContent = String(releases.length);
    const merged = prs.filter((p) => p.status === 1).length;
    $('statPrsNote').textContent = merged + ' merged';

    // tables / lists
    allPRs = prs;
    renderPRTable('all');
    const repoNameById = new Map(repos.map((r) => [r.id, r.name]));
    renderReleases(releases, repoNameById);
    renderReputation(reps);
    renderSponsorDashboard();

    // chart — respects the active Activity-Overview module filter
    renderChart();

    if (!repos.length && !prs.length) {
      $('ovBadge').textContent = 'no data';
    }

    // nav counts for new tabs
    setNavCount('navIssueCount', issues.length);
    setNavCount('navBountyCount', bounties.length);
    setNavCount('navPaymentCount', payments.length);

    // cache for the other views + render them
    STATE.repos = repos;
    STATE.prs = prs;
    STATE.releases = releases;
    STATE.reps = reps;
    STATE.issues = issues;
    STATE.bounties = bounties;
    STATE.payments = payments;
    STATE.activity = activity;
    STATE.repoNameById = repoNameById;
    STATE.agentCaps = agentCaps;
    STATE.reviewEvents = reviewEvents;
    STATE.vouchEvents = vouchEvents;
    STATE.bountyEvents = bountyEvents;
    try {
      STATE.reliability = await withTimeout(loadReliability(), 12000, 'reliability');
    } catch (e) {
      STATE.reliability = new Map();
      toast('Reliability ledger did not sync: ' + (e.message || e), { kind: 'error', action: { label: 'Retry', onClick: refresh } });
    }
    STATE.loaded = true;
    renderReadSourceBadge();
    renderReposView();
    renderPRsView('all');
    renderReleasesView();
    renderAgentsView();
    renderPackagesView();
    renderIssuesView();
    renderBountiesView();
    renderPaymentsView();
    renderActivityView();
    renderVerifyView();

    STATE.lastUpdated = Date.now();
    tickLastUpdated();
    document.dispatchEvent(new CustomEvent('wf:data-loaded'));
  } catch (err) {
    console.error('Signet load failed:', err);
    renderReadSourceBadge();
    const syncMsg = decodeSuiError(err).message;
    ['statRepos', 'statPrs', 'statReleases', 'ovTotal'].forEach(statError);
    $('delBody').innerHTML = '<tr><td colspan="5"><div class="empty-state err">Failed to reach Sui RPC.</div></td></tr>';
    $('buyList').innerHTML = '<div class="empty-state err">RPC unavailable.</div>';
    $('repList').innerHTML = '<div class="empty-state err">RPC unavailable.</div>';
    $('bars').innerHTML = '<div class="empty-state err" style="grid-column:1/-1">RPC unavailable.</div>';
    // Secondary list views also get an error state (else they stay on skeletons forever).
    ['reposGrid', 'prsList', 'releasesList', 'agentsGrid', 'issuesList', 'bountiesList', 'paymentsList', 'activityFeed'].forEach((id) => {
      const el = $(id); if (el) el.innerHTML = '<div class="empty-state err">Data did not sync: ' + escapeHtml(syncMsg) + '</div>';
    });
    toast('Data did not sync: ' + syncMsg, { kind: 'error', action: { label: 'Retry', onClick: refresh } });
  }
}

/* ---------- Refresh / last-updated / auto-poll ---------- */
let _refreshing = false;
async function refresh() {
  if (_refreshing) return;
  _refreshing = true;
  const btn = $('refreshBtn');
  if (btn) btn.classList.add('spinning');
  try {
    await loadData();
  } finally {
    _refreshing = false;
    if (btn) btn.classList.remove('spinning');
  }
}

function tickLastUpdated() {
  const el = $('lastUpdated');
  if (el) el.textContent = STATE.lastUpdated ? relativeTime(STATE.lastUpdated) : '—';
}
setInterval(tickLastUpdated, 5000);

let _pollTimer = null;
function applyAutoPoll() {
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
  if (SETTINGS.autoRefresh) {
    _pollTimer = setInterval(() => { if (!document.hidden) refresh(); }, Math.max(10, SETTINGS.refreshSeconds) * 1000);
  }
}

/* ============================================================
   Static interactions (from reference, unchanged behaviour)
   ============================================================ */

function wireUI() {
  // sidebar collapse
  $('collapseBtn').addEventListener('click', () => {
    $('app').classList.toggle('collapsed');
  });

  // pull-requests submenu toggle
  const trackToggle = $('trackToggle');
  const trackSub = $('trackSub');
  trackSub.style.maxHeight = trackSub.scrollHeight + 'px';
  trackToggle.addEventListener('click', () => {
    const open = trackToggle.classList.toggle('open');
    trackSub.style.maxHeight = open ? trackSub.scrollHeight + 'px' : '0px';
    trackSub.style.opacity = open ? '1' : '0';
  });
  // PR status filter — filters both the dashboard table and the PRs view
  trackSub.querySelectorAll('.subitem').forEach((s) => {
    s.addEventListener('click', (e) => {
      e.stopPropagation();
      trackSub.querySelectorAll('.subitem').forEach((x) => x.classList.remove('active'));
      s.classList.add('active');
      const fl = s.dataset.prfilter || 'all';
      renderPRTable(fl);
      document.querySelectorAll('[data-nav]').forEach((x) => x.classList.remove('active'));
      showView('prs');
      renderPRsView(fl);
    });
  });

  // nav active state + view routing
  document.querySelectorAll('[data-nav]').forEach((n) => {
    n.addEventListener('click', () => {
      document.querySelectorAll('[data-nav]').forEach((x) => x.classList.remove('active'));
      n.classList.add('active');
      showView(n.dataset.nav || 'dashboard');
    });
  });
  // clicking "Pull Requests" parent (which is a submenu toggle, not data-nav) routes too
  $('trackToggle').addEventListener('click', () => {
    document.querySelectorAll('[data-nav]').forEach((x) => x.classList.remove('active'));
    showView('prs');
  });

  // detail "← Back" returns to the originating list view
  const back = $('detailBack');
  if (back) back.addEventListener('click', () => {
    document.querySelectorAll('[data-nav]').forEach((x) =>
      x.classList.toggle('active', x.dataset.nav === backTo));
    showView(backTo);
  });

  // Verify tab: run verification for the selected release
  const vBtn = $('verifyBtn');
  if (vBtn) vBtn.addEventListener('click', () => {
    const id = $('verifySelect').value;
    runVerify(id, $('verifyOut'), vBtn);
  });
  wireAgentFilters();

  // overview dropdown
  const ovDropdown = $('ovDropdown');
  $('ddBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    ovDropdown.classList.toggle('open');
  });
  // Maps each menu label to a Move module (or 'all'); drives the chart for real.
  const LABEL_TO_MODULE = {
    'All Modules': 'all', 'Repositories': 'forge', 'Pull Requests': 'pull_request',
    'Releases': 'release', 'Issues': 'issue', 'Bounties': 'bounty', 'Reputation': 'reputation',
  };
  ovDropdown.querySelectorAll('.dd-menu div').forEach((opt) => {
    opt.addEventListener('click', () => {
      ovDropdown.querySelectorAll('.dd-menu div').forEach((x) => x.classList.remove('sel'));
      opt.classList.add('sel');
      $('ddLabel').textContent = opt.textContent;
      ovDropdown.classList.remove('open');
      chartModule = LABEL_TO_MODULE[opt.textContent.trim()] ?? 'all';
      renderChart(); // re-bucket the live feed for the chosen module
    });
  });
  document.addEventListener('click', (e) => {
    if (!ovDropdown.contains(e.target)) ovDropdown.classList.remove('open');
  });
}

function wireAgentFilters() {
  const search = $('agentSearch');
  if (!search || search.dataset.wired) return;
  search.dataset.wired = '1';
  const sync = () => {
    agentFilters.q = search.value || '';
    agentFilters.scope = $('agentScope')?.value || 'all';
    agentFilters.minScore = Number($('agentScore')?.value || 0);
    agentFilters.reliability = $('agentReliability')?.value || 'all';
    agentFilters.recent = $('agentRecent')?.value || 'all';
    if (STATE.loaded) renderAgentsView();
  };
  search.addEventListener('input', sync);
  ['agentScope', 'agentScore', 'agentReliability', 'agentRecent'].forEach((id) => {
    const el = $(id);
    if (el) el.addEventListener('change', sync);
  });
}

/* ============================================================
   View routing (single-page; swaps #view-* sections)
   ============================================================ */

const VIEW_TITLES = {
  dashboard: 'Dashboard', playground: 'Playground', repos: 'Repositories', prs: 'Pull Requests',
  releases: 'Releases', packages: 'Packages', agents: 'Agents', issues: 'Issues', bounties: 'Bounties',
  payments: 'Payments',
  activity: 'Activity', verify: 'Verify', trust: 'Trust Model',
  walrus: 'Walrus Storage', mcp: 'MCP / Agents API', detail: 'Detail',
};

let _pgInit = false;
function showView(name) {
  const target = VIEW_TITLES[name] ? name : 'dashboard';
  document.querySelectorAll('.view').forEach((v) => {
    v.style.display = v.id === 'view-' + target ? '' : 'none';
  });
  const crumb = $('crumbCur');
  if (crumb) crumb.textContent = VIEW_TITLES[target];
  // re-fit the dashboard tooltip when returning to it
  if (target === 'dashboard') window.dispatchEvent(new Event('resize'));
  // lazy-init the Playground (build the view + load the gallery on first open)
  if (target === 'playground') {
    renderPlaygroundView();
    if (!_pgInit) { _pgInit = true; loadGallery(); }
  }
  if (target === 'payments') renderPaymentsView();
}

/* ---------- Repositories view ---------- */
function renderReposView() {
  const el = $('reposGrid');
  if (!el) return;
  const cmd = cmdPanel('Create a repository',
    'npm run forge -- init --name <repo-name> --dir <path-to-code>',
    'Creating a repo snapshots your code to Walrus and creates the on-chain Repository. Runs in your terminal (local keystore) — or import from GitHub →',
    { label: '⭳ Import from GitHub', fn: () => actImportFromGitHub() });
  if (!STATE.repos.length) { el.innerHTML = cmd + '<div class="empty-state">No repositories on-chain yet.</div>'; return; }
  el.innerHTML = cmd + STATE.repos.map((r) =>
    '<div class="repo-card clickable" data-repoid="' + r.id + '">' +
      '<div class="repo-card-head">' +
        '<div class="repo-ico"><svg class="ico" viewBox="0 0 24 24" fill="none" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3v12"/><circle cx="5" cy="18" r="2.5"/><circle cx="18" cy="6" r="2.5"/><path d="M18 8.5V13a4 4 0 0 1-4 4H7"/></svg></div>' +
        '<div><div class="repo-name" title="' + escapeHtml(r.name) + '">' + escapeHtml(r.name) + '</div>' +
        '<div class="repo-branch">' + escapeHtml(r.defaultBranch || 'main') + ' · ref v' + r.refVersion + '</div></div>' +
        (r.latestRelease ? '<span class="pill released" style="margin-left:auto">released</span>' : '') +
      '</div>' +
      '<div class="repo-meta">' +
        '<div><span class="k">Owner</span><span class="mono">' + escapeHtml(nameOrShort(r.owner)) + (STATE.wallet?.address === r.owner ? ' <span class="you-tag">you</span>' : '') + '</span></div>' +
        '<div><span class="k">Snapshot</span><span class="mono">' + short(r.currentSnapshot) + '</span></div>' +
        '<div><span class="k">Files &amp; PRs</span><span class="mono">open →</span></div>' +
      '</div>' +
    '</div>'
  ).join('');
  el.querySelectorAll('.repo-card.clickable').forEach((c) =>
    c.addEventListener('click', () => showRepoDetail(c.dataset.repoid)));
}

/* ---------- Pull Requests view ---------- */
function renderPRsView(filter = 'all') {
  const el = $('prsList');
  if (!el) return;
  const rows = filter === 'all' ? STATE.prs : STATE.prs.filter((p) => prStatusLabel(p.status) === filter);
  $('prsFilterLabel').textContent = filter === 'all' ? 'all' : filter;
  const cmd = cmdPanel('Open a pull request (as an agent)',
    'npm run forge -- open-pr --cap <AGENT_CAP> --title "<title>" --dir <path>',
    'Agents open PRs under a scoped AgentCap (CLI or MCP pr_create). Click a PR below for its diff + reviews. The web is read-only.');
  if (!rows.length) { el.innerHTML = cmd + '<div class="empty-state">No pull requests' + (filter === 'all' ? '' : ' with status “' + filter + '”') + '.</div>'; return; }
  el.innerHTML = cmd + rows.map((p) => prCardHtml(p)).join('');
  wirePrCards(el);
}

/* ---------- Releases view (provenance chain) ---------- */
function renderReleasesView() {
  const el = $('releasesList');
  if (!el) return;
  const cmd = cmdPanel('Publish a release (owner only)',
    'npm run forge -- release --tag <v> --artifact <file> --report <file>',
    'Publishing pins source → artifact → report on Walrus + Sui. Click a release for the full chain. Owner-only; runs in your terminal.');
  if (!STATE.releases.length) { el.innerHTML = cmd + '<div class="empty-state">No releases published yet.</div>'; return; }
  const node = (label, blob, accent) =>
    '<a class="chain-node ' + accent + '" target="_blank" rel="noreferrer" href="' + blobUrl(blob) + '" onclick="event.stopPropagation()">' +
      '<span class="chain-label">' + label + '</span><span class="chain-blob mono">' + short(blob) + '</span></a>';
  el.innerHTML = cmd + STATE.releases.map((r) =>
    '<div class="release-card clickable" data-relid="' + r.id + '">' +
      '<div class="release-head">' +
        '<div class="buy-thumb"><svg class="ico" viewBox="0 0 24 24" fill="none" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 1 1-3.5-6.6"/><path d="M9 12l2 2 4-5"/></svg></div>' +
        '<div><div class="repo-name">' + escapeHtml(r.version) + '</div>' +
        '<div class="repo-branch">' + escapeHtml(STATE.repoNameById.get(r.repoId) || short(r.repoId)) +
        ' · by ' + short(r.publishedBy) + '</div></div>' +
        '<span class="slsa-badge" id="slsa-' + r.id + '" style="margin-left:auto">verifying…</span>' +
      '</div>' +
      '<div class="chain">' +
        node('Source snapshot', r.sourceSnapshot, 'g') +
        '<span class="chain-arrow">›</span>' +
        node('Build artifact', r.buildArtifact, 'b') +
        '<span class="chain-arrow">›</span>' +
        node('Test report', r.testReport, 'v') +
      '</div>' +
    '</div>'
  ).join('');
  el.querySelectorAll('.release-card.clickable').forEach((c) =>
    c.addEventListener('click', () => showReleaseDetail(c.dataset.relid)));
  // lazily compute the SLSA-style provenance badge per release
  STATE.releases.forEach((r) => {
    verifyReleaseBrowser(r.id).then((res) => {
      const b = $('slsa-' + r.id);
      if (!b) return;
      b.textContent = res.pass ? '✓ ' + res.levelLabel : '✗ unverified';
      if (!res.pass) { b.style.color = 'var(--red)'; b.style.borderColor = 'rgba(241,91,76,.35)'; b.style.background = 'rgba(241,91,76,.08)'; }
    }).catch((e) => {
      const b = $('slsa-' + r.id);
      if (!b) return;
      b.textContent = 'verify failed';
      b.title = e?.message || String(e);
      b.style.color = 'var(--red)';
      b.style.borderColor = 'rgba(241,91,76,.35)';
      b.style.background = 'rgba(241,91,76,.08)';
    });
  });
}

/* ---------- Agents view (reputation, expanded) ---------- */
function capMatchesScope(cap, scope) {
  if (scope === 'all') return true;
  if (!cap) return false;
  if (scope === 'active') return !cap.revoked;
  const bits = { open_pr: SCOPE_OPEN_PR, review: SCOPE_REVIEW, run_ci: SCOPE_RUN_CI };
  return (cap.scopes & bits[scope]) === bits[scope];
}

/** Read the on-chain ReliabilityLedger (Table<address, AgentReliability>) into a
    Map of address -> { disputed, expired }. Empty if the ledger isn't configured. */
async function loadReliability() {
  const m = new Map();
  if (!CFG.reliabilityLedger) return m;
  const led = await readGetObject({ id: CFG.reliabilityLedger, options: { showContent: true } });
  const tableId = led?.data?.content?.fields?.records?.fields?.id?.id;
  if (!tableId) return m;
  let cursor = null;
  do {
    const page = await sui.getDynamicFields({ parentId: tableId, cursor });
    const ids = page.data.map((d) => d.objectId);
    if (ids.length) {
      const objs = await readMultiGetObjects({ ids, options: { showContent: true } });
      for (const o of objs) {
        const f = o.data?.content?.fields;
        if (!f) continue;
        const v = f.value?.fields || f.value || {};
        m.set(f.name, { disputed: Number(v.disputed || 0), expired: Number(v.expired || 0) });
      }
    }
    cursor = page.hasNextPage ? page.nextCursor : null;
  } while (cursor);
  return m;
}

function agentSummary(addr) {
  const prs = STATE.prs.filter((p) => p.author === addr);
  const reviews = STATE.reviewEvents.filter((r) => r.reviewer === addr);
  const vouches = STATE.vouchEvents.filter((v) => v.subject === addr);
  const claimed = STATE.bountyEvents.claimed.filter((e) => e.claimant === addr);
  const paid = STATE.bountyEvents.paid.filter((e) => e.claimant === addr);
  const bounties = STATE.bounties.filter((b) => b.claimant === addr || claimed.some((e) => e.bounty_id === b.id));
  const opened = prs.length;
  const merged = prs.filter((p) => p.status === 1).length;
  const totalWork = opened + reviews.length + claimed.length;
  const completed = merged + reviews.length + paid.length;
  // SLA signals from the on-chain ReliabilityLedger (falls back to 0 if absent);
  // disputed also counts any live disputed-status bounties not yet in the ledger.
  const rel = STATE.reliability?.get(addr) || { disputed: 0, expired: 0 };
  const liveDisputed = bounties.filter((b) => b.status === 4).length;
  const disputed = Math.max(rel.disputed, liveDisputed);
  const expired = rel.expired;
  const reliability = totalWork ? completed / totalWork : 0;
  const recentTs = Math.max(0, ...prs.map((p) => p.ts || 0), ...reviews.map((r) => r.ts || 0), ...claimed.map((e) => e.ts || 0), ...paid.map((e) => e.ts || 0), ...vouches.map((e) => e.ts || 0));
  const repoIds = new Set([...prs.map((p) => p.repoId), ...reviews.map((r) => STATE.prs.find((p) => p.id === r.prId)?.repoId), ...bounties.map((b) => b.repoId)].filter(Boolean));
  return { prs, reviews, vouches, claimed, paid, bounties, opened, merged, totalWork, completed, reliability, disputed, expired, recentTs, repoIds };
}

function filteredAgents() {
  const q = agentFilters.q.trim().toLowerCase();
  const minScore = Number(agentFilters.minScore || 0);
  const minRel = agentFilters.reliability === 'all' ? 0 : Number(agentFilters.reliability);
  return STATE.reps
    .map((r) => ({ rep: r, cap: STATE.agentCaps.get(r.agent), summary: agentSummary(r.agent) }))
    .filter(({ rep, cap, summary }) => {
      if (q && !rep.agent.toLowerCase().includes(q) && !String(nameOrShort(rep.agent)).toLowerCase().includes(q)) return false;
      if (rep.score < minScore) return false;
      if (!capMatchesScope(cap, agentFilters.scope)) return false;
      if (minRel && summary.reliability < minRel) return false;
      if (agentFilters.recent === 'active' && !rep.lastEpoch) return false;
      if (agentFilters.recent === 'cap' && !cap) return false;
      return true;
    })
    .sort((a, b) => b.rep.score - a.rep.score || b.summary.recentTs - a.summary.recentTs);
}

function renderAgentsView() {
  const el = $('agentsGrid');
  if (!el) return;
  if (!STATE.reps.length) { el.innerHTML = '<div class="empty-state">No agent activity recorded yet.</div>'; return; }
  const rows = filteredAgents();
  const summaryEl = $('agentMarketSummary');
  if (summaryEl) {
    const activeCaps = rows.filter((x) => x.cap && !x.cap.revoked).length;
    const avgReliability = rows.length ? Math.round(rows.reduce((n, x) => n + x.summary.reliability, 0) / rows.length * 100) : 0;
    summaryEl.textContent = `${rows.length} agent(s) · ${activeCaps} active cap(s) · avg reliability ${avgReliability}%`;
  }
  if (!rows.length) { el.innerHTML = '<div class="empty-state">No agents match the selected filters.</div>'; return; }
  el.innerHTML = rows.map(({ rep: r, cap, summary }) => {
    let delegation;
    if (cap) {
      const chips = scopeChips(cap.scopes).map((s) => '<span class="scope-chip">' + s + '</span>').join('');
      const ep = STATE.epoch;
      const expired = !cap.revoked && cap.expires && ep != null && cap.expires <= ep;
      const soon = !cap.revoked && !expired && cap.expires && ep != null && (cap.expires - ep) <= 5;
      const status = cap.revoked ? '<span class="cap-status revoked">revoked</span>'
        : expired ? '<span class="cap-status revoked">expired</span>'
        : soon ? '<span class="cap-status soon">expires soon</span>'
        : '<span class="cap-status active">active</span>';
      const exp = cap.expires
        ? ' · expires epoch ' + cap.expires + (ep != null && !expired ? ' (~' + Math.max(0, cap.expires - ep) + ' epochs left)' : '')
        : ' · no expiry';
      delegation =
        '<div class="delegation">' +
          '<div class="deleg-line"><span class="mono">owner</span><span class="deleg-arrow">→</span>' +
            '<span class="mono">AgentCap ' + short(cap.capId) + '</span>' + status + '</div>' +
          '<div class="deleg-scopes">scope: ' + (chips || '<span class="scope-chip none">none</span>') + exp + '</div>' +
          '<div class="deleg-note">cannot merge or publish — structurally absent from agent scope</div>' +
        '</div>';
    } else {
      delegation = '<div class="delegation"><div class="deleg-note">No AgentCap grant found (acted as owner, or grant pre-dates the scan window).</div></div>';
    }
    const canVouch = STATE.wallet && STATE.wallet.address !== r.agent && STATE.repos[0];
    const vouchBtn = canVouch
      ? '<button class="cmd-action vouch-btn" data-vouch="' + r.agent + '" style="margin-left:auto">Vouch</button>'
      : '';
    const relPct = Math.round(summary.reliability * 100);
    const last = summary.recentTs ? relativeTime(summary.recentTs) : (r.lastEpoch ? 'epoch ' + r.lastEpoch : 'no recent event');
    return '<div class="agent-card">' +
      '<div class="agent-card-head">' +
        '<div class="rep-av" style="width:48px;height:48px;font-size:14px">' + (r.agent ? r.agent.slice(2, 4).toUpperCase() : '··') + '</div>' +
        '<button class="agent-link" data-agent="' + r.agent + '">' + escapeHtml(nameOrShort(r.agent)) + '</button>' +
        (STATE.wallet?.address === r.agent ? '<span class="you-tag">you</span>' : '') +
        '<span class="tier-badge ' + scoreTier(r.score).cls + '" data-tip="Trust tier derived from on-chain score" style="margin-left:auto">' + scoreTier(r.score).tier + '</span>' +
        '<span class="score-badge" data-tip="Aggregate trust score (merged·10 + reviews·3 + CI·2 + vouches·5)">' + r.score + '</span>' +
      '</div>' +
      '<div class="agent-stats">' +
        '<div class="agent-stat"><div class="as-num">' + r.prsMerged + '</div><div class="as-lbl">merged</div></div>' +
        '<div class="agent-stat"><div class="as-num">' + r.reviews + '</div><div class="as-lbl">reviews</div></div>' +
        '<div class="agent-stat"><div class="as-num">' + r.ciRuns + '</div><div class="as-lbl">CI runs</div></div>' +
        '<div class="agent-stat"><div class="as-num">' + r.vouches + '</div><div class="as-lbl">vouches</div></div>' +
      '</div>' +
      '<div class="agent-market-row">' +
        '<span class="market-pill">scope ' + escapeHtml(cap ? scopeChips(cap.scopes).join(', ') || 'none' : 'none') + '</span>' +
        '<span class="market-pill">reliability ' + relPct + '%</span>' +
        (summary.disputed > 0 ? '<span class="market-pill" data-tip="Disputed work (on-chain ReliabilityLedger)">⚖ ' + summary.disputed + ' disputed</span>' : '') +
        (summary.expired > 0 ? '<span class="market-pill" data-tip="Bounties reclaimed past deadline (on-chain)">⏳ ' + summary.expired + ' expired</span>' : '') +
        '<span class="market-pill">repos ' + summary.repoIds.size + '</span>' +
        '<span class="market-pill">last ' + escapeHtml(last) + '</span>' +
      '</div>' +
      delegation +
      '<div class="agent-foot">' +
        '<button class="cmd-action profile-btn" data-profile="' + r.agent + '">Profile</button>' +
        '<button class="cmd-action prove-btn" data-prove="' + r.agent + '">Memory vault</button>' +
        vouchBtn +
      '</div>' +
      '<div class="agent-note">Reputation is a side effect of real signed on-chain actions — not self-reported.</div>' +
    '</div>';
  }).join('');
  el.querySelectorAll('.vouch-btn').forEach((b) =>
    b.addEventListener('click', () => actVouch(STATE.repos[0].id, b.dataset.vouch)));
  el.querySelectorAll('.prove-btn').forEach((b) =>
    b.addEventListener('click', () => proveAgentWork(b.dataset.prove)));
  el.querySelectorAll('.profile-btn,.agent-link').forEach((b) =>
    b.addEventListener('click', () => showAgentDetail(b.dataset.profile || b.dataset.agent)));
}

async function memoryVaultItems(addr) {
  const s = agentSummary(addr);
  const items = [];
  for (const p of s.prs) {
    items.push({ kind: 'PR source', title: p.title, blob: p.headSnapshot, objectId: p.id, tx: p.tx, repoId: p.repoId });
    if (p.diffManifest) items.push({ kind: 'PR diff', title: p.title, blob: p.diffManifest, objectId: p.id, tx: p.tx, repoId: p.repoId });
    const linked = STATE.releases.find((r) => r.mergedPrId === p.id || r.sourceSnapshot === p.headSnapshot);
    if (linked) items.push({ kind: 'Release proof', title: linked.version, objectId: linked.id, blob: linked.sourceSnapshot, repoId: linked.repoId });
  }
  for (const r of s.reviews) {
    const pr = STATE.prs.find((p) => p.id === r.prId);
    items.push({ kind: r.verdict === 1 ? 'Review approve' : 'Review report', title: pr?.title || ('verdict ' + r.verdict), blob: r.reportBlob, objectId: r.reviewId, tx: r.tx, repoId: pr?.repoId });
  }
  for (const b of s.bounties) {
    if (b.proof) items.push({ kind: 'Bounty proof', title: b.title, proof: b.proof, objectId: b.id, tx: b.tx, repoId: b.repoId });
    else items.push({ kind: 'Bounty claim', title: b.title, objectId: b.id, tx: b.tx, repoId: b.repoId });
  }
  for (const v of s.vouches) items.push({ kind: 'Vouch', title: 'vouched by ' + short(v.voucher), objectId: v.repoId, tx: v.tx, repoId: v.repoId });
  for (const item of items) {
    item.artifactType = artifactTypeLabel(item.kind);
    if (item.blob) item.ok = await blobAvailableBrowser(item.blob);
    else if (item.proof && !isValidSuiObjectId(item.proof)) item.ok = await blobAvailableBrowser(item.proof);
    else item.ok = true;
  }
  return items;
}

function itemLink(i) {
  if (i.blob) return { href: blobUrl(i.blob), label: short(i.blob) + ' ->' };
  if (i.proof && isValidSuiObjectId(i.proof)) return { href: explorerObject(i.proof), label: short(i.proof) + ' ->' };
  if (i.proof) return { href: blobUrl(i.proof), label: short(i.proof) + ' ->' };
  if (i.objectId && isValidSuiObjectId(i.objectId)) return { href: explorerObject(i.objectId), label: short(i.objectId) + ' ->' };
  if (i.tx) return { href: explorerTx(i.tx), label: short(i.tx) + ' ->' };
  return null;
}

/** "Memory vault": collect an agent's PRs, reviews, CI reports, proofs and
 *  vouches, then re-check Walrus availability for every blob-backed record. */
async function proveAgentWork(addr) {
  openModal({
    title: 'Memory vault · ' + short(addr),
    wide: true,
    bodyHtml: '<div class="empty-state loading-pulse">Reconstructing memory records from Sui events and Walrus blobs...</div>',
    onMount: async (body) => {
      const items = await memoryVaultItems(addr);
      if (!items.length) {
        body.innerHTML = '<div class="empty-state">No on-chain work found for this agent.</div>';
        return;
      }
      const allOk = items.every((i) => i.ok);
      body.innerHTML =
        '<p class="cmd-note" style="margin-bottom:14px">Each item below is an on-chain action whose payload lives on Walrus. ' +
        'A green check means the content is still retrievable or the proof is an on-chain object anchor.</p>' +
        '<div class="verify-steps">' + items.map((i) =>
          { const link = itemLink(i); return (
          '<div class="vstep ' + (i.ok ? 'ok' : 'bad') + '">' +
            '<span class="vmark">' + (i.ok ? '✓' : '✗') + '</span>' +
            '<span class="tier-badge tier-verified">' + escapeHtml(i.artifactType || 'artifact') + '</span>' +
            '<span class="vlabel">' + escapeHtml(i.kind) + ' · ' + escapeHtml(i.title || short(i.objectId || i.tx)) + '</span>' +
            (link ? '<a class="vdetail mono link" target="_blank" rel="noreferrer" href="' + link.href + '">' + escapeHtml(link.label) + '</a>' : '<span class="vdetail mono">anchored</span>') +
          '</div>'); }).join('') +
        '</div>' +
        '<div class="verify-top" style="margin-top:14px">' +
          (allOk ? '<span class="vbadge pass">✓ ' + items.length + ' records · memory verified</span>'
                 : '<span class="vbadge fail">✗ some payloads unavailable</span>') +
        '</div>';
    },
  });
}

function showAgentDetail(addr) {
  backTo = 'agents';
  const r = STATE.reps.find((x) => x.agent === addr);
  if (!r) return;
  const cap = STATE.agentCaps.get(addr);
  const s = agentSummary(addr);
  const host = $('detailBody');
  showView('detail');
  $('detailTitle').textContent = 'Agent ' + short(addr);
  const tier = scoreTier(r.score);
  const capHtml = cap
    ? '<div><span class="k">AgentCap</span><a class="mono link" target="_blank" rel="noreferrer" href="' + explorerObject(cap.capId) + '">' + short(cap.capId) + '</a></div>' +
      '<div><span class="k">Scopes</span><span>' + (scopeChips(cap.scopes).map((x) => '<span class="scope-chip">' + x + '</span>').join('') || '<span class="scope-chip none">none</span>') + '</span></div>' +
      '<div><span class="k">Cap status</span><span class="cap-status ' + (cap.revoked ? 'revoked' : 'active') + '">' + (cap.revoked ? 'revoked' : 'active') + '</span></div>'
    : '<div><span class="k">AgentCap</span><span class="mono">none loaded</span></div>';
  const vouchRows = s.vouches.length
    ? s.vouches.map((v) => '<div class="feed-item"><div class="feed-body"><div class="feed-top"><span class="feed-type">Vouch</span><span class="feed-mod">' + escapeHtml(STATE.repoNameById.get(v.repoId) || short(v.repoId)) + '</span></div><div class="feed-meta"><span>by <a class="link mono" href="' + explorerAddress(v.voucher) + '" target="_blank" rel="noreferrer">' + escapeHtml(nameOrShort(v.voucher)) + '</a></span><a class="link mono" href="' + explorerTx(v.tx) + '" target="_blank" rel="noreferrer">' + short(v.tx) + '</a></div></div></div>').join('')
    : '<div class="empty-state">No vouches recorded.</div>';
  const bountyRows = s.bounties.length
    ? s.bounties.map((b) => '<div class="pr-card"><div class="pr-title">' + escapeHtml(b.title || '(untitled bounty)') + '</div><div class="repo-meta"><div><span class="k">Status</span><span class="mono">' + bountyStatusLabel(b.status) + '</span></div><div><span class="k">Amount</span><span class="mono">' + suiAmount(b.amount) + ' SUI</span></div><div><span class="k">Repo</span><span class="mono">' + escapeHtml(STATE.repoNameById.get(b.repoId) || short(b.repoId)) + '</span></div></div></div>').join('')
    : '<div class="empty-state">No bounties claimed or paid.</div>';
  const workRows = [
    ...s.prs.map((p) => '<div class="vstep ok"><span class="vmark">PR</span><span class="vlabel">' + escapeHtml(p.title || short(p.id)) + '</span><a class="vdetail mono link" target="_blank" rel="noreferrer" href="' + explorerObject(p.id) + '">' + prStatusLabel(p.status) + ' · ' + short(p.id) + '</a></div>'),
    ...s.reviews.map((v) => '<div class="vstep ok"><span class="vmark">RV</span><span class="vlabel">Review report</span><a class="vdetail mono link" target="_blank" rel="noreferrer" href="' + blobUrl(v.reportBlob) + '">' + short(v.reportBlob) + '</a></div>'),
  ].join('') || '<div class="empty-state">No PR or review history.</div>';
  host.innerHTML =
    '<div class="detail-grid repo-meta">' +
      '<div><span class="k">Address</span><a class="mono link" target="_blank" rel="noreferrer" href="' + explorerAddress(addr) + '">' + escapeHtml(nameOrShort(addr)) + '</a></div>' +
      '<div><span class="k">Tier</span><span class="tier-badge ' + tier.cls + '">' + tier.tier + '</span></div>' +
      '<div><span class="k">Score</span><span class="score-badge">' + r.score + '</span></div>' +
      '<div><span class="k">Reliability</span><span class="mono">' + Math.round(s.reliability * 100) + '%</span></div>' +
      capHtml +
    '</div>' +
    '<div class="agent-profile-actions"><button class="cmd-action prove-btn" id="agentVaultBtn">Open memory vault</button></div>' +
    '<h3 class="detail-h3">Work history</h3><div class="verify-steps">' + workRows + '</div>' +
    '<h3 class="detail-h3">Vouches</h3>' + vouchRows +
    '<h3 class="detail-h3">Bounties</h3><div class="card-grid">' + bountyRows + '</div>';
  const btn = $('agentVaultBtn');
  if (btn) btn.addEventListener('click', () => proveAgentWork(addr));
}

/* ---------- Package trust view ---------- */
/* Known Sui framework package addresses (trusted by definition). */
const FRAMEWORK_PKGS = { '0x1': 'MoveStdlib', '0x2': 'Sui framework', '0x3': 'SuiSystem', '0xb': 'Bridge' };
function normPkgAddr(a) { const h = String(a || '').replace(/^0x/, '').replace(/^0+/, ''); return '0x' + (h || '0'); }

/**
 * Read a package's real on-chain dependencies by walking its normalized Move
 * modules and collecting every distinct package address referenced in struct
 * fields and function signatures. Framework packages are flagged trusted.
 */
async function loadPackageDependencies(packageId) {
  const mods = await withTimeout(sui.getNormalizedMoveModulesByPackage({ package: packageId }), 12000);
  const self = normPkgAddr(packageId);
  const addrs = new Set();
  const visit = (t) => {
    if (!t || typeof t !== 'object') return;
    if (t.Struct) { addrs.add(normPkgAddr(t.Struct.address)); (t.Struct.typeArguments || []).forEach(visit); }
    else if (t.Reference) visit(t.Reference);
    else if (t.MutableReference) visit(t.MutableReference);
    else if (t.Vector) visit(t.Vector);
  };
  for (const mod of Object.values(mods || {})) {
    for (const s of Object.values(mod.structs || {})) (s.fields || []).forEach((f) => visit(f.type));
    for (const fn of Object.values(mod.exposedFunctions || {})) { (fn.parameters || []).forEach(visit); (fn.return || []).forEach(visit); }
  }
  addrs.delete(self);
  return [...addrs].map((a) => ({ addr: a, framework: !!FRAMEWORK_PKGS[a], name: FRAMEWORK_PKGS[a] || null }));
}

function renderPackagesView() {
  const el = $('packageTrust');
  if (!el) return;
  const maintainers = [...new Set(STATE.repos.map((r) => r.owner).filter(Boolean))];
  const releaseRows = STATE.releases.slice(0, 8).map((r) =>
    '<div class="vstep ok">' +
      '<span class="vmark">R</span>' +
      '<span class="vlabel">' + escapeHtml(r.version) + ' · ' + escapeHtml(STATE.repoNameById.get(r.repoId) || short(r.repoId)) + '</span>' +
      '<span class="vdetail mono" id="pkg-rel-' + r.id + '">checking...</span>' +
    '</div>').join('') || '<div class="empty-state">No releases available for package trust scoring.</div>';
  el.innerHTML =
    '<div class="package-trust-grid">' +
      '<section class="info-card package-card-main">' +
        '<div class="agent-card-head"><div class="repo-ico"><svg class="ico" viewBox="0 0 24 24" fill="none" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 4 7.5v9L12 21l8-4.5v-9z"/><path d="M4 7.5 12 12l8-4.5M12 12v9"/></svg></div><h3>Signet Forge Package</h3><span class="tier-badge tier-verified" id="pkgRisk">checking</span></div>' +
        '<div class="repo-meta detail-grid">' +
          '<div><span class="k">Package</span><a class="mono link" target="_blank" rel="noreferrer" href="' + explorerObject(CFG.packageId) + '">' + short(CFG.packageId, 10, 8) + '</a></div>' +
          '<div><span class="k">MVR alias</span><span class="mono">' + escapeHtml(CFG.mvrName || '@signet/forge') + '</span></div>' +
          '<div><span class="k">MVR status</span><span class="mono">' + escapeHtml(CFG.mvrStatus || 'raw package id active') + '</span></div>' +
          '<div><span class="k">Registry</span><a class="mono link" target="_blank" rel="noreferrer" href="' + explorerObject(CFG.forgeRegistry) + '">' + short(CFG.forgeRegistry, 10, 8) + '</a></div>' +
          '<div><span class="k">Publish tx</span><a class="mono link" target="_blank" rel="noreferrer" href="' + explorerTx(CFG.publishTx || '') + '">' + short(CFG.publishTx || '', 10, 8) + '</a></div>' +
          '<div><span class="k">Toolchain</span><span class="mono">Sui ' + escapeHtml(CFG.toolchainVersion || 'unknown') + '</span></div>' +
        '</div>' +
      '</section>' +
      '<section class="info-card"><h3>Dependencies</h3><div class="agent-market-row" id="pkgDeps"><span class="market-pill">resolving on-chain…</span></div><p>Package dependencies read live from the package\'s normalized modules; framework packages (0x1/0x2/0x3) are trusted by definition.</p></section>' +
      '<section class="info-card"><h3>Maintainers</h3>' + (maintainers.length ? maintainers.map((m) => '<a class="link mono maint-row" target="_blank" rel="noreferrer" href="' + explorerAddress(m) + '">' + escapeHtml(nameOrShort(m)) + '</a>').join('') : '<p>No repository maintainers loaded yet.</p>') + '</section>' +
    '</div>' +
    '<h3 class="detail-h3">Verified releases</h3><div class="verify-steps" id="pkgReleaseChecks">' + releaseRows + '</div>';
  // Resolve real on-chain dependencies (async; replaces the loading row).
  loadPackageDependencies(CFG.packageId).then((deps) => {
    const host = $('pkgDeps'); if (!host) return;
    if (!deps.length) { host.innerHTML = '<span class="market-pill">no external package deps</span>'; return; }
    host.innerHTML = deps.map((d) => d.framework
      ? '<span class="market-pill">' + escapeHtml(d.name) + ' · trusted</span>'
      : '<a class="market-pill link mono" target="_blank" rel="noreferrer" href="' + explorerObject(d.addr) + '">' + short(d.addr, 8, 6) + '</a>').join('');
  }).catch(() => { const host = $('pkgDeps'); if (host) host.innerHTML = '<span class="market-pill">deps unavailable (RPC)</span>'; });
  if (!STATE.releases.length) {
    const risk = $('pkgRisk'); if (risk) { risk.textContent = 'partial'; risk.className = 'tier-badge tier-contributor'; }
    return;
  }
  Promise.all(STATE.releases.slice(0, 8).map((r) => verifyReleaseBrowser(r.id).then((v) => ({ r, v })).catch(() => ({ r, v: null })))).then((rows) => {
    let trusted = 0, partial = 0;
    for (const { r, v } of rows) {
      const cell = $('pkg-rel-' + r.id);
      if (!cell) continue;
      if (v?.pass && v.level >= 3) { trusted++; cell.textContent = v.levelLabel + ' verified'; }
      else if (v && v.level > 0) { partial++; cell.textContent = v.levelLabel + ' partial'; }
      else cell.textContent = 'failed';
    }
    const risk = $('pkgRisk');
    if (risk) {
      if (trusted) { risk.textContent = 'trusted'; risk.className = 'tier-badge tier-trusted'; }
      else if (partial) { risk.textContent = 'partial'; risk.className = 'tier-badge tier-contributor'; }
      else { risk.textContent = 'failed'; risk.className = 'tier-badge tier-new'; }
    }
  });
}

/* ---------- Issues view ---------- */
function renderIssuesView() {
  const el = $('issuesList');
  if (!el) return;
  const firstRepo = STATE.repos[0]?.id;
  const cmd = cmdPanel('Open an issue',
    'npm run forge -- ...   (or MCP issue_create)',
    null,
    firstRepo ? { label: '+ New issue', fn: () => actOpenIssue(firstRepo) } : null);
  if (!STATE.issues.length) {
    el.innerHTML = cmd + '<div class="empty-state">No issues on-chain yet. The issue module is deployed; open one via MCP to see it here live.</div>';
    return;
  }
  el.innerHTML = cmd + STATE.issues.map((i) => {
    const st = issueStatusLabel(i.status);
    return '<div class="repo-card">' +
      '<div class="pr-card-top"><span class="pill ' + (st === 'open' ? 'open' : 'closed') + '">' + st + '</span>' +
        '<a class="link mono" style="margin-left:auto" target="_blank" rel="noreferrer" href="' + explorerObject(i.id) + '">' + short(i.id) + '</a></div>' +
      '<div class="pr-title" title="' + escapeHtml(i.title || '(untitled)') + '">' + escapeHtml(i.title || '(untitled)') + '</div>' +
      '<div class="repo-meta">' +
        '<div><span class="k">Author</span><a class="link mono" target="_blank" rel="noreferrer" href="' + explorerObject(i.author) + '">' + short(i.author) + '</a></div>' +
        '<div><span class="k">Comments</span><span class="mono">' + i.commentCount + '</span></div>' +
        '<div><span class="k">Repo</span><span class="mono">' + escapeHtml(STATE.repoNameById.get(i.repoId) || short(i.repoId)) + '</span></div>' +
        (i.bodyBlob ? '<div><span class="k">Body</span><a class="link mono" target="_blank" rel="noreferrer" href="' + blobUrl(i.bodyBlob) + '">' + short(i.bodyBlob) + '</a></div>' : '') +
      '</div></div>';
  }).join('');
}

/* ---------- Bounties view ---------- */
function renderBountiesView() {
  const el = $('bountiesList');
  if (!el) return;
  const firstRepoB = STATE.repos[0]?.id;
  const cmd = cmdPanel('Post a bounty',
    'Bounties escrow real SUI (2.5% fee on payout).',
    null,
    firstRepoB ? { label: '+ New bounty', fn: () => actPostBounty(firstRepoB) } : null);
  if (!STATE.bounties.length) {
    el.innerHTML = cmd + '<div class="empty-state">No bounties on-chain yet. The bounty escrow module is deployed; post one via MCP/PTB to see it here.</div>';
    return;
  }
  el.innerHTML = cmd + STATE.bounties.map((b) => {
    const st = bountyStatusLabel(b.status);
    const pillClass = st === 'open' ? 'open' : st === 'paid' ? 'paid' : st === 'cancelled' ? 'cancelled' : 'claimed';
    return '<div class="repo-card">' +
      '<div class="pr-card-top"><span class="pill ' + pillClass + '">' + st + '</span>' +
        '<span class="bounty-amount mono" style="margin-left:auto">' + suiAmount(b.amount) + ' SUI</span></div>' +
      '<div class="pr-title" title="' + escapeHtml(b.title || '(untitled)') + '">' + escapeHtml(b.title || '(untitled)') + '</div>' +
      '<div class="repo-meta">' +
        '<div><span class="k">Funder</span><a class="link mono" target="_blank" rel="noreferrer" href="' + explorerObject(b.funder) + '">' + short(b.funder) + '</a></div>' +
        '<div><span class="k">Claimant</span><span class="mono">' + (b.claimant ? short(b.claimant) : '—') + '</span></div>' +
        '<div><span class="k">Repo</span><span class="mono">' + escapeHtml(STATE.repoNameById.get(b.repoId) || short(b.repoId)) + '</span></div>' +
        '<div><span class="k">Escrow</span><a class="link mono" target="_blank" rel="noreferrer" href="' + explorerObject(b.id) + '">' + short(b.id) + '</a></div>' +
        (b.minScore > 0 ? '<div><span class="k">Requires</span><span class="lock-tag" data-tip="Only agents whose trust score ≥ this can claim">score ≥ ' + b.minScore + '</span></div>' : '') +
      '</div>' + bountyActions(b) + '</div>';
  }).join('');
  el.querySelectorAll('[data-act]').forEach((btn) => btn.addEventListener('click', () => {
    const id = btn.dataset.bounty;
    if (btn.dataset.act === 'dispute') actOpenDispute(id);
    else if (btn.dataset.act === 'resolve') actResolveDispute(id, btn.dataset.repo, btn.dataset.cap);
  }));
}

/** Owner/party actions for a bounty card (dispute open + arbitration). */
function bountyActions(b) {
  const w = STATE.wallet?.address;
  if (!w) return '';
  const btns = [];
  // Funder or claimant can open a dispute on a CLAIMED bounty.
  if (b.status === 1 && (w === b.funder || w === b.claimant)) {
    btns.push('<button class="btn-ghost pg-mini" data-act="dispute" data-bounty="' + b.id + '">⚖ Dispute</button>');
  }
  // Repo owner can arbitrate a DISPUTED bounty.
  const cap = b.status === 4 ? ownerCapFor(b.repoId) : null;
  if (cap) {
    btns.push('<button class="btn-ghost pg-mini" data-act="resolve" data-bounty="' + b.id + '" data-repo="' + b.repoId + '" data-cap="' + cap + '">Resolve dispute</button>');
  }
  return btns.length ? '<div class="pg-card-actions">' + btns.join('') + '</div>' : '';
}

/* ---------- Payments view ---------- */
function paymentStatusLabel(s) {
  return ['open', 'paid', 'cancelled', 'expired'][s] || 'unknown';
}

function artifactTypeLabel(label) {
  const s = String(label || '').toLowerCase();
  if (s.includes('eval')) return 'eval';
  if (s.includes('model')) return 'model';
  if (s.includes('dataset')) return 'dataset';
  if (s.includes('inference')) return 'inference';
  if (s.includes('proof')) return 'proof';
  if (s.includes('review') || s.includes('ci') || s.includes('report')) return 'ci';
  return 'artifact';
}

function txPureOptionU64(tx, value) {
  if (tx.pure.option) return tx.pure.option('u64', value ?? null);
  return tx.pure.vector('u64', value == null ? [] : [value]);
}

function renderPaymentsView() {
  const el = $('paymentsList');
  if (!el) return;
  const cmd = cmdPanel('Create a payment link',
    'Wallet signs payment::create_request; gateway only indexes and re-verifies receipts.',
    null,
    STATE.wallet ? { label: '+ New payment', fn: actCreatePayment } : null);
  if (!STATE.payments.length) {
    el.innerHTML = cmd + '<div class="empty-state">No payment requests on-chain yet. Create one to get a shareable Sui payment link.</div>';
    return;
  }
  el.innerHTML = cmd + STATE.payments.map((p) => {
    const st = paymentStatusLabel(p.status);
    const link = location.origin + location.pathname + '#payments:' + p.id;
    return '<div class="repo-card">' +
      '<div class="pr-card-top"><span class="pill ' + paymentPillClass(st) + '">' + st + '</span>' +
        '<span class="bounty-amount mono" style="margin-left:auto">' + suiAmount(p.amount) + ' SUI</span></div>' +
      '<div class="pr-title" title="' + escapeHtml(p.label || '(payment request)') + '">' + escapeHtml(p.label || '(payment request)') + '</div>' +
      '<div class="repo-meta">' +
        '<div><span class="k">Recipient</span><a class="link mono" target="_blank" rel="noreferrer" href="' + explorerAddress(p.recipient) + '">' + short(p.recipient) + '</a></div>' +
        '<div><span class="k">Payer</span><span class="mono">' + (p.payer ? short(p.payer) : '-') + '</span></div>' +
        '<div><span class="k">Expires</span><span class="mono">' + (p.expiresAt ? new Date(p.expiresAt).toLocaleString() : 'never') + '</span></div>' +
        '<div><span class="k">Request</span><a class="link mono" target="_blank" rel="noreferrer" href="' + explorerObject(p.id) + '">' + short(p.id) + '</a></div>' +
        '<div><span class="k">Link</span><button class="link mono btn-link" data-copy-pay="' + escapeHtml(link) + '">' + short(link, 18, 10) + '</button></div>' +
      '</div><div class="payment-qr" data-qr="' + escapeHtml(link) + '"><span class="loading-shimmer"></span></div>' + paymentActions(p) + '</div>';
  }).join('');
  el.querySelectorAll('[data-copy-pay]').forEach((b) => b.addEventListener('click', () => copyText(b.dataset.copyPay, 'Payment link')));
  el.querySelectorAll('[data-pay-act]').forEach((b) => b.addEventListener('click', () => {
    const p = STATE.payments.find((x) => x.id === b.dataset.payment);
    if (!p) return;
    if (b.dataset.payAct === 'pay') actPayPayment(p);
    if (b.dataset.payAct === 'cancel') actCancelPayment(p);
  }));
  renderPaymentQrs(el);
}

function paymentPillClass(st) {
  if (st === 'paid') return 'paid';
  if (st === 'cancelled' || st === 'expired') return 'cancelled';
  return 'open';
}

async function renderPaymentQrs(root) {
  const targets = [...root.querySelectorAll('[data-qr]')];
  if (!targets.length) return;
  try {
    const QRCode = await import('https://esm.sh/qrcode@1.5.4?bundle');
    await Promise.all(targets.map(async (el) => {
      const url = el.dataset.qr || '';
      const svg = await QRCode.toString(url, {
        type: 'svg',
        errorCorrectionLevel: 'M',
        margin: 1,
        width: 132,
        color: { dark: '#dfe9ff', light: '#09111f' },
      });
      el.innerHTML = '<div class="qr-box">' + svg + '</div><button class="btn-ghost pg-mini" data-copy-pay="' + escapeHtml(url) + '">Copy link</button>';
      el.querySelector('[data-copy-pay]')?.addEventListener('click', () => copyText(url, 'Payment link'));
    }));
  } catch (e) {
    targets.forEach((el) => { el.innerHTML = '<button class="btn-ghost pg-mini" data-copy-pay="' + escapeHtml(el.dataset.qr || '') + '">Copy link</button>'; });
  }
}

function paymentActions(p) {
  if (!STATE.wallet || p.status !== 0) return '';
  const buttons = [];
  if (STATE.wallet.address !== p.recipient) {
    buttons.push('<button class="btn-ghost pg-mini" data-pay-act="pay" data-payment="' + p.id + '">Pay</button>');
  }
  if (STATE.wallet.address === p.creator || STATE.wallet.address === p.recipient) {
    buttons.push('<button class="btn-ghost pg-mini" data-pay-act="cancel" data-payment="' + p.id + '">Cancel</button>');
  }
  return buttons.length ? '<div class="pg-card-actions">' + buttons.join('') + '</div>' : '';
}

function actCreatePayment() {
  if (!STATE.wallet) { toast('Connect a wallet first', { kind: 'error' }); return; }
  openModal({
    title: 'Create payment link',
    bodyHtml: '<label class="field"><span>Recipient</span><input id="payRecipient" value="' + escapeHtml(STATE.wallet.address) + '"></label>' +
      '<label class="field"><span>Label</span><input id="payLabel" value="Signet payment"></label>' +
      '<label class="field"><span>Amount SUI</span><input id="payAmount" type="number" min="0" step="0.001" value="0.1"></label>' +
      '<label class="field"><span>Expires in hours</span><input id="payExpiresHours" type="number" min="0" step="1" value="0"></label>' +
      '<button class="cmd-action" id="payCreateBtn" type="button">Sign & create</button>',
    onMount(body) {
      body.querySelector('#payCreateBtn')?.addEventListener('click', submitCreatePayment);
    },
  });
}

async function submitCreatePayment() {
  try {
    const btn = $('payCreateBtn');
    if (btn?.dataset.busy === '1') return;
    if (btn) { btn.dataset.busy = '1'; btn.disabled = true; }
    const recipient = $('payRecipient')?.value?.trim() || '';
    const label = $('payLabel')?.value?.trim() || 'Signet payment';
    const amountMist = Math.floor(Number($('payAmount')?.value || 0) * MIST);
    const expiresHours = Number($('payExpiresHours')?.value || 0);
    const expiresAt = expiresHours > 0 ? Date.now() + Math.floor(expiresHours * 60 * 60 * 1000) : null;
    if (!isValidSuiAddress(recipient) || amountMist <= 0) { toast('Enter a valid recipient and amount', { kind: 'error' }); return; }
    const tx = new Transaction();
    tx.moveCall({
      target: `${CFG.writePackageId || CFG.packageId}::payment::create_request`,
      arguments: [
        tx.pure.address(recipient),
        tx.pure.string(label),
        tx.pure.u64(amountMist),
        txPureOptionU64(tx, expiresAt),
        tx.object.clock(),
      ],
    });
    const res = await signAndRunCreated(tx, 'Payment request created', '::payment::PaymentRequest');
    const id = res?.created?.[0];
    if (id) copyText(location.origin + location.pathname + '#payments:' + id, 'Payment link');
    closeModal();
  } catch (e) {
    toast('Payment request failed: ' + decodeSuiError(e).message, { kind: 'error' });
  } finally {
    const btn = $('payCreateBtn');
    if (btn) { btn.dataset.busy = '0'; btn.disabled = false; }
  }
}

window.__signetSubmitPayment = submitCreatePayment;

async function actPayPayment(p) {
  const tx = new Transaction();
  const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(p.amount)]);
  tx.moveCall({
    target: `${CFG.writePackageId || CFG.packageId}::payment::pay`,
    arguments: [tx.object(p.id), coin, tx.object.clock()],
  });
  await signAndRun(tx, 'Payment sent');
}

async function actCancelPayment(p) {
  const tx = new Transaction();
  tx.moveCall({
    target: `${CFG.writePackageId || CFG.packageId}::payment::cancel`,
    arguments: [tx.object(p.id)],
  });
  await signAndRun(tx, 'Payment request cancelled');
}

/* ---------- Activity feed view ---------- */
function renderActivityView() {
  const el = $('activityFeed');
  if (!el) return;
  const feed = STATE.activity.feed || [];
  if (!feed.length) { el.innerHTML = '<div class="empty-state">No on-chain activity yet.</div>'; return; }
  const tfmt = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  el.innerHTML = feed.map((e) =>
    '<div class="feed-item">' +
      '<div class="feed-dot ' + e.module + '"></div>' +
      '<div class="feed-body">' +
        '<div class="feed-top"><span class="feed-type">' + escapeHtml(e.type) + '</span>' +
          '<span class="feed-mod mono">' + e.module + '</span></div>' +
        '<div class="feed-meta">' +
          (e.ts ? '<span>' + tfmt.format(new Date(e.ts)) + '</span>' : '') +
          (e.sender ? '<span class="mono">by ' + short(e.sender) + '</span>' : '') +
          (e.tx ? '<a class="link mono" target="_blank" rel="noreferrer" href="' + explorerTx(e.tx) + '">' + short(e.tx) + '</a>' : '') +
        '</div>' +
      '</div>' +
    '</div>'
  ).join('');
}

/* ---------- Verify view (Rekor-style independent verifier) ---------- */
// Verify deep-link state: a judge hitting #verify (optionally ?release=<id>) should see a real
// green check immediately instead of an empty "pick a release" prompt.
let pendingVerifyId = null, verifyAutoRan = false;
function renderVerifyView() {
  const sel = $('verifySelect');
  if (!sel) return;
  if (!STATE.releases.length) {
    sel.innerHTML = '<option value="">no releases yet</option>';
    $('verifyOut').innerHTML = '<div class="empty-state">No releases to verify yet.</div>';
    return;
  }
  sel.innerHTML = STATE.releases.map((r) =>
    '<option value="' + r.id + '">' + escapeHtml(r.version) + ' · ' +
      escapeHtml(STATE.repoNameById.get(r.repoId) || short(r.repoId)) + '</option>'
  ).join('');
  // default to the deep-linked release, else the most recent — and auto-verify it the first time
  // the view opens (or on a deep-link) so the proof is visible with zero clicks.
  const want = (pendingVerifyId && STATE.releases.some((r) => r.id === pendingVerifyId))
    ? pendingVerifyId : STATE.releases[0].id;
  sel.value = want;
  if (pendingVerifyId || !verifyAutoRan) {
    verifyAutoRan = true; pendingVerifyId = null;
    runVerify(want, $('verifyOut'), null);
  } else {
    $('verifyOut').innerHTML = '<div class="empty-state">Pick a release and click Verify to re-check its provenance chain independently.</div>';
  }
}

async function runVerify(releaseId, hostEl, btnEl) {
  if (!releaseId) return;
  if (btnEl) { btnEl.disabled = true; btnEl.textContent = 'Verifying…'; }
  hostEl.innerHTML = '<div class="empty-state">Checking blobs, recomputing treeHash, matching the chain…</div>';
  try {
    const result = await verifyReleaseBrowser(releaseId);
    renderVerifyResult(hostEl, result);
  } catch (e) {
    hostEl.innerHTML = '<div class="empty-state err">Verify failed: ' + escapeHtml(String(e)) + '</div>';
  } finally {
    if (btnEl) { btnEl.disabled = false; btnEl.textContent = 'Verify'; }
  }
}

/* ============================================================
   Drill-down detail views (repo / pr / release)
   ============================================================ */

let backTo = 'dashboard'; // where the detail "← Back" returns

function isTextPath(p) {
  return /\.(move|toml|md|txt|json|js|ts|tsx|sh|lock|yml|yaml|cfg|gitignore|rs|go|py)$/i.test(p) || !/\.[a-z0-9]+$/i.test(p);
}

async function showRepoDetail(repoId) {
  backTo = 'repos';
  const r = STATE.repos.find((x) => x.id === repoId);
  if (!r) return;
  const host = $('detailBody');
  showView('detail');
  $('detailTitle').textContent = r.name;
  host.innerHTML =
    '<div class="repo-meta detail-grid">' +
      '<div><span class="k">Branch</span><span class="mono">' + escapeHtml(r.defaultBranch || 'main') + '</span></div>' +
      '<div><span class="k">Ref version</span><span class="mono">v' + r.refVersion + '</span></div>' +
      '<div><span class="k">Owner</span><a class="link mono" target="_blank" rel="noreferrer" href="' + explorerObject(r.owner) + '">' + short(r.owner) + '</a></div>' +
      '<div><span class="k">Object</span><a class="link mono" target="_blank" rel="noreferrer" href="' + explorerObject(r.id) + '">' + short(r.id) + '</a></div>' +
      '<div><span class="k">Snapshot</span><a class="link mono" target="_blank" rel="noreferrer" href="' + blobUrl(r.currentSnapshot) + '">' + short(r.currentSnapshot) + '</a></div>' +
    '</div>' +
    cmdPanel('Update this repo (push a new snapshot)',
      'npm run forge -- push-snapshot --dir <path-to-code>',
      'Snapshots are built and uploaded by the CLI (local keystore).') +
    cmdPanel('Require reviews before merge (owner)',
      'npm run forge -- set-approvals --n 1',
      'Sets the on-chain min_approvals gate. Current: ' + (r.minApprovals || 0) + '.',
      ownerCapFor(r.id) ? { label: 'Set min approvals', fn: () => actSetApprovals(r.id, ownerCapFor(r.id)) } : null) +
    '<h3 class="detail-h3">Files <span class="mono" id="treeCount"></span></h3>' +
    '<div class="tree" id="fileTree"><div class="empty-state">Loading file tree…</div></div>' +
    '<div class="file-view" id="fileView" style="display:none"></div>' +
    '<h3 class="detail-h3">Pull Requests</h3><div class="card-grid" id="repoPrs"></div>' +
    '<h3 class="detail-h3">Releases</h3><div id="repoReleases"></div>';

  // PRs / releases for this repo
  const prs = STATE.prs.filter((p) => p.repoId === repoId);
  $('repoPrs').innerHTML = prs.length ? prs.map((p) => prCardHtml(p)).join('')
    : '<div class="empty-state">No PRs for this repo.</div>';
  wirePrCards($('repoPrs'));
  const rels = STATE.releases.filter((x) => x.repoId === repoId);
  $('repoReleases').innerHTML = rels.length ? rels.map((x) => releaseRowHtml(x)).join('')
    : '<div class="empty-state">No releases for this repo.</div>';
  wireReleaseRows($('repoReleases'));

  // file tree from the manifest + archive
  const manifest = await fetchManifest(r.currentSnapshot);
  const tree = $('fileTree');
  if (!manifest || !Array.isArray(manifest.files)) {
    tree.innerHTML = '<div class="empty-state">Manifest unavailable on Walrus.</div>';
    return;
  }
  $('treeCount').textContent = '(' + manifest.files.length + ')';
  tree.innerHTML = manifest.files.map((f) =>
    '<div class="tree-row" data-path="' + escapeHtml(f.path) + '">' +
      '<svg class="ico tree-ico" viewBox="0 0 24 24" fill="none" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3v5h5"/><path d="M6 3h9l5 5v11a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/></svg>' +
      '<span class="tree-path">' + escapeHtml(f.path) + '</span>' +
      '<span class="tree-size mono">' + f.size + ' B</span>' +
      '<span class="tree-hash mono">' + (f.sha256 || '').slice(0, 8) + '</span>' +
      (manifest.merkleRoot ? '<button class="tree-prove" data-prove="' + escapeHtml(f.path) + '" title="Merkle inclusion proof against the on-chain-anchored root">⛓ prove</button>' : '') +
    '</div>'
  ).join('');

  // Merkle inclusion: prove a single file is in this snapshot, client-side,
  // against manifest.merkleRoot (anchored on-chain via the source snapshot blob).
  tree.querySelectorAll('[data-prove]').forEach((b) => b.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    const path = b.dataset.prove; const old = b.textContent; b.textContent = '…';
    try {
      const r = await merkleVerifyBrowser(manifest, path);
      b.textContent = r?.ok ? '✓ proven' : '✗ failed';
      toast(r?.ok
        ? `✓ "${path}" is included — Merkle root ${r.root.slice(0, 10)}…, ${r.depth}-deep proof`
        : `Inclusion proof failed for "${path}"`, { kind: r?.ok ? 'success' : 'error' });
    } catch (e) { b.textContent = old; toast('Proof error: ' + (e.message || e), { kind: 'error' }); }
  }));

  // click a file -> show its content (decompress archive lazily)
  tree.querySelectorAll('.tree-row').forEach((row) => {
    row.addEventListener('click', async () => {
      const path = row.dataset.path;
      const view = $('fileView');
      view.style.display = '';
      view.innerHTML = '<div class="empty-state">Loading ' + escapeHtml(path) + '…</div>';
      const arch = await fetchArchive(manifest.archiveBlob);
      if (!arch || !arch.has(path)) {
        view.innerHTML = '<div class="file-head"><span class="mono">' + escapeHtml(path) + '</span></div><div class="empty-state">Content unavailable (archive blob missing).</div>';
        return;
      }
      const bytes = arch.get(path);
      let body;
      if (isTextPath(path) && bytes.length < 200000) {
        body = '<pre class="file-code"><code>' + escapeHtml(new TextDecoder().decode(bytes)) + '</code></pre>';
      } else {
        body = '<div class="empty-state">Binary or large file (' + bytes.length + ' B) — <a class="link" target="_blank" rel="noreferrer" href="' + blobUrl(manifest.archiveBlob) + '">download archive</a>.</div>';
      }
      view.innerHTML = '<div class="file-head"><span class="mono">' + escapeHtml(path) + '</span><span class="mono" style="color:var(--tx-3)">' + bytes.length + ' B</span></div>' + body;
      view.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  });
}

/** Find the shared RepoReputation ledger for a repo (created in the RepoCreated tx). */
async function findReputationLedger(repoId) {
  const ev = await readQueryEvents({
    query: { MoveEventType: `${CFG.packageId}::forge::RepoCreated` },
    limit: 100, order: 'descending',
  });
  const e = ev.data.find((x) => x.parsedJson?.repo_id === repoId);
  if (!e) return null;
  const tx = await sui.getTransactionBlock({ digest: e.id.txDigest, options: { showObjectChanges: true } });
  const ch = (tx.objectChanges || []).find((o) =>
    o.type === 'created' && String(o.objectType).endsWith('::reputation::RepoReputation'));
  return ch ? ch.objectId : null;
}

async function doMerge(p) {
  const ownerCapId = ownerCapFor(p.repoId);
  if (!ownerCapId) { toast('You do not own this repo', { kind: 'error' }); return; }
  toast('Finding reputation ledger…', { kind: 'info', timeout: 1500 });
  const reputationId = await findReputationLedger(p.repoId);
  if (!reputationId) { toast('Reputation ledger not found', { kind: 'error' }); return; }
  await actMergePr(p.repoId, p.id, ownerCapId, reputationId);
}

async function doClosePr(p) {
  const ownerCapId = ownerCapFor(p.repoId);
  if (!ownerCapId) { toast('You do not own this repo', { kind: 'error' }); return; }
  await actClosePr(p.repoId, p.id, ownerCapId);
}

async function showPrDetail(prId) {
  backTo = 'prs';
  const p = STATE.prs.find((x) => x.id === prId);
  if (!p) return;
  const st = prStatusLabel(p.status);
  showView('detail');
  $('detailTitle').textContent = p.title || '(untitled PR)';
  const host = $('detailBody');
  host.innerHTML =
    '<div class="pr-card-top"><span class="status ' + st + '">' + statusIcon(p.status) + st.charAt(0).toUpperCase() + st.slice(1) + '</span>' +
      '<a class="link mono" style="margin-left:auto" target="_blank" rel="noreferrer" href="' + explorerObject(p.id) + '">' + short(p.id) + '</a></div>' +
    '<div class="repo-meta detail-grid">' +
      '<div><span class="k">Author</span><a class="link mono" target="_blank" rel="noreferrer" href="' + explorerObject(p.author) + '">' + short(p.author) + '</a></div>' +
      '<div><span class="k">Repo</span><span class="mono">' + escapeHtml(STATE.repoNameById.get(p.repoId) || short(p.repoId)) + '</span></div>' +
      '<div><span class="k">Base</span><a class="link mono" target="_blank" rel="noreferrer" href="' + blobUrl(p.baseSnapshot) + '">' + short(p.baseSnapshot) + '</a></div>' +
      '<div><span class="k">Head</span><a class="link mono" target="_blank" rel="noreferrer" href="' + blobUrl(p.headSnapshot) + '">' + short(p.headSnapshot) + '</a></div>' +
    '</div>' +
    (() => {
      const repo = STATE.repos.find((r) => r.id === p.repoId);
      const min = repo?.minApprovals || 0;
      const ok = p.approvals >= min;
      return '<div class="approval-bar ' + (ok ? 'met' : 'pending') + '">' +
        '<span class="mono">' + p.approvals + ' / ' + min + ' approvals</span>' +
        '<span class="approval-note">' + (min === 0 ? 'no approval threshold set' : ok ? '✓ threshold met — mergeable' : 'needs ' + (min - p.approvals) + ' more approve review(s)') + '</span></div>';
    })() +
    (p.status === 0 ? cmdPanel('Merge this PR (owner only)',
      'npm run forge -- merge --pr ' + p.id,
      'Merge is owner-only and advances the repo ref. Agents can never merge.',
      ownerCapFor(p.repoId) ? { label: '✓ Merge PR', fn: () => doMerge(p) } : null) : '') +
    (p.status === 0 && ownerCapFor(p.repoId) ? cmdPanel('Close this PR without merging (owner)',
      'npm run forge -- close-pr --pr ' + p.id,
      'Closes an open PR that will not be merged — does not advance the repo ref.',
      { label: '✕ Close PR', fn: () => doClosePr(p) }) : '') +
    '<h3 class="detail-h3">Changed files</h3><div class="diff" id="prDiff"><div class="empty-state">Computing diff…</div></div>' +
    '<h3 class="detail-h3">Reviews <span class="mono">(' + (p.reviewRefs?.length || 0) + ')</span></h3><div id="prReviews"><div class="empty-state">Loading reviews…</div></div>';

  // diff: compare base vs head manifest by path+sha256
  const [base, head] = await Promise.all([fetchManifest(p.baseSnapshot), fetchManifest(p.headSnapshot)]);
  const diffEl = $('prDiff');
  if (!head) {
    diffEl.innerHTML = '<div class="empty-state">Head manifest unavailable.</div>';
  } else {
    const baseMap = new Map((base?.files || []).map((f) => [f.path, f.sha256]));
    const headMap = new Map((head.files || []).map((f) => [f.path, f.sha256]));
    const rows = [];
    for (const [path, sha] of headMap) {
      if (!baseMap.has(path)) rows.push({ path, kind: 'add' });
      else if (baseMap.get(path) !== sha) rows.push({ path, kind: 'mod' });
    }
    for (const [path] of baseMap) if (!headMap.has(path)) rows.push({ path, kind: 'del' });
    rows.sort((a, b) => a.path.localeCompare(b.path));
    diffEl.innerHTML = rows.length ? rows.map((d) =>
      '<div class="diff-row diff-' + d.kind + '"><span class="diff-mark">' +
        (d.kind === 'add' ? '+' : d.kind === 'del' ? '−' : '~') + '</span>' +
        '<span class="mono">' + escapeHtml(d.path) + '</span></div>'
    ).join('') : '<div class="empty-state">No file-level changes (base == head).</div>';
  }

  // reviews: fetch each report's text from Walrus
  const revEl = $('prReviews');
  const refs = p.reviewRefs || [];
  if (!refs.length) { revEl.innerHTML = '<div class="empty-state">No reviews yet.</div>'; }
  else {
    const texts = await Promise.all(refs.map((b) => fetchBlobText(b)));
    revEl.innerHTML = refs.map((b, i) =>
      '<div class="review-card"><div class="file-head"><span class="mono">report ' + short(b) + '</span>' +
        '<a class="link mono" target="_blank" rel="noreferrer" href="' + blobUrl(b) + '">open</a></div>' +
        '<pre class="file-code"><code>' + escapeHtml((texts[i] || '(could not fetch report)').slice(0, 4000)) + '</code></pre></div>'
    ).join('');
  }
}

async function showReleaseDetail(releaseId) {
  backTo = 'releases';
  const r = STATE.releases.find((x) => x.id === releaseId);
  if (!r) return;
  showView('detail');
  $('detailTitle').textContent = r.version + ' · ' + (STATE.repoNameById.get(r.repoId) || short(r.repoId));
  const host = $('detailBody');
  const chainNode = (label, blob, accent, idAttr) =>
    '<div class="prov-node ' + accent + '">' +
      '<div class="prov-label">' + label + '</div>' +
      '<a class="prov-blob link mono" target="_blank" rel="noreferrer" href="' + blobUrl(blob) + '">' + short(blob) + '</a>' +
      '<a class="walruscan-link" target="_blank" rel="noreferrer" href="' + walruscanBlob(blob) + '" data-tip="Inspect this blob on Walruscan">Walruscan ↗</a>' +
      '<pre class="prov-preview" id="' + idAttr + '">loading…</pre>' +
    '</div>';
  host.innerHTML =
    '<div class="repo-meta detail-grid">' +
      '<div><span class="k">Version</span><span class="mono">' + escapeHtml(r.version) + '</span></div>' +
      '<div><span class="k">Repo</span><span class="mono">' + escapeHtml(STATE.repoNameById.get(r.repoId) || short(r.repoId)) + '</span></div>' +
      '<div><span class="k">Published by</span><a class="link mono" target="_blank" rel="noreferrer" href="' + explorerObject(r.publishedBy) + '">' + short(r.publishedBy) + '</a></div>' +
      '<div><span class="k">Object</span><a class="link mono" target="_blank" rel="noreferrer" href="' + explorerObject(r.id) + '">' + short(r.id) + '</a></div>' +
      (r.mergedPrId ? '<div><span class="k">Merged PR</span><a class="link mono" target="_blank" rel="noreferrer" href="' + explorerObject(r.mergedPrId) + '">' + short(r.mergedPrId) + '</a></div>' : '') +
    '</div>' +
    releaseGraph +
    '<h3 class="detail-h3">Provenance chain</h3>' +
    '<div class="prov-chain">' +
      chainNode('Source snapshot', r.sourceSnapshot, 'g', 'prev-src') +
      '<span class="prov-arrow">→</span>' +
      chainNode('Build artifact', r.buildArtifact, 'b', 'prev-art') +
      '<span class="prov-arrow">→</span>' +
      chainNode('Test report', r.testReport, 'v', 'prev-rep') +
      '<span class="prov-arrow">→</span>' +
      '<div class="prov-node release"><div class="prov-label">Release</div><span class="prov-blob mono">' + escapeHtml(r.version) + '</span><div class="prov-seal">✓ on-chain</div></div>' +
    '</div>' +
    cmdPanel('Publish a release (owner only)',
      'npm run forge -- release --tag <v> --artifact <file> --report <file>',
      'Publishing pins the whole provenance chain on Walrus + Sui. Owner-only; runs in your terminal.') +
    '<h3 class="detail-h3">Provenance verification ' +
      '<button class="back-btn" id="relVerifyBtn" style="float:right;padding:7px 14px">Verify this release</button></h3>' +
    '<div id="relVerifyOut"><div class="empty-state">Verifying provenance…</div></div>' +
    '<div class="agent-profile-actions" style="margin-top:12px"><button class="cmd-action" id="relExportBtn">Export in-toto/SLSA JSON</button></div>' +
    '<div class="cmd-note" style="margin-top:8px">Also runnable offline: <span class="mono">npm run forge -- verify --release ' + short(r.id) + '</span> — same checks, no key needed.</div>';

  // run verify automatically (shows SLSA-style level badge + steps)
  runVerify(r.id, $('relVerifyOut'), null);
  const vbtn = $('relVerifyBtn');
  if (vbtn) vbtn.addEventListener('click', () => runVerify(r.id, $('relVerifyOut'), vbtn));
  const exportBtn = $('relExportBtn');
  if (exportBtn) exportBtn.addEventListener('click', async () => {
    const att = await releaseAttestationBrowser(r.id);
    downloadJson('signet-' + r.version + '-attestation.json', att);
  });

  // blob previews
  const previews = [
    ['prev-src', r.sourceSnapshot, true],
    ['prev-art', r.buildArtifact, false],
    ['prev-rep', r.testReport, false],
  ];
  for (const [id, blob, isManifest] of previews) {
    fetchBlobText(blob).then((t) => {
      const el = $(id);
      if (!el) return;
      el.textContent = t ? t.slice(0, 600) : '(blob unavailable)';
    });
  }
}

/* card/row html + wiring shared by views and drill-downs */
function prCardHtml(p) {
  const st = prStatusLabel(p.status);
  return '<div class="pr-card clickable" data-prid="' + p.id + '">' +
    '<div class="pr-card-top"><span class="status ' + st + '">' + statusIcon(p.status) + st.charAt(0).toUpperCase() + st.slice(1) + '</span>' +
      '<span class="link mono" style="margin-left:auto">' + short(p.id) + '</span></div>' +
    '<div class="pr-title" title="' + escapeHtml(p.title || '(untitled)') + '">' + escapeHtml(p.title || '(untitled)') + '</div>' +
    '<div class="repo-meta"><div><span class="k">Author</span><span class="mono">' + escapeHtml(nameOrShort(p.author)) + (STATE.wallet?.address === p.author ? ' <span class="you-tag">you</span>' : '') + '</span></div>' +
      '<div><span class="k">Reviews</span><span class="mono">' + (p.reviewRefs?.length || 0) + '</span></div></div>' +
  '</div>';
}
function wirePrCards(scope) {
  scope.querySelectorAll('.pr-card.clickable').forEach((c) =>
    c.addEventListener('click', () => showPrDetail(c.dataset.prid)));
}
function releaseRowHtml(r) {
  return '<div class="release-card clickable" data-relid="' + r.id + '">' +
    '<div class="release-head"><div class="buy-thumb"><svg class="ico" viewBox="0 0 24 24" fill="none" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 1 1-3.5-6.6"/><path d="M9 12l2 2 4-5"/></svg></div>' +
    '<div><div class="repo-name">' + escapeHtml(r.version) + '</div><div class="repo-branch">click for provenance chain</div></div>' +
    '<span class="pill released" style="margin-left:auto">released</span></div></div>';
}
function wireReleaseRows(scope) {
  scope.querySelectorAll('.release-card.clickable').forEach((c) =>
    c.addEventListener('click', () => showReleaseDetail(c.dataset.relid)));
}

/* ============================================================
   Global search (Cmd-K) — filters loaded data + explorer fallback
   ============================================================ */
function buildSearchIndex() {
  const idx = [];
  for (const r of STATE.repos) idx.push({ kind: 'repo', label: r.name, sub: short(r.id), go: () => { activateNav('repos'); showRepoDetail(r.id); } });
  idx.push({ kind: 'package', label: CFG.mvrName || '@signet/forge', sub: short(CFG.packageId), go: () => activateNav('packages') });
  for (const p of STATE.prs) idx.push({ kind: 'pr', label: p.title || short(p.id), sub: short(p.id), go: () => { activateNav('prs'); showPrDetail(p.id); } });
  for (const r of STATE.releases) idx.push({ kind: 'release', label: r.version, sub: short(r.id), go: () => { activateNav('releases'); showReleaseDetail(r.id); } });
  for (const i of STATE.issues) idx.push({ kind: 'issue', label: i.title || short(i.id), sub: short(i.id), go: () => activateNav('issues') });
  for (const b of STATE.bounties) idx.push({ kind: 'bounty', label: b.title || short(b.id), sub: short(b.id), go: () => activateNav('bounties') });
  for (const p of STATE.payments) idx.push({ kind: 'payment', label: p.label || short(p.id), sub: short(p.id), go: () => activateNav('payments') });
  for (const a of STATE.reps) idx.push({ kind: 'agent', label: short(a.agent, 10, 6), sub: 'profile', go: () => { activateNav('agents'); showAgentDetail(a.agent); } });
  return idx;
}

function activateNav(name) {
  document.querySelectorAll('[data-nav]').forEach((x) => x.classList.toggle('active', x.dataset.nav === name));
  showView(name);
}

function runSearch(q) {
  const box = $('searchResults');
  q = q.trim();
  if (!q) { box.classList.remove('show'); return; }
  const lower = q.toLowerCase();
  let hits = buildSearchIndex().filter((e) =>
    e.label.toLowerCase().includes(lower) || e.sub.toLowerCase().includes(lower));
  let html = '';
  if (isValidSuiAddress(q) || isValidSuiObjectId(q)) {
    html += '<div class="sr-group">Explorer</div>' +
      `<div class="sr-item" data-open="${explorerObject(q)}"><span>Open ${short(q)} on explorer</span><span class="sr-kind">↗</span></div>`;
  }
  if (hits.length) {
    const byKind = {};
    for (const h of hits.slice(0, 24)) (byKind[h.kind] ||= []).push(h);
    for (const [kind, list] of Object.entries(byKind)) {
      html += `<div class="sr-group">${kind}s</div>`;
      list.forEach((h, i) => {
        const id = `sr-${kind}-${i}`;
        searchActions[id] = h.go;
        html += `<div class="sr-item" data-go="${id}"><span>${escapeHtml(h.label)}</span><span class="sr-kind">${escapeHtml(h.sub)}</span></div>`;
      });
    }
  }
  if (!html) html = '<div class="sr-empty">No matches.</div>';
  box.innerHTML = html;
  box.classList.add('show');
}
const searchActions = {};

function wireSearch() {
  const input = $('searchInput');
  const box = $('searchResults');
  if (!input) return;
  input.addEventListener('input', () => runSearch(input.value));
  input.addEventListener('focus', () => { if (input.value) runSearch(input.value); });
  box.addEventListener('click', (e) => {
    const item = e.target.closest('.sr-item');
    if (!item) return;
    if (item.dataset.open) { window.open(item.dataset.open, '_blank', 'noopener'); }
    else if (item.dataset.go && searchActions[item.dataset.go]) searchActions[item.dataset.go]();
    box.classList.remove('show'); input.value = '';
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-wrap')) box.classList.remove('show');
  });
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); input.focus(); }
    if (e.key === 'Escape') { box.classList.remove('show'); input.blur(); }
  });
}

/* ============================================================
   Settings slide-over
   ============================================================ */
function openSettings() {
  const ov = document.createElement('div');
  ov.className = 'settings-overlay';
  const panel = document.createElement('div');
  panel.className = 'settings-panel';
  const toggle = (key, title, desc) =>
    `<div class="set-row"><div class="set-label"><b>${title}</b><span>${desc}</span></div>` +
    `<div class="toggle ${SETTINGS[key] ? 'on' : ''}" data-toggle="${key}"></div></div>`;
  panel.innerHTML =
    '<h2>Settings</h2>' +
    `<div class="set-row"><div class="set-label"><b>Explorer</b><span>where object/tx links open</span></div>` +
      `<div class="seg" id="segExplorer"><button data-exp="suiscan" class="${SETTINGS.explorer==='suiscan'?'on':''}">Suiscan</button>` +
      `<button data-exp="suivision" class="${SETTINGS.explorer==='suivision'?'on':''}">SuiVision</button></div></div>` +
    toggle('autoRefresh', 'Auto-refresh', 'poll the chain periodically') +
    `<div class="set-row"><div class="set-label"><b>Refresh interval</b><span>seconds</span></div>` +
      `<input type="number" min="10" style="width:80px" id="setInterval" value="${SETTINGS.refreshSeconds}"></div>` +
    toggle('reduceMotion', 'Reduce motion', 'minimise animations') +
    '<div class="set-row" style="border:none"><div class="set-label"><b>Data source</b><span>' +
      escapeHtml(readSourceLabel()) + ' (append ?graphql=1 or ?source=json-rpc)</span></div></div>';
  document.body.append(ov, panel);
  requestAnimationFrame(() => { ov.classList.add('shown'); panel.classList.add('shown'); });
  const close = () => { ov.classList.remove('shown'); panel.classList.remove('shown'); setTimeout(() => { ov.remove(); panel.remove(); }, 280); };
  ov.addEventListener('click', close);
  panel.querySelectorAll('[data-toggle]').forEach((t) => t.addEventListener('click', () => {
    const k = t.dataset.toggle; SETTINGS[k] = !SETTINGS[k]; t.classList.toggle('on', SETTINGS[k]);
    saveSettings();
    if (k === 'autoRefresh') applyAutoPoll();
    if (k === 'reduceMotion') document.body.classList.toggle('reduce-motion', SETTINGS.reduceMotion);
  }));
  panel.querySelector('#segExplorer').addEventListener('click', (e) => {
    const b = e.target.closest('[data-exp]'); if (!b) return;
    SETTINGS.explorer = b.dataset.exp; saveSettings();
    panel.querySelectorAll('#segExplorer button').forEach((x) => x.classList.toggle('on', x === b));
    toast('Explorer set to ' + SETTINGS.explorer, { kind: 'info', timeout: 1500 });
    if (STATE.loaded) rerenderAll();
  });
  panel.querySelector('#setInterval').addEventListener('change', (e) => {
    SETTINGS.refreshSeconds = Math.max(10, Number(e.target.value) || 30); saveSettings(); applyAutoPoll();
  });
}

/** Re-render all views from cached STATE (used after explorer/name changes). */
function rerenderAll() {
  renderReposView(); renderPRsView('all'); renderReleasesView(); renderAgentsView(); renderPackagesView();
  renderIssuesView(); renderBountiesView(); renderPaymentsView(); renderActivityView(); renderVerifyView();
  renderPRTable('all');
  const repoNameById = STATE.repoNameById;
  renderReleases(STATE.releases, repoNameById); renderReputation(STATE.reps);
  renderSponsorDashboard();
}

/** Help & concepts modal: what Signet is, a short glossary, the integrations,
    and quick links (in-app tabs + external docs). */
function openHelp() {
  openModal({
    title: 'Signet — help & concepts',
    wide: true,
    bodyHtml:
      '<p class="help-lead">Describe an app, an LLM builds it in your browser, and you publish it with ' +
      '<b>verifiable on-chain provenance</b> on Sui + Walrus. Every metric — visits, stars, tips, remix ' +
      'lineage, reputation — is on-chain and unfakeable.</p>' +
      '<h4 class="help-h">Key concepts</h4><ul class="help-gloss">' +
      '<li><b>Walrus</b> — decentralized blob storage; app bytes + snapshots live here.</li>' +
      '<li><b>Snapshot / treeHash</b> — deterministic hash of the files, anchored on-chain so bytes re-verify.</li>' +
      '<li><b>Provenance chain</b> — source → artifact → review → release, each a verifiable on-chain link.</li>' +
      '<li><b>AgentCap</b> — scoped, revocable capability letting an agent open PRs / review / run CI.</li>' +
      '<li><b>Reputation</b> — earned on-chain (builders: apps·5 + stars·3 + remixes·4).</li>' +
      '<li><b>Seal</b> — client-side encryption for private apps; builders can keep owner-only access or allowlist collaborators through the v2 workspace policy.</li>' +
      '<li><b>Paid fork</b> — a builder can charge to remix their app; the fee is paid to them on-chain.</li>' +
      '</ul>' +
      '<h4 class="help-h">Integrations</h4><ul class="help-gloss">' +
      '<li><b>Walrus</b> — blob storage (publish + renew).</li>' +
      '<li><b>Seal</b> — builder/member-gated encryption for private apps.</li>' +
      '<li><b>zkLogin</b> — sign in with Google, no wallet needed (optional).</li>' +
      '<li><b>SuiNS</b> — reverse-resolves addresses to human names.</li>' +
      '<li><b>MCP</b> — agents build + publish programmatically (see the MCP tab).</li>' +
      '<li><b>Sponsored tx</b> — gas-free value-free actions when a sponsor is configured.</li>' +
      '</ul>' +
      '<h4 class="help-h">Links</h4><div class="help-links">' +
      '<a class="help-link" href="#walrus">Walrus storage</a>' +
      '<a class="help-link" href="#trust">Trust model</a>' +
      '<a class="help-link" href="#mcp">MCP / agents API</a>' +
      '<a class="help-link" target="_blank" rel="noreferrer" href="https://docs.wal.app">Walrus docs ↗</a>' +
      '<a class="help-link" target="_blank" rel="noreferrer" href="https://docs.sui.io">Sui docs ↗</a>' +
      '</div>' +
      '<p class="help-foot">Active network: <b>' + CFG.network + '</b> · click the network badge to switch.</p>',
    onMount(m) {
      // In-app tab links should also close the modal (hash routing handles the nav).
      m.querySelectorAll('.help-link[href^="#"]').forEach((a) => a.addEventListener('click', () => closeModal()));
    },
  });
}

function wireTopbar() {
  $('refreshBtn')?.addEventListener('click', () => { refresh(); toast('Refreshing…', { kind: 'info', timeout: 1200 }); });
  $('helpBtn')?.addEventListener('click', openHelp);
  $('settingsBtn')?.addEventListener('click', openSettings);
  if (SETTINGS.reduceMotion) document.body.classList.add('reduce-motion');
  applyAutoPoll();
}

/* ---------- Onboarding (first visit) + footer ---------- */
function renderOnboarding() {
  if (localStorage.getItem('wf.onboarded')) return;
  const host = $('view-dashboard');
  if (!host) return;
  const hostedReady = zkConfigured() && SETTINGS.sponsorUrl && CFG.llmProxyUrl;
  const card = document.createElement('div');
  card.className = 'onboard';
  card.innerHTML =
    '<div><h3>Welcome to Signet</h3>' +
    (hostedReady
      ? '<p>Start with Google sign-in, sponsored gas, and the hosted LLM proxy: no wallet, no SUI, no API key. Wallet and BYOK stay available as fallbacks.</p></div>'
      : '<p>An agent-native release network on Sui + Walrus. Connect a wallet or configure zkLogin + sponsor + hosted LLM for the no-wallet path. Every release has a verifiable provenance chain.</p></div>') +
    '<div class="onboard-cta">' +
    (hostedReady ? '<button class="btn-primary" id="obGoogle">Continue with Google</button>' : '') +
    '<button class="' + (hostedReady ? 'btn-ghost' : 'btn-primary') + '" id="obPlay">Open the Playground</button>' +
    '<button class="btn-ghost" id="obConnect">Connect wallet</button>' +
    '<button class="btn-ghost" id="obVerify">Verify a release</button>' +
    '<button class="btn-ghost" id="obHelp">How it works</button></div>' +
    '<button class="onboard-x" id="obX" title="dismiss">x</button>';
  host.insertBefore(card, host.firstChild);
  const done = () => { localStorage.setItem('wf.onboarded', '1'); card.remove(); };
  $('obX').addEventListener('click', done);
  $('obGoogle')?.addEventListener('click', () => { done(); beginZkLogin(); });
  $('obPlay').addEventListener('click', () => { done(); activateNav('playground'); });
  $('obVerify').addEventListener('click', () => { done(); activateNav('verify'); });
  $('obConnect').addEventListener('click', () => { done(); import('./wallet.js').then((m) => m.connectWallet()); });
  $('obHelp').addEventListener('click', openHelp);
}

function renderFooter() {
  const content = document.querySelector('.content');
  if (!content || $('wfFooter')) return;
  const f = document.createElement('div');
  f.id = 'wfFooter';
  f.className = 'footer';
  f.innerHTML =
    '<span class="foot-brand">Signet</span>' +
    `<a target="_blank" rel="noreferrer" href="${explorerObject(CFG.packageId)}">Package ↗</a>` +
    '<a target="_blank" rel="noreferrer" href="https://docs.wal.app/">Walrus docs ↗</a>' +
    '<a target="_blank" rel="noreferrer" href="https://docs.sui.io/">Sui docs ↗</a>' +
    '<a target="_blank" rel="noreferrer" href="https://suiscan.xyz/' + CFG.network + '/home">Suiscan ↗</a>' +
    '<a target="_blank" rel="noreferrer" href="https://sui.io/overflow">Sui Overflow ↗</a>';
  content.appendChild(f);
}

wireUI();
wireTopbar();
wireSearch();
wireWallet();
wirePlayground();
renderOnboarding();
renderFooter();
renderConnect();
// zkLogin: finish a Google redirect (if returning) or restore an active session.
(async () => { if (!(await completeZkLoginFromRedirect())) await restoreZkLogin(); })();
// If a transaction was in flight when the page was refreshed, confirm it now.
recoverPendingTx();
// re-render views when wallet connects/disconnects (My highlight, action buttons)
document.addEventListener('wf:wallet-changed', () => { if (STATE.loaded) rerenderAll(); });
// after a wallet tx, refresh data
document.addEventListener('wf:tx-done', () => { refresh(); });
// resolve SuiNS names for visible addresses, then re-render once
document.addEventListener('wf:data-loaded', async () => {
  const addrs = new Set();
  STATE.repos.forEach((r) => addrs.add(r.owner));
  STATE.prs.forEach((p) => addrs.add(p.author));
  STATE.reps.forEach((a) => addrs.add(a.agent));
  let any = false;
  await Promise.all([...addrs].slice(0, 20).map(async (a) => {
    if (!STATE.nameCache.has(a)) { await resolveName(a); any = true; }
  }));
  if (any) rerenderAll();
}, { once: false });
// Playground is the product's front door; if the URL has #<view>, honor it.
{
  const raw = (location.hash || '').replace('#', '');
  const [initial, hq] = raw.split('?');
  const startView = VIEW_TITLES[initial] ? initial : 'playground';
  const rel = new URLSearchParams(hq || location.search.replace(/^\?/, '')).get('release');
  if (rel) pendingVerifyId = rel;
  showView(startView);
  const navEl = document.querySelector(`[data-nav="${startView}"]`);
  if (navEl) { document.querySelectorAll('[data-nav]').forEach((x) => x.classList.remove('active')); navEl.classList.add('active'); }
}
// Honor back/forward and manual hash edits (deep-linking). Ignore junk/OAuth fragments.
window.addEventListener('hashchange', () => {
  const [v, q] = (location.hash || '').replace('#', '').split('?');
  if (VIEW_TITLES[v]) {
    const rel = new URLSearchParams(q || '').get('release');
    if (rel) pendingVerifyId = rel;
    showView(v); activateNav(v);
  }
});
loadData();
