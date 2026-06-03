/**
 * Seed ONE repository with a complete, verifiable provenance chain so that
 * `forge verify --release <id>` passes every check (including "signed review"
 * and "reviewed code == released code").
 *
 * Flow: create repo → grant two agent caps → agent A opens a PR → agent B
 * reviews it (signed) → owner merges (PR snapshot becomes the repo's current
 * snapshot) → owner publishes a release from that merged snapshot.
 *
 * Network from FORGE_NETWORK (testnet | mainnet). On mainnet, blob writes go
 * through the walrus CLI (WALRUS_BIN / WALRUS_CONFIG env), so they spend WAL.
 *
 * Usage: FORGE_NETWORK=mainnet WALRUS_BIN=... WALRUS_CONFIG=... \
 *        node --import tsx scripts/seed-one-clean.mjs
 */

import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import {
  makeContext, makeContextWithKeypair, createRepo, grantAgentCap, mergePr,
  publishRelease, createdOfType, SCOPE_OPEN_PR, SCOPE_REVIEW,
} from '../src/lib/sui.ts';
import { prCreate, reviewSubmit } from '../src/lib/actions.ts';
import { findReputationLedger } from '../src/lib/forge-read.ts';
import { buildSnapshotFromMemory } from '../src/lib/snapshot.ts';
import { storeBlobAuto } from '../src/lib/walrus.ts';

const NET = process.env.FORGE_NETWORK === 'mainnet' ? 'mainnet' : 'testnet';
const owner = makeContext(NET);
const pkg = owner.deployment.packageId;
console.log(`[clean] ${NET} · owner ${owner.address.slice(0, 10)}… on pkg ${pkg.slice(0, 10)}…`);

const A = makeAgent('author');
const B = makeAgent('reviewer');
function makeAgent(label) {
  const kp = new Ed25519Keypair();
  return { label, kp, addr: kp.getPublicKey().toSuiAddress(), ctx: makeContextWithKeypair(kp, NET) };
}

async function fund(addr, mist) {
  const tx = new Transaction();
  const [c] = tx.splitCoins(tx.gas, [tx.pure.u64(mist)]);
  tx.transferObjects([c], tx.pure.address(addr));
  const res = await owner.client.signAndExecuteTransaction({ signer: owner.keypair, transaction: tx, options: { showEffects: true } });
  await owner.client.waitForTransaction({ digest: res.digest });
}

async function capFor(addr, repoId) {
  const res = await owner.client.getOwnedObjects({ owner: addr, filter: { StructType: `${pkg}::forge::AgentCap` }, options: { showContent: true } });
  for (const o of res.data) {
    if ((o.data?.content?.fields ?? {}).repo_id === repoId) return o.data.objectId;
  }
  return null;
}

async function waitVisible(repoId) {
  for (let i = 0; i < 12; i++) {
    const o = await owner.client.getObject({ id: repoId, options: { showType: true } }).catch(() => null);
    if (o?.data?.type?.includes('::forge::Repository')) return;
    await new Promise((r) => setTimeout(r, 1500));
  }
}

const files0 = (name) => [
  { path: 'Move.toml', content: `[package]\nname = "${name}"\nedition = "2024"\n` },
  { path: 'sources/lib.move', content: `module demo::core { public fun v(): u64 { 0 } }\n` },
  { path: 'README.md', content: `# ${name}\n\nClean provenance demo.\n` },
];
const files1 = (name) => [
  { path: 'Move.toml', content: `[package]\nname = "${name}"\nedition = "2024"\n` },
  { path: 'sources/lib.move', content: `module demo::core { public fun v(): u64 { 1 } }\n` },
  { path: 'README.md', content: `# ${name}\n\nClean provenance demo (reviewed).\n` },
];

const ts = Number(process.env.SEED_SALT || process.argv[2] || '1');
const name = `provenance-demo-${ts}`;

console.log('[clean] funding agents…');
await fund(A.addr, 80_000_000);
await fund(B.addr, 80_000_000);

// 1) create repo
const { archive, manifest } = buildSnapshotFromMemory({ files: files0(name), name, branch: 'main', previousSnapshot: null, nowEpochMs: ts * 1000 });
const arch = await storeBlobAuto(archive);
const man = await storeBlobAuto(JSON.stringify({ ...manifest, archiveBlob: arch.blobId }));
const cres = await createRepo(owner, { name, defaultBranch: 'main', initialSnapshot: man.blobId });
const repoId = createdOfType(cres, '::forge::Repository')[0];
const ownerCapId = createdOfType(cres, '::forge::RepoOwnerCap')[0];
const reputationId = await findReputationLedger(repoId);
await waitVisible(repoId);
console.log(`[clean] repo ${name} → ${repoId.slice(0, 12)}…`);

// 2) grant caps
await grantAgentCap(owner, { repoId, ownerCapId, recipient: A.addr, scopes: SCOPE_OPEN_PR, expiresAtEpoch: 0, label: A.label });
await grantAgentCap(owner, { repoId, ownerCapId, recipient: B.addr, scopes: SCOPE_REVIEW, expiresAtEpoch: 0, label: B.label });
const aCap = await capFor(A.addr, repoId);
const bCap = await capFor(B.addr, repoId);
console.log(`[clean] caps  author=${aCap?.slice(0, 10)}…  reviewer=${bCap?.slice(0, 10)}…`);

// 3) PR by author
const pr = await prCreate({ ctx: A.ctx, repoId, agentCapId: aCap, title: `Bump v() to 1`, files: files1(name) });
console.log(`[clean] PR    ${pr.prId.slice(0, 12)}…  head=${pr.headBlob.slice(0, 12)}…`);

// 4) signed review by reviewer
await reviewSubmit({ ctx: B.ctx, repoId, prId: pr.prId, agentCapId: bCap, verdict: 1, reportText: `Reviewed by ${B.label}: code looks correct, LGTM.` });
console.log('[clean] review submitted (verdict=approve)');

// 5) owner merges → PR head becomes repo current snapshot
await mergePr(owner, { repoId, reputationId, prId: pr.prId, ownerCapId });
console.log('[clean] PR merged');

// 6) publish release from the merged snapshot
const obj = await owner.client.getObject({ id: repoId, options: { showContent: true } });
const src = obj.data?.content?.fields?.current_snapshot;
const art = await storeBlobAuto(`build of ${name}`);
const rep = await storeBlobAuto(`tests passed for ${name}`);
const rel = await publishRelease(owner, { repoId, ownerCapId, version: 'v1.0.0', sourceSnapshot: src, buildArtifact: art.blobId, testReport: rep.blobId, mergedPrId: pr.prId });
const releaseId = createdOfType(rel, '::release::Release')[0];
console.log(`[clean] release v1.0.0 → ${releaseId}`);
console.log(`\nVerify it:\n  FORGE_NETWORK=${NET} npm run forge -- verify --release ${releaseId}`);
