#!/usr/bin/env -S npx tsx
/**
 * Signet CLI.
 *
 * Commands:
 *   forge init            create a repo: snapshot the dir, upload to Walrus,
 *                         create the on-chain Repository.
 *   forge push-snapshot   upload a new snapshot of the dir to Walrus (no merge).
 *   forge grant-agent     grant an AgentCap to an address.
 *   forge open-pr         open a PR from the current dir as an agent.
 *   forge review          submit a review with a Walrus test report.
 *   forge merge           merge a PR (owner only).
 *   forge release         publish a release with the full provenance chain.
 *   forge status          show on-chain repo state.
 *
 * Local bookkeeping (repoId, ownerCapId, latest blobs) lives in .forge/state.json.
 */

import { Command } from "commander";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { storeBlobAuto, blobUrl, renewBlob } from "../lib/walrus.js";
import { buildSnapshot, merkleProof, verifyMerkleProof } from "../lib/snapshot.js";
import {
  makeContext,
  createRepo,
  grantAgentCap,
  revokeAgentCap,
  openPrAsAgent,
  submitReviewAsAgent,
  mergePr,
  publishRelease,
  vouch,
  setMinApprovals,
  postBountyV2,
  claimBounty,
  openDispute,
  resolveDispute,
  cancelExpired,
  createdOfType,
  SCOPE_OPEN_PR,
  SCOPE_REVIEW,
  SCOPE_BITS,
  CAP_PRESETS,
} from "../lib/sui.js";
import { findReputationLedger, getRelease, fetchManifest } from "../lib/forge-read.js";

interface ForgeState {
  network: string;
  name: string;
  branch: string;
  repoId: string;
  ownerCapId: string;
  reputationId: string; // shared RepoReputation ledger id
  currentSnapshot: string; // tree hash of the archive
  currentManifestBlob: string; // the ref the chain points at
}

function statePath(dir: string): string {
  return join(dir, ".forge", "state.json");
}
function loadState(dir: string): ForgeState {
  const p = statePath(dir);
  if (!existsSync(p)) throw new Error("No .forge/state.json — run `forge init` first.");
  return JSON.parse(readFileSync(p, "utf8"));
}
function saveState(dir: string, s: ForgeState): void {
  mkdirSync(join(dir, ".forge"), { recursive: true });
  writeFileSync(statePath(dir), JSON.stringify(s, null, 2));
}

function epochMs(): number {
  // Allowed at runtime in the CLI (not inside a workflow script).
  return Date.now();
}

/** Upload an archive + its manifest to Walrus; return both blob ids. */
async function uploadSnapshot(
  dir: string,
  name: string,
  branch: string,
  previousManifestBlob: string | null,
) {
  const { archive, manifest } = buildSnapshot({
    repoDir: dir,
    name,
    branch,
    previousSnapshot: previousManifestBlob,
    nowEpochMs: epochMs(),
  });
  const archiveBlob = await storeBlobAuto(archive);
  // Embed the archive blob id into the manifest so it's self-describing.
  const manifestWithArchive = { ...manifest, archiveBlob: archiveBlob.blobId };
  const manifestBlob = await storeBlobAuto(JSON.stringify(manifestWithArchive));
  return { archiveBlob: archiveBlob.blobId, manifestBlob: manifestBlob.blobId, manifest };
}

// Active network from FORGE_NETWORK env (testnet | mainnet), default testnet.
const NET = process.env.FORGE_NETWORK === "mainnet" ? "mainnet" : "testnet";

const program = new Command();
program.name("forge").description("Signet — agent-native release network").version("0.1.0");

program
  .command("init")
  .description("Create a repo: snapshot dir -> Walrus -> on-chain Repository")
  .requiredOption("-n, --name <name>", "repository name (globally unique)")
  .option("-d, --dir <dir>", "directory to snapshot", ".")
  .option("-b, --branch <branch>", "default branch", "main")
  .action(async (opts) => {
    const ctx = makeContext(NET);
    console.log(`signer: ${ctx.address}`);
    console.log(`snapshotting ${opts.dir} ...`);
    const { archiveBlob, manifestBlob, manifest } = await uploadSnapshot(
      opts.dir, opts.name, opts.branch, null,
    );
    console.log(`  archive blob:  ${archiveBlob}`);
    console.log(`  manifest blob: ${manifestBlob}  (${manifest.files.length} files)`);

    console.log("creating on-chain Repository ...");
    const res = await createRepo(ctx, {
      name: opts.name,
      defaultBranch: opts.branch,
      initialSnapshot: manifestBlob,
    });
    const repoId = createdOfType(res, "::forge::Repository")[0];
    const ownerCapId = createdOfType(res, "::forge::RepoOwnerCap")[0];
    const reputationId = createdOfType(res, "::reputation::RepoReputation")[0];

    saveState(opts.dir, {
      network: NET,
      name: opts.name,
      branch: opts.branch,
      repoId,
      ownerCapId,
      reputationId,
      currentSnapshot: manifest.treeHash,
      currentManifestBlob: manifestBlob,
    });

    console.log(`\n✓ repo created`);
    console.log(`  tx:         ${res.digest}`);
    console.log(`  Repository: ${repoId}`);
    console.log(`  OwnerCap:   ${ownerCapId}`);
    console.log(`  manifest:   ${blobUrl(manifestBlob)}`);
  });

program
  .command("import")
  .description("Import a GitHub repo: clone -> snapshot -> Walrus -> on-chain Repository")
  .requiredOption("-u, --url <git-url>", "GitHub repo URL (https or git)")
  .option("-b, --branch <branch>", "branch to import", "main")
  .option("-n, --name <name>", "repository name (defaults to the GitHub repo name)")
  .action(async (opts) => {
    const { execFileSync } = await import("node:child_process");
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join, basename } = await import("node:path");
    const name = opts.name || basename(String(opts.url).replace(/\.git$/, ""));
    const tmp = mkdtempSync(join(tmpdir(), "signet-import-"));
    try {
      console.log(`cloning ${opts.url} (branch ${opts.branch}) ...`);
      execFileSync("git", ["clone", "--depth", "1", "--branch", opts.branch, String(opts.url), tmp], { stdio: "inherit" });
      // Drop the VCS metadata so only working-tree content is snapshotted.
      rmSync(join(tmp, ".git"), { recursive: true, force: true });
      const ctx = makeContext(NET);
      console.log(`signer: ${ctx.address}`);
      console.log(`snapshotting clone ...`);
      const { archiveBlob, manifestBlob, manifest } = await uploadSnapshot(tmp, name, opts.branch, null);
      console.log(`  archive blob:  ${archiveBlob}`);
      console.log(`  manifest blob: ${manifestBlob}  (${manifest.files.length} files)`);
      console.log("creating on-chain Repository ...");
      const res = await createRepo(ctx, { name, defaultBranch: opts.branch, initialSnapshot: manifestBlob });
      const repoId = createdOfType(res, "::forge::Repository")[0];
      const ownerCapId = createdOfType(res, "::forge::RepoOwnerCap")[0];
      const reputationId = createdOfType(res, "::reputation::RepoReputation")[0];
      // Persist state in the CWD so follow-up commands (push-snapshot/release) work.
      saveState(".", {
        network: NET, name, branch: opts.branch, repoId, ownerCapId, reputationId,
        currentSnapshot: manifest.treeHash, currentManifestBlob: manifestBlob,
      });
      console.log(`\n✓ imported ${opts.url} -> repo ${repoId}`);
      console.log(`  tx:       ${res.digest}`);
      console.log(`  OwnerCap: ${ownerCapId}`);
      console.log(`  manifest: ${blobUrl(manifestBlob)}`);
      console.log(`  state saved to ./.signet — run forge push-snapshot / release next`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

program
  .command("push-snapshot")
  .description("Upload a new snapshot of the dir to Walrus (does not move the ref)")
  .option("-d, --dir <dir>", "directory to snapshot", ".")
  .action(async (opts) => {
    const s = loadState(opts.dir);
    const { archiveBlob, manifestBlob, manifest } = await uploadSnapshot(
      opts.dir, s.name, s.branch, s.currentManifestBlob,
    );
    console.log(`✓ snapshot uploaded`);
    console.log(`  archive:  ${archiveBlob}`);
    console.log(`  manifest: ${manifestBlob}  (${manifest.files.length} files)`);
    console.log(`  url:      ${blobUrl(manifestBlob)}`);
    console.log(`\nuse this manifest blob as the head for \`forge open-pr\`.`);
  });

program
  .command("grant-agent")
  .description("Grant an AgentCap to an address (use --preset or --scopes; defaults to open_pr+review)")
  .requiredOption("-r, --recipient <address>", "agent address")
  .option("-d, --dir <dir>", "repo dir", ".")
  .option(
    "--preset <name>",
    `capability preset: ${Object.keys(CAP_PRESETS).join(" | ")}`,
  )
  .option("--scopes <csv>", "explicit scopes, comma-separated: open_pr,review,run_ci")
  .option("--expires <epoch>", "expiry epoch (0 = never)", "0")
  .option("--label <label>", "human label")
  .action(async (opts) => {
    const ctx = makeContext(NET);
    const s = loadState(opts.dir);
    // Resolve scopes + label: --scopes > --preset > default(open_pr+review).
    let scopes: number;
    let label: string;
    if (opts.scopes) {
      const bits = String(opts.scopes)
        .split(",")
        .map((t: string) => t.trim().toLowerCase())
        .filter(Boolean);
      const unknown = bits.filter((b: string) => !(b in SCOPE_BITS));
      if (unknown.length) {
        console.error(`unknown scope(s): ${unknown.join(", ")} — valid: ${Object.keys(SCOPE_BITS).join(", ")}`);
        process.exit(1);
      }
      scopes = bits.reduce((m: number, b: string) => m | SCOPE_BITS[b], 0);
      label = opts.label ?? "agent";
    } else if (opts.preset) {
      const preset = CAP_PRESETS[opts.preset];
      if (!preset) {
        console.error(`unknown preset: ${opts.preset} — valid: ${Object.keys(CAP_PRESETS).join(", ")}`);
        process.exit(1);
      }
      scopes = preset.scopes;
      label = opts.label ?? preset.label;
    } else {
      scopes = SCOPE_OPEN_PR | SCOPE_REVIEW;
      label = opts.label ?? "agent";
    }
    const res = await grantAgentCap(ctx, {
      repoId: s.repoId,
      ownerCapId: s.ownerCapId,
      recipient: opts.recipient,
      scopes,
      expiresAtEpoch: Number(opts.expires),
      label,
    });
    const capId = createdOfType(res, "::forge::AgentCap")[0];
    console.log(`✓ AgentCap granted to ${opts.recipient}`);
    console.log(`  cap: ${capId}`);
    console.log(`  tx:  ${res.digest}`);
  });

program
  .command("revoke-agent")
  .description("Revoke a previously-granted AgentCap (owner only) — instant kill-switch")
  .requiredOption("--cap <agentCapId>", "AgentCap object id to revoke")
  .option("-d, --dir <dir>", "repo dir", ".")
  .action(async (opts) => {
    const ctx = makeContext(NET);
    const s = loadState(opts.dir);
    const res = await revokeAgentCap(ctx, {
      repoId: s.repoId,
      ownerCapId: s.ownerCapId,
      agentCapId: opts.cap,
    });
    console.log(`✓ AgentCap revoked: ${opts.cap}`);
    console.log(`  tx: ${res.digest}`);
  });

program
  .command("open-pr")
  .description("Open a PR as an agent using an AgentCap")
  .requiredOption("--cap <agentCapId>", "AgentCap object id")
  .requiredOption("--title <title>", "PR title")
  .option("-d, --dir <dir>", "directory to snapshot as head", ".")
  .action(async (opts) => {
    const ctx = makeContext(NET);
    const s = loadState(opts.dir);
    const { manifestBlob } = await uploadSnapshot(opts.dir, s.name, s.branch, s.currentManifestBlob);
    // For the MVP the diff manifest is the same head manifest; a richer diff
    // report can be uploaded separately later.
    const res = await openPrAsAgent(ctx, {
      repoId: s.repoId,
      reputationId: s.reputationId,
      agentCapId: opts.cap,
      headSnapshot: manifestBlob,
      diffManifest: manifestBlob,
      title: opts.title,
    });
    const prId = createdOfType(res, "::pull_request::PullRequest")[0];
    console.log(`✓ PR opened: ${prId}`);
    console.log(`  head: ${blobUrl(manifestBlob)}`);
    console.log(`  tx:   ${res.digest}`);
  });

program
  .command("review")
  .description("Submit a review (with a Walrus test/CI report) as an agent")
  .requiredOption("--cap <agentCapId>", "AgentCap object id")
  .requiredOption("--pr <prId>", "PullRequest object id")
  .requiredOption("--report <file>", "path to a test/CI report file")
  .option("--verdict <n>", "1=approve 2=request-changes 3=comment", "1")
  .option("-d, --dir <dir>", "repo dir", ".")
  .action(async (opts) => {
    const ctx = makeContext(NET);
    const s = loadState(opts.dir);
    const report = readFileSync(opts.report);
    const reportBlob = await storeBlobAuto(new Uint8Array(report));
    const res = await submitReviewAsAgent(ctx, {
      repoId: s.repoId,
      reputationId: s.reputationId,
      prId: opts.pr,
      agentCapId: opts.cap,
      verdict: Number(opts.verdict),
      reportBlob: reportBlob.blobId,
    });
    console.log(`✓ review submitted`);
    console.log(`  report: ${blobUrl(reportBlob.blobId)}`);
    console.log(`  tx:     ${res.digest}`);
  });

program
  .command("merge")
  .description("Merge a PR (owner only) — advances the repo ref to the PR head")
  .requiredOption("--pr <prId>", "PullRequest object id")
  .option("-d, --dir <dir>", "repo dir", ".")
  .action(async (opts) => {
    const ctx = makeContext(NET);
    const s = loadState(opts.dir);
    const res = await mergePr(ctx, { repoId: s.repoId, reputationId: s.reputationId, prId: opts.pr, ownerCapId: s.ownerCapId });

    // Sync local ref to the new on-chain current_snapshot so subsequent
    // `release` / `open-pr` use the merged head as their base.
    const obj = await ctx.client.getObject({ id: s.repoId, options: { showContent: true } });
    const snap = (obj.data?.content as any)?.fields?.current_snapshot;
    if (snap) {
      s.currentManifestBlob = snap;
      saveState(opts.dir, s);
    }

    console.log(`✓ PR merged`);
    console.log(`  ref now: ${snap}`);
    console.log(`  tx:      ${res.digest}`);
  });

program
  .command("release")
  .description("Publish a release with source + artifact + test report (owner only)")
  .requiredOption("--tag <v>", "version tag, e.g. v0.1.0")
  .requiredOption("--artifact <file>", "build artifact file")
  .requiredOption("--report <file>", "test report file")
  .option("--pr <id>", "merged PR id to hard-link into the release (preferred v2 path)")
  .option("-d, --dir <dir>", "repo dir", ".")
  .action(async (opts) => {
    const ctx = makeContext(NET);
    const s = loadState(opts.dir);

    const artifactBlob = await storeBlobAuto(new Uint8Array(readFileSync(opts.artifact)));
    const reportBlob = await storeBlobAuto(new Uint8Array(readFileSync(opts.report)));

    const res = await publishRelease(ctx, {
      repoId: s.repoId,
      ownerCapId: s.ownerCapId,
      version: opts.tag,
      sourceSnapshot: s.currentManifestBlob,
      buildArtifact: artifactBlob.blobId,
      testReport: reportBlob.blobId,
      mergedPrId: opts.pr,
    });
    const releaseId = createdOfType(res, "::release::Release")[0];
    console.log(`✓ release ${opts.tag} published: ${releaseId}`);
    if (opts.pr) console.log(`  merged PR: ${opts.pr}`);
    console.log(`  source:   ${blobUrl(s.currentManifestBlob)}`);
    console.log(`  artifact: ${blobUrl(artifactBlob.blobId)}`);
    console.log(`  report:   ${blobUrl(reportBlob.blobId)}`);
    console.log(`  tx:       ${res.digest}`);
  });

program
  .command("set-approvals")
  .description("Set the minimum APPROVE reviews required before a PR can merge (owner only)")
  .requiredOption("--n <count>", "minimum approvals (0 disables)")
  .option("-d, --dir <dir>", "repo dir", ".")
  .action(async (opts) => {
    const ctx = makeContext(NET);
    const s = loadState(opts.dir);
    const res = await setMinApprovals(ctx, { repoId: s.repoId, ownerCapId: s.ownerCapId, n: Number(opts.n) });
    console.log(`✓ min_approvals set to ${opts.n}`);
    console.log(`  tx: ${res.digest}`);
  });

program
  .command("renew")
  .description("Re-pin a published app's Walrus blobs for more epochs (so it doesn't expire)")
  .requiredOption("--app <id>", "PublishedApp object id")
  .option("--epochs <n>", "storage epochs", "30")
  .action(async (opts: { app: string; epochs: string }) => {
    const ctx = makeContext(NET);
    const obj = await ctx.client.getObject({ id: opts.app, options: { showContent: true } });
    const f: any = (obj.data?.content as any)?.fields ?? {};
    const epochs = Number(opts.epochs) || 30;
    const targets: [string, string | undefined][] = [["archive", f.archive_blob], ["manifest", f.manifest_blob]];
    if (!targets.some(([, id]) => id)) throw new Error("Not a PublishedApp (no archive_blob/manifest_blob).");
    for (const [label, id] of targets) {
      if (!id) continue;
      const r = await renewBlob(id, epochs);
      console.log(`  renewed ${label} ${id.slice(0, 12)}… (epochs=${epochs}, ${r.alreadyCertified ? "already-certified" : "re-stored"})`);
    }
    console.log("✓ renew complete");
  });

program
  .command("doctor")
  .description("Health check: wallet, RPC, package/registry, latest on-chain activity")
  .action(async () => {
    const ctx = makeContext(NET);
    const pkg = ctx.deployment.packageId;
    const ok = (b: boolean) => (b ? "✓" : "✗");
    console.log(`\nSignet doctor — ${ctx.deployment.chainId ?? "testnet"}\n`);
    // wallet
    let bal = 0n;
    try { bal = BigInt((await ctx.client.getBalance({ owner: ctx.address })).totalBalance); } catch {}
    const balSui = Number(bal) / 1e9;
    console.log(`  [${ok(true)}] signer        ${ctx.address}`);
    console.log(`  [${ok(balSui > 0.02)}] gas           ${balSui.toFixed(3)} SUI${balSui <= 0.02 ? "   → fix: faucet https://faucet.sui.io or `sui client faucet`" : ""}`);
    // rpc + package
    let pkgOk = false;
    try { const o = await ctx.client.getObject({ id: pkg, options: { showType: true } }); pkgOk = !!o.data; } catch {}
    console.log(`  [${ok(pkgOk)}] package       ${pkg}${pkgOk ? "" : "   → fix: check deployments.json / network"}`);
    const mvr = (ctx.deployment as any).mvrName;
    if (mvr) console.log(`  [·] mvr alias     ${mvr}   (register via SuiNS to activate; raw id works today)`);
    let regOk = false;
    try { const o = await ctx.client.getObject({ id: ctx.deployment.forgeRegistry, options: { showContent: true } }); regOk = !!o.data; } catch {}
    console.log(`  [${ok(regOk)}] registry      ${ctx.deployment.forgeRegistry}`);
    // latest activity across modules
    let total = 0; let latest = 0;
    for (const m of ["forge", "pull_request", "issue", "bounty", "release", "reputation"]) {
      try {
        const ev = await ctx.client.queryEvents({ query: { MoveModule: { package: pkg, module: m } }, limit: 50, order: "descending" });
        total += ev.data.length;
        const t = Number(ev.data[0]?.timestampMs ?? 0);
        if (t > latest) latest = t;
      } catch {}
    }
    console.log(`  [${ok(total > 0)}] activity      ${total} events indexed${latest ? ` · latest ${new Date(latest).toISOString()}` : ""}`);
    console.log(`\n${pkgOk && regOk && balSui > 0.02 ? "✓ healthy" : "⚠ see fixes above"}\n`);
  });

program
  .command("vouch")
  .description("Vouch for another agent, raising their trust score (needs your score ≥ 10)")
  .requiredOption("--subject <address>", "the agent you are vouching for")
  .option("-d, --dir <dir>", "repo dir", ".")
  .action(async (opts) => {
    const ctx = makeContext(NET);
    const s = loadState(opts.dir);
    const reputationId = await findReputationLedger(s.repoId);
    if (!reputationId) throw new Error("Reputation ledger not found for repo");
    const res = await vouch(ctx, { reputationId, subject: opts.subject });
    console.log(`✓ vouched for ${opts.subject}`);
    console.log(`  tx: ${res.digest}`);
  });

program
  .command("verify")
  .description("Independently verify a release's provenance chain (read-only, no key)")
  .requiredOption("--release <releaseId>", "Release object id to verify")
  .action(async (opts) => {
    const { verifyRelease } = await import("../lib/actions.js");
    const r = await verifyRelease(opts.release);
    console.log(`\nSignet — verify ${r.version ?? "release"}  (${opts.release})\n`);
    for (const s of r.steps) {
      console.log(`  [${s.ok ? "✓" : "✗"}] ${s.label}`);
      console.log(`        ${s.detail}`);
    }
    console.log(`\n  level: ${r.levelLabel}`);
    console.log(r.pass ? `\n✓ PASS — provenance chain verified\n` : `\n✗ FAIL — provenance chain incomplete\n`);
    if (!r.pass) process.exit(2);
  });

program
  .command("attestation")
  .description("Export an in-toto/SLSA-style JSON statement for a Signet release")
  .requiredOption("--release <releaseId>", "Release object id to export")
  .option("--out <file>", "write JSON to a file instead of stdout")
  .action(async (opts) => {
    const { releaseAttestation } = await import("../lib/actions.js");
    const att = await releaseAttestation({ releaseId: opts.release });
    const json = JSON.stringify(att, null, 2);
    if (opts.out) {
      writeFileSync(opts.out, json + "\n");
      console.log(`attestation written: ${opts.out}`);
    } else {
      console.log(json);
    }
  });

program
  .command("latest-release")
  .description("Print the most recent release id on the active network (for CI/verify)")
  .action(async () => {
    const { latestReleaseId } = await import("../lib/forge-read.js");
    const id = await latestReleaseId();
    if (!id) {
      console.error(`no releases found on ${NET}`);
      process.exit(1);
    }
    // Print only the id to stdout so CI can capture it directly.
    console.log(id);
  });

program
  .command("status")
  .description("Show on-chain repo state")
  .option("-d, --dir <dir>", "repo dir", ".")
  .action(async (opts) => {
    const ctx = makeContext(NET);
    const s = loadState(opts.dir);
    const obj = await ctx.client.getObject({ id: s.repoId, options: { showContent: true } });
    const fields = (obj.data?.content as any)?.fields ?? {};
    console.log(`repo:             ${s.name} (${s.repoId})`);
    console.log(`owner:            ${fields.owner}`);
    console.log(`default_branch:   ${fields.default_branch}`);
    console.log(`current_snapshot: ${fields.current_snapshot}`);
    console.log(`ref_version:      ${fields.ref_version}`);
    console.log(`latest_release:   ${JSON.stringify(fields.latest_release)}`);
  });

program
  .command("post-bounty-v2")
  .description("Post a bounty with terms (deadline + proof requirement)")
  .requiredOption("-t, --title <title>", "bounty title")
  .requiredOption("-a, --amount <mist>", "escrow amount in MIST")
  .option("-d, --dir <dir>", "repo dir", ".")
  .option("--min-score <n>", "minimum agent score to claim", "0")
  .option("--deadline <ms>", "absolute Unix-ms deadline (0 = none)", "0")
  .option("--proof", "require a proof submission before payout", false)
  .action(async (opts) => {
    const ctx = makeContext(NET);
    const s = loadState(opts.dir);
    const res = await postBountyV2(ctx, {
      repoId: s.repoId,
      title: opts.title,
      amountMist: Number(opts.amount),
      minScore: Number(opts.minScore),
      deadlineMs: Number(opts.deadline),
      proofRequired: !!opts.proof,
    });
    const bountyId = createdOfType(res, "::bounty::Bounty")[0];
    const termsId = createdOfType(res, "::bounty::BountyTerms")[0];
    console.log(`✓ bounty posted\n  bounty: ${bountyId}\n  terms:  ${termsId}\n  tx:     ${res.digest}`);
  });

program
  .command("claim-bounty")
  .description("Claim an open bounty (commit to delivering the work)")
  .requiredOption("--bounty <id>", "Bounty object id")
  .option("-d, --dir <dir>", "repo dir", ".")
  .action(async (opts) => {
    const ctx = makeContext(NET);
    const s = loadState(opts.dir);
    const res = await claimBounty(ctx, { bountyId: opts.bounty, reputationId: s.reputationId });
    console.log(`✓ bounty claimed\n  tx: ${res.digest}`);
  });

program
  .command("open-dispute")
  .description("Open a dispute on a CLAIMED bounty (funder or claimant)")
  .requiredOption("--bounty <id>", "Bounty object id")
  .option("--reason <text>", "reason / evidence", "disputed")
  .action(async (opts) => {
    const ctx = makeContext(NET);
    const res = await openDispute(ctx, { bountyId: opts.bounty, reason: opts.reason });
    const disputeId = createdOfType(res, "::bounty::BountyDispute")[0];
    console.log(`✓ dispute opened\n  dispute: ${disputeId}\n  tx:      ${res.digest}`);
  });

program
  .command("resolve-dispute")
  .description("Arbitrate a dispute (repo owner): split escrow, fee -> treasury")
  .requiredOption("--bounty <id>", "Bounty object id")
  .requiredOption("--dispute <id>", "BountyDispute object id")
  .requiredOption("--bps <0-10000>", "share of escrow to the claimant (basis points)")
  .option("-d, --dir <dir>", "repo dir", ".")
  .action(async (opts) => {
    const ctx = makeContext(NET);
    const s = loadState(opts.dir);
    const res = await resolveDispute(ctx, {
      bountyId: opts.bounty,
      disputeId: opts.dispute,
      repoId: s.repoId,
      ownerCapId: s.ownerCapId,
      payoutBps: Number(opts.bps),
    });
    console.log(`✓ dispute resolved\n  tx: ${res.digest}`);
  });

program
  .command("cancel-expired")
  .description("Reclaim a CLAIMED bounty past its deadline (funder only)")
  .requiredOption("--bounty <id>", "Bounty object id")
  .requiredOption("--terms <id>", "BountyTerms object id")
  .action(async (opts) => {
    const ctx = makeContext(NET);
    const res = await cancelExpired(ctx, { bountyId: opts.bounty, termsId: opts.terms });
    console.log(`✓ bounty reclaimed (expired)\n  tx: ${res.digest}`);
  });

program
  .command("prove-file")
  .description("Prove a single file is included in a release (Merkle inclusion proof) — no full download")
  .requiredOption("--release <id>", "Release object id")
  .requiredOption("--path <p>", "file path inside the snapshot (e.g. sources/a.move)")
  .action(async (opts) => {
    const rel = await getRelease(opts.release);
    if (!rel) { console.error(`release not found: ${opts.release}`); process.exit(1); }
    const manifest = await fetchManifest(rel.sourceSnapshot);
    if (!manifest) { console.error("source manifest unavailable on Walrus"); process.exit(1); }
    if (!manifest.merkleRoot) { console.error("this release's manifest predates Merkle roots (re-publish to enable per-file proofs)"); process.exit(1); }
    const proof = merkleProof(manifest, opts.path);
    if (!proof) { console.error(`file not in release: ${opts.path}`); process.exit(1); }
    const ok = verifyMerkleProof(proof, manifest.merkleRoot);
    console.log(`file:        ${proof.path}`);
    console.log(`sha256:      ${proof.sha256}`);
    console.log(`merkle root: ${proof.root}`);
    console.log(`proof depth: ${proof.siblings.length} sibling hash(es)`);
    console.log(ok ? `\n✓ included in release ${opts.release}` : `\n✗ NOT included — proof failed`);
    if (!ok) process.exit(2);
  });

program.parseAsync(process.argv).catch((e) => {
  console.error(`\n✗ ${e.message}`);
  process.exit(1);
});
