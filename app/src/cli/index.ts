#!/usr/bin/env -S npx tsx
/**
 * WalrusForge CLI.
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

import { storeBlob, blobUrl } from "../lib/walrus.js";
import { buildSnapshot } from "../lib/snapshot.js";
import {
  makeContext,
  createRepo,
  grantAgentCap,
  revokeAgentCap,
  openPrAsAgent,
  submitReviewAsAgent,
  mergePr,
  publishRelease,
  createdOfType,
  SCOPE_OPEN_PR,
  SCOPE_REVIEW,
} from "../lib/sui.js";

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
  const archiveBlob = await storeBlob(archive);
  // Embed the archive blob id into the manifest so it's self-describing.
  const manifestWithArchive = { ...manifest, archiveBlob: archiveBlob.blobId };
  const manifestBlob = await storeBlob(JSON.stringify(manifestWithArchive));
  return { archiveBlob: archiveBlob.blobId, manifestBlob: manifestBlob.blobId, manifest };
}

const program = new Command();
program.name("forge").description("WalrusForge — agent-native release network").version("0.1.0");

program
  .command("init")
  .description("Create a repo: snapshot dir -> Walrus -> on-chain Repository")
  .requiredOption("-n, --name <name>", "repository name (globally unique)")
  .option("-d, --dir <dir>", "directory to snapshot", ".")
  .option("-b, --branch <branch>", "default branch", "main")
  .action(async (opts) => {
    const ctx = makeContext();
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
      network: "testnet",
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
  .description("Grant an AgentCap (open_pr + review) to an address")
  .requiredOption("-r, --recipient <address>", "agent address")
  .option("-d, --dir <dir>", "repo dir", ".")
  .option("--expires <epoch>", "expiry epoch (0 = never)", "0")
  .option("--label <label>", "human label", "agent")
  .action(async (opts) => {
    const ctx = makeContext();
    const s = loadState(opts.dir);
    const res = await grantAgentCap(ctx, {
      repoId: s.repoId,
      ownerCapId: s.ownerCapId,
      recipient: opts.recipient,
      scopes: SCOPE_OPEN_PR | SCOPE_REVIEW,
      expiresAtEpoch: Number(opts.expires),
      label: opts.label,
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
    const ctx = makeContext();
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
    const ctx = makeContext();
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
    const ctx = makeContext();
    const s = loadState(opts.dir);
    const report = readFileSync(opts.report);
    const reportBlob = await storeBlob(new Uint8Array(report));
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
    const ctx = makeContext();
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
  .option("-d, --dir <dir>", "repo dir", ".")
  .action(async (opts) => {
    const ctx = makeContext();
    const s = loadState(opts.dir);

    const artifactBlob = await storeBlob(new Uint8Array(readFileSync(opts.artifact)));
    const reportBlob = await storeBlob(new Uint8Array(readFileSync(opts.report)));

    const res = await publishRelease(ctx, {
      repoId: s.repoId,
      ownerCapId: s.ownerCapId,
      version: opts.tag,
      sourceSnapshot: s.currentManifestBlob,
      buildArtifact: artifactBlob.blobId,
      testReport: reportBlob.blobId,
    });
    const releaseId = createdOfType(res, "::release::Release")[0];
    console.log(`✓ release ${opts.tag} published: ${releaseId}`);
    console.log(`  source:   ${blobUrl(s.currentManifestBlob)}`);
    console.log(`  artifact: ${blobUrl(artifactBlob.blobId)}`);
    console.log(`  report:   ${blobUrl(reportBlob.blobId)}`);
    console.log(`  tx:       ${res.digest}`);
  });

program
  .command("status")
  .description("Show on-chain repo state")
  .option("-d, --dir <dir>", "repo dir", ".")
  .action(async (opts) => {
    const ctx = makeContext();
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

program.parseAsync(process.argv).catch((e) => {
  console.error(`\n✗ ${e.message}`);
  process.exit(1);
});
