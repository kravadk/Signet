/**
 * Seed the WalrusForge network with realistic activity so the dashboard reads as
 * a living network with several repos, PRs and agents.
 *
 * Owner (CLI keystore) creates N repos; funds a few ephemeral agent identities;
 * grants them AgentCaps; agents open PRs + reviews via the same PTB builders the
 * MCP/CLI use; owner merges most and publishes releases on half; agents vouch and
 * a couple of bounties are posted. Variation yields varied reputation scores.
 *
 * Agent keys are ephemeral (generated per run, never written to disk/logs).
 *
 * Usage: node --import tsx scripts/seed-network.mjs [repoCount]
 */

import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import {
  makeContext, makeContextWithKeypair, createRepo, grantAgentCap, mergePr,
  publishRelease, vouch, postBounty, createdOfType, SCOPE_OPEN_PR, SCOPE_REVIEW,
} from '../src/lib/sui.ts';
import { prCreate, reviewSubmit } from '../src/lib/actions.ts';
import { findReputationLedger } from '../src/lib/forge-read.ts';
import { buildSnapshotFromMemory } from '../src/lib/snapshot.ts';
import { storeBlob, storeBlobViaCli, walrusConfigFor } from '../src/lib/walrus.ts';

const REPO_COUNT = Number(process.argv[2] || 8);
// Network from FORGE_NETWORK env (testnet | mainnet), default testnet.
// Agents are funded from the owner's own SUI (not faucet), so this works on mainnet.
const NET = process.env.FORGE_NETWORK === 'mainnet' ? 'mainnet' : 'testnet';
const owner = makeContext(NET);
const pkg = owner.deployment.packageId;
const WAL = walrusConfigFor(NET); // Walrus HTTP config (reads + testnet writes)
// Mainnet has no free public HTTP publisher, so writes go through the `walrus`
// CLI (spends WAL from the active wallet). Testnet uses the free HTTP publisher.
const WALRUS_BIN = process.env.WALRUS_BIN; // path to walrus.exe (mainnet only)
const WALRUS_CONFIG = process.env.WALRUS_CONFIG; // walrus client config (mainnet only)
const put = (data) =>
  NET === 'mainnet'
    ? storeBlobViaCli(data, { epochs: 5, bin: WALRUS_BIN, config: WALRUS_CONFIG, context: 'mainnet' })
    : storeBlob(data, { config: WAL });
console.log(`[seed] ${NET} · owner ${owner.address.slice(0, 10)}… on pkg ${pkg.slice(0, 10)}… · walrus ${NET === 'mainnet' ? 'CLI' : WAL.publisher}`);

const AGENTS = ['aria', 'bolt', 'cleo'].map((label) => {
  const kp = new Ed25519Keypair();
  return { label, kp, addr: kp.getPublicKey().toSuiAddress(), ctx: makeContextWithKeypair(kp, NET) };
});

const CAPS = new Map(); // `${label}:${repoId}` -> capId
let capLedger = null;   // a ledger to use for vouching
const capOf = (agent, repoId) => CAPS.get(agent.label + ':' + repoId) || null;

async function fundAgent(addr, mist) {
  const tx = new Transaction();
  const [c] = tx.splitCoins(tx.gas, [tx.pure.u64(mist)]);
  tx.transferObjects([c], tx.pure.address(addr));
  const res = await owner.client.signAndExecuteTransaction({ signer: owner.keypair, transaction: tx, options: { showEffects: true } });
  await owner.client.waitForTransaction({ digest: res.digest });
}

async function recordCaps(repoId, reputationId, grantee) {
  for (const a of grantee) {
    const res = await owner.client.getOwnedObjects({ owner: a.addr, filter: { StructType: `${pkg}::forge::AgentCap` }, options: { showContent: true } });
    for (const o of res.data) {
      const f = o.data?.content?.fields ?? {};
      if (f.repo_id === repoId) {
        CAPS.set(a.label + ':' + repoId, o.data.objectId);
        if (!capLedger) capLedger = reputationId;
      }
    }
  }
}

const REPO_NAMES = [
  'walrus-indexer', 'sui-mcp-kit', 'agent-memory-sdk', 'move-lint',
  'seal-vault-demo', 'provenance-cli', 'reputation-graph', 'quilt-packer',
  'nautilus-attestor', 'graphql-reads',
];
const fileFor = (name, n) => [
  { path: 'Move.toml', content: `[package]\nname = "${name}"\nedition = "2024"\n` },
  { path: 'sources/lib.move', content: `module demo::${name.replace(/-/g, '_')} {\n  public fun version(): u64 { ${n} }\n}\n` },
  { path: 'README.md', content: `# ${name}\n\nSeeded WalrusForge repo (rev ${n}).\n` },
];

async function seedRepo(i, salt) {
  const name = (REPO_NAMES[i] || `repo-${i}`) + '-' + salt;
  const files = fileFor(name, 0);
  const { archive, manifest } = buildSnapshotFromMemory({ files, name, branch: 'main', previousSnapshot: null, nowEpochMs: Date.now() });
  const archiveBlob = await put(archive);
  const manifestBlob = await put(JSON.stringify({ ...manifest, archiveBlob: archiveBlob.blobId }));
  const res = await createRepo(owner, { name, defaultBranch: 'main', initialSnapshot: manifestBlob.blobId });
  const repoId = createdOfType(res, '::forge::Repository')[0];
  const ownerCapId = createdOfType(res, '::forge::RepoOwnerCap')[0];
  const reputationId = await findReputationLedger(repoId);
  // Wait until the Repository object is readable from the fullnode the agent
  // clients use, otherwise prCreate races and hits "Repository not found"
  // (read-after-write lag is larger on mainnet).
  for (let attempt = 0; attempt < 10; attempt++) {
    const o = await owner.client.getObject({ id: repoId, options: { showType: true } }).catch(() => null);
    if (o?.data?.type?.includes('::forge::Repository')) break;
    await new Promise((r) => setTimeout(r, 1500));
  }
  console.log(`[seed] repo ${name} → ${repoId.slice(0, 10)}…`);
  return { name, repoId, ownerCapId, reputationId };
}

async function main() {
  const salt = String(Date.now()).slice(-5);
  console.log('[seed] funding agents…');
  for (const a of AGENTS) { await fundAgent(a.addr, 30_000_000); console.log(`   ${a.label} ${a.addr.slice(0, 10)}… funded`); }

  for (let i = 0; i < REPO_COUNT; i++) {
    const repo = await seedRepo(i, salt);
    const grantee = AGENTS.slice(0, 1 + (i % AGENTS.length)); // 1..3 agents
    for (const a of grantee) {
      await grantAgentCap(owner, { repoId: repo.repoId, ownerCapId: repo.ownerCapId, recipient: a.addr, scopes: SCOPE_OPEN_PR | SCOPE_REVIEW, expiresAtEpoch: 0, label: a.label });
    }
    await recordCaps(repo.repoId, repo.reputationId, grantee);

    const prCount = 1 + (i % 3);
    for (let p = 0; p < prCount; p++) {
      const author = grantee[p % grantee.length];
      const reviewer = grantee[(p + 1) % grantee.length];
      const authCap = capOf(author, repo.repoId);
      if (!authCap) continue;
      let pr;
      try {
        pr = await prCreate({ ctx: author.ctx, repoId: repo.repoId, agentCapId: authCap, title: `Improve ${repo.name} #${p + 1}`, files: fileFor(repo.name, p + 1) });
      } catch (e) { console.log(`   pr skip: ${(e.message || e).slice(0, 70)}`); continue; }
      const revCap = capOf(reviewer, repo.repoId);
      if (revCap) {
        try { await reviewSubmit({ ctx: reviewer.ctx, repoId: repo.repoId, prId: pr.prId, agentCapId: revCap, verdict: 1, reportText: `Reviewed by ${reviewer.label}: LGTM.` }); } catch { /* skip */ }
      }
      if ((i + p) % 5 !== 0) {
        try { await mergePr(owner, { repoId: repo.repoId, reputationId: repo.reputationId, prId: pr.prId, ownerCapId: repo.ownerCapId }); } catch { /* min_approvals/stale */ }
      }
    }

    if (i % 2 === 0) {
      try {
        const art = await put(`build of ${repo.name}`);
        const rep = await put(`tests passed for ${repo.name}`);
        const obj = await owner.client.getObject({ id: repo.repoId, options: { showContent: true } });
        const src = obj.data?.content?.fields?.current_snapshot;
        await publishRelease(owner, { repoId: repo.repoId, ownerCapId: repo.ownerCapId, version: 'v1.0.0', sourceSnapshot: src, buildArtifact: art.blobId, testReport: rep.blobId });
        console.log(`   release v1.0.0`);
      } catch (e) { console.log(`   release skip: ${(e.message || e).slice(0, 70)}`); }
    }

    if (i === 1 || i === 4) {
      try { await postBounty(owner, { repoId: repo.repoId, title: `Fix edge case in ${repo.name}`, amountMist: 10_000_000, minScore: i === 4 ? 10 : 0 }); console.log(`   bounty (minScore ${i === 4 ? 10 : 0})`); } catch { /* skip */ }
    }
  }

  if (capLedger) {
    const aria = AGENTS[0];
    for (const subj of [AGENTS[1], AGENTS[2]]) {
      try { await vouch(aria.ctx, { reputationId: capLedger, subject: subj.addr }); console.log(`   ${aria.label} vouched ${subj.label}`); }
      catch (e) { console.log(`   vouch skip: ${(e.message || e).slice(0, 70)}`); }
    }
  }

  console.log('[seed] done.');
  process.exit(0);
}

main().catch((e) => { console.error('[seed] failed:', e); process.exit(1); });
