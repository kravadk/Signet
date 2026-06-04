/**
 * Signet — REAL on-chain end-to-end test (testnet, signs with the keystore key).
 *
 * Exercises the full provenance chain + the bounty/dispute economy via the SAME
 * SDK builders the CLI uses (and the web `pkgCall` mirrors):
 *   init repo → grant agent → open PR → review → merge → release(v2) → verify
 *   post-bounty-v2 → claim → open-dispute → resolve-dispute → read reliability.
 *
 * Spends a little testnet gas and creates real objects. Run from app/:
 *   node --import tsx scripts/e2e-onchain.mjs
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transaction } from '@mysten/sui/transactions';
import {
  loadKeypairFromKeystore, makeContextWithKeypair, writePkg,
  createRepo, grantAgentCap, openPrAsAgent, submitReviewAsAgent, mergePr,
  publishRelease, postBountyV2, claimBounty, openDispute, resolveDispute,
  createdOfType, SCOPE_OPEN_PR, SCOPE_REVIEW,
} from '../src/lib/sui.ts';
import { buildSnapshot } from '../src/lib/snapshot.ts';
import { storeBlobAuto } from '../src/lib/walrus.ts';
import { verifyRelease } from '../src/lib/actions.ts';

const NET = process.env.FORGE_NETWORK === 'mainnet' ? 'mainnet' : 'testnet';
const ctx = makeContextWithKeypair(loadKeypairFromKeystore(), NET);
const me = ctx.address;

let pass = 0, fail = 0;
const ok = (cond, msg, extra = '') => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}${extra ? '  ' + extra : ''}`); cond ? pass++ : (fail++, process.exitCode = 1); };

async function snapshotBlob(dir, name, files) {
  for (const [p, c] of Object.entries(files)) writeFileSync(join(dir, p), c);
  const { archive, manifest } = buildSnapshot({ repoDir: dir, name, branch: 'main', previousSnapshot: null, nowEpochMs: Date.now() });
  const ab = await storeBlobAuto(archive);
  const mb = await storeBlobAuto(JSON.stringify({ ...manifest, archiveBlob: ab.blobId }));
  return mb.blobId;
}

(async () => {
  console.log(`\nSignet on-chain e2e · ${NET} · signer ${me.slice(0, 10)}…\n`);
  const tmp = mkdtempSync(join(tmpdir(), 'signet-e2e-'));
  let res;
  try {
    // 1) init repo
    const name = 'signet-e2e-' + Date.now();
    const m0 = await snapshotBlob(tmp, name, { 'README.md': '# e2e\n', 'a.move': 'module e2e::a {}\n' });
    res = await createRepo(ctx, { name, defaultBranch: 'main', initialSnapshot: m0 });
    const repoId = createdOfType(res, '::forge::Repository')[0];
    const ownerCapId = createdOfType(res, '::forge::RepoOwnerCap')[0];
    const reputationId = createdOfType(res, '::reputation::RepoReputation')[0];
    ok(repoId && ownerCapId && reputationId, 'init repo', repoId);

    // 2) grant an AgentCap to self (open_pr + review)
    res = await grantAgentCap(ctx, { repoId, ownerCapId, recipient: me, scopes: SCOPE_OPEN_PR | SCOPE_REVIEW, expiresAtEpoch: 0, label: 'e2e' });
    const agentCapId = createdOfType(res, '::forge::AgentCap')[0];
    ok(!!agentCapId, 'grant-agent (open_pr+review)', agentCapId);

    // 3) open PR as agent (new head snapshot)
    const m1 = await snapshotBlob(tmp, name, { 'README.md': '# e2e v2\n', 'a.move': 'module e2e::a { public fun f() {} }\n' });
    res = await openPrAsAgent(ctx, { repoId, reputationId, agentCapId, headSnapshot: m1, diffManifest: m1, title: 'e2e: add f()' });
    const prId = createdOfType(res, '::pull_request::PullRequest')[0];
    ok(!!prId, 'open-pr', prId);

    // 4) signed review (approve) with a CI report blob
    const reportBlob = (await storeBlobAuto('e2e: sui move test -> OK. Total tests: 60; passed: 60')).blobId;
    res = await submitReviewAsAgent(ctx, { repoId, reputationId, prId, agentCapId, verdict: 1, reportBlob });
    ok(res.effects?.status?.status === 'success', 'review (approve, signed)', res.digest);

    // 5) merge (owner)
    res = await mergePr(ctx, { repoId, reputationId, prId, ownerCapId });
    ok(res.effects?.status?.status === 'success', 'merge PR', res.digest);

    // 6) release v2 — hard-links the merged PR
    const artifact = (await storeBlobAuto('e2e build artifact')).blobId;
    res = await publishRelease(ctx, { repoId, ownerCapId, version: 'v0.1.0', sourceSnapshot: m1, buildArtifact: artifact, testReport: reportBlob, mergedPrId: prId });
    const releaseId = createdOfType(res, '::release::Release')[0];
    ok(!!releaseId, 'release v2 (linked merged_pr)', releaseId);

    // 7) independent verify
    const v = await verifyRelease(releaseId);
    ok(v.pass, `verify -> ${v.levelLabel}`, (v.steps || []).map((s) => (s.ok ? '✓' : '✗')).join(''));

    // 8) bounty v2 (deadline none, proof not required)
    res = await postBountyV2(ctx, { repoId, title: 'e2e bounty', amountMist: 1_000_000, minScore: 0, deadlineMs: 0, proofRequired: false });
    const bountyId = createdOfType(res, '::bounty::Bounty')[0];
    const termsId = createdOfType(res, '::bounty::BountyTerms')[0];
    ok(bountyId && termsId, 'post-bounty-v2 (+terms)', bountyId);

    // 9) claim
    res = await claimBounty(ctx, { bountyId, reputationId });
    ok(res.effects?.status?.status === 'success', 'claim-bounty', res.digest);

    // 10) open dispute (records claimant SLA in ReliabilityLedger)
    res = await openDispute(ctx, { bountyId, reason: 'e2e dispute' });
    const disputeId = createdOfType(res, '::bounty::BountyDispute')[0];
    ok(!!disputeId, 'open-dispute', disputeId);

    // 11) arbitrate 50/50 (fee -> treasury, rest -> funder)
    res = await resolveDispute(ctx, { bountyId, disputeId, repoId, ownerCapId, payoutBps: 5000 });
    ok(res.effects?.status?.status === 'success', 'resolve-dispute (50%)', res.digest);

    // 12) read on-chain reliability for the claimant
    try {
      const led = await ctx.client.getObject({ id: ctx.deployment.reliabilityLedger, options: { showContent: true } });
      const tableId = led?.data?.content?.fields?.records?.fields?.id?.id;
      const f = await ctx.client.getDynamicFieldObject({ parentId: tableId, name: { type: 'address', value: me } });
      const rel = f?.data?.content?.fields?.value?.fields;
      ok(rel && Number(rel.disputed) >= 1, 'ReliabilityLedger disputed>=1', JSON.stringify(rel));
    } catch (e) { ok(false, 'ReliabilityLedger read', String(e.message || e)); }

    // 13-15) payment links (v12 payment module)
    const PKG = writePkg(ctx.deployment);
    let ptx = new Transaction();
    const none = ptx.moveCall({ target: '0x1::option::none', typeArguments: ['u64'], arguments: [] });
    ptx.moveCall({ target: `${PKG}::payment::create_request`, arguments: [ptx.pure.address(me), ptx.pure.string('e2e invoice'), ptx.pure.u64(1_000_000), none, ptx.object('0x6')] });
    res = await ctx.client.signAndExecuteTransaction({ signer: ctx.keypair, transaction: ptx, options: { showObjectChanges: true, showEffects: true } });
    await ctx.client.waitForTransaction({ digest: res.digest });
    const reqId = createdOfType(res, '::payment::PaymentRequest')[0];
    ok(!!reqId && res.effects?.status?.status === 'success', 'payment create_request', reqId);

    const ptx2 = new Transaction();
    const [pc] = ptx2.splitCoins(ptx2.gas, [ptx2.pure.u64(1_000_000)]);
    ptx2.moveCall({ target: `${PKG}::payment::pay`, arguments: [ptx2.object(reqId), pc, ptx2.object('0x6')] });
    res = await ctx.client.signAndExecuteTransaction({ signer: ctx.keypair, transaction: ptx2, options: { showEffects: true } });
    await ctx.client.waitForTransaction({ digest: res.digest });
    ok(res.effects?.status?.status === 'success', 'payment pay', res.digest);

    const pobj = await ctx.client.getObject({ id: reqId, options: { showContent: true } });
    ok(pobj?.data?.content?.fields?.paid === true, 'payment marked paid on-chain', `paid=${pobj?.data?.content?.fields?.paid}`);

    console.log(`\n${pass} passed · ${fail} failed\n`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
})().catch((e) => { console.error('\nE2E ERROR:', e.stack || e.message || e); process.exitCode = 1; });
