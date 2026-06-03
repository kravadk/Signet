/**
 * Scheduled CI sweep (run by .github/workflows/agent-sweep.yml).
 *
 * As the CI agent (FORGE_CI_KEY), review every OPEN pull request on repos where
 * this agent holds a review-scope AgentCap, then re-verify the latest release.
 * Idempotent: a PR that already has a review is skipped (one auto-review per PR).
 *
 * Env: FORGE_CI_KEY (funded testnet key holding review caps), FORGE_NETWORK (default testnet).
 * Flags: --dry-run  → list what it WOULD review; no signing.
 *
 * Usage: FORGE_CI_KEY=suiprivkey1... node --import tsx scripts/ci-sweep.mjs [--dry-run]
 */
import { makeContextWithKeypair, SCOPE_REVIEW } from "../src/lib/sui.ts";
import { requireCiKey } from "../src/ci/keypair.ts";
import { listRepos, listOpenPullRequests, latestReleaseId } from "../src/lib/forge-read.ts";
import { verifyRelease } from "../src/lib/actions.ts";
import { reviewPr } from "../src/ci/worker.ts";

const DRY = process.argv.includes("--dry-run");
const NET = process.env.FORGE_NETWORK === "mainnet" ? "mainnet" : "testnet";
const ctx = makeContextWithKeypair(requireCiKey(), NET);
const pkg = ctx.deployment.packageId;
console.log(`[ci-sweep] ${NET} · agent ${ctx.address.slice(0, 10)}…${DRY ? " · DRY-RUN" : ""}`);

/** A review-scope AgentCap this agent owns for `repoId`, or null. */
async function reviewCapFor(repoId) {
  const res = await ctx.client.getOwnedObjects({
    owner: ctx.address,
    filter: { StructType: `${pkg}::forge::AgentCap` },
    options: { showContent: true },
  });
  for (const o of res.data) {
    const f = o.data?.content?.fields ?? {};
    if (f.repo_id === repoId && (Number(f.scopes ?? 0) & SCOPE_REVIEW)) return o.data.objectId;
  }
  return null;
}

let reviewed = 0, skipped = 0, failed = 0;
const repos = await listRepos();
console.log(`[ci-sweep] ${repos.length} repo(s)`);
for (const repo of repos) {
  const cap = await reviewCapFor(repo.id);
  if (!cap) continue; // agent has no review cap on this repo — skip
  const prs = await listOpenPullRequests(repo.id);
  for (const pr of prs) {
    if ((pr.reviewRefs?.length ?? 0) > 0) { skipped++; continue; } // already reviewed — idempotent
    if (DRY) { console.log(`  would review PR ${pr.id.slice(0, 10)}… in ${repo.name}`); reviewed++; continue; }
    try {
      const r = await reviewPr(ctx, { repoId: repo.id, prId: pr.id, capId: cap });
      console.log(`  ✓ ${pr.id.slice(0, 10)}… → ${r.passed ? "approve" : "request-changes"} (${r.digest.slice(0, 10)}…)`);
      reviewed++;
    } catch (e) {
      console.log(`  ✗ ${pr.id.slice(0, 10)}…: ${String(e?.message ?? e).slice(0, 80)}`);
      failed++;
    }
  }
}
console.log(`[ci-sweep] reviewed=${reviewed} skipped=${skipped} failed=${failed}`);

// Re-verify the latest release (read-only health signal).
try {
  const rel = await latestReleaseId();
  if (rel) {
    const v = await verifyRelease(rel);
    const okN = v.steps.filter((s) => s.ok).length;
    console.log(`[ci-sweep] verify ${rel.slice(0, 10)}… → SLSA L${v.level} (${okN}/${v.steps.length} checks ok)`);
  } else {
    console.log("[ci-sweep] no release to verify");
  }
} catch (e) {
  console.log(`[ci-sweep] verify failed: ${String(e?.message ?? e).slice(0, 80)}`);
}
