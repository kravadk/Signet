#!/usr/bin/env -S npx tsx
/**
 * WalrusForge CI worker.
 *
 * Acts as a dedicated CI *agent* identity (FORGE_CI_KEY) holding an AgentCap with
 * the review scope. Given a PR, it:
 *   1. fetches the PR's head snapshot manifest from Walrus,
 *   2. downloads + extracts the snapshot archive into a temp dir,
 *   3. runs `sui move test` if the snapshot is a Move package,
 *   4. uploads the real test report to Walrus,
 *   5. submits a signed review on-chain (verdict from the test result).
 *
 * This closes the chain automatically: the CI report in a release's provenance
 * is produced by a real test run, not typed by a human.
 *
 * Usage: FORGE_CI_KEY=suiprivkey1... npx tsx src/ci/worker.ts \
 *          --repo 0x.. --pr 0x.. --cap 0x..
 */

import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";

import { storeBlobAuto, readBlob, readBlobText, blobUrl } from "../lib/walrus.js";
import { extractArchive, parseManifest, verifyTreeHash, sha256 } from "../lib/snapshot.js";
import { makeContextWithKeypair, submitReviewAsAgent } from "../lib/sui.js";
import { getPullRequest, findReputationLedger } from "../lib/forge-read.js";
import { requireCiKey } from "./keypair.js";

const VERDICT_APPROVE = 1;
const VERDICT_REQUEST_CHANGES = 2;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function findSuiBin(): string {
  // Prefer the local install used elsewhere in the project.
  const home = process.env.USERPROFILE || process.env.HOME || "";
  return join(home, ".sui-cli", process.platform === "win32" ? "sui.exe" : "sui");
}

/** Run `sui move test` in `dir`; return {passed, output}. */
function runMoveTest(dir: string): { passed: boolean; output: string } {
  const sui = findSuiBin();
  try {
    const out = execFileSync(sui, ["move", "test"], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 180_000,
    });
    return { passed: /Test result: OK/.test(out) || /test result: ok/i.test(out), output: out };
  } catch (e: any) {
    const output = `${e.stdout ?? ""}\n${e.stderr ?? ""}`.trim() || String(e.message ?? e);
    return { passed: false, output };
  }
}

async function main() {
  const repoId = arg("repo");
  const prId = arg("pr");
  const capId = arg("cap");
  if (!repoId || !prId || !capId) {
    console.error("usage: worker.ts --repo <id> --pr <id> --cap <agentCapId>");
    process.exit(2);
  }

  const ctx = makeContextWithKeypair(requireCiKey());
  console.log(`CI agent: ${ctx.address}`);

  // 1. Load the PR + its head manifest.
  const pr = await getPullRequest(prId);
  if (!pr) throw new Error(`PR not found: ${prId}`);
  console.log(`PR "${pr.title}" head=${pr.headSnapshot}`);

  const manifestText = await readBlobText(pr.headSnapshot);
  const manifest = parseManifest(manifestText) as any;
  const archiveBlob: string | undefined = manifest.archiveBlob;
  if (!archiveBlob) throw new Error("Manifest has no archiveBlob — cannot fetch sources.");

  // 2. Download + extract the snapshot archive into a temp dir.
  const work = mkdtempSync(join(tmpdir(), "wf-ci-"));
  try {
    const archive = await readBlob(archiveBlob);
    const files = extractArchive(archive);
    for (const [rel, bytes] of files) {
      const full = join(work, rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, bytes);
    }
    console.log(`extracted ${files.size} files to ${work}`);

    // 3. Run the test if it's a Move package (has Move.toml).
    const isMove = [...files.keys()].some((p) => p.endsWith("Move.toml"));
    let report: string;
    let passed: boolean;
    if (isMove) {
      const r = runMoveTest(work);
      passed = r.passed;
      report = [
        "WalrusForge CI report",
        `repo: ${repoId}`,
        `pr: ${prId}`,
        `runner: ${ctx.address}`,
        `command: sui move test`,
        `result: ${passed ? "PASS" : "FAIL"}`,
        "",
        "--- output ---",
        r.output.slice(0, 4000),
      ].join("\n");
    } else {
      // Non-Move snapshot: run a REAL integrity check. Recompute the sha256 of
      // every extracted file and compare it to the manifest, and re-derive the
      // manifest treeHash. passed is the actual result — never hardcoded — so a
      // tampered snapshot produces an on-chain REQUEST_CHANGES, not a fake PASS.
      const mismatches: string[] = [];
      for (const entry of manifest.files) {
        const bytes = files.get(entry.path);
        if (!bytes) { mismatches.push(`${entry.path}: missing in archive`); continue; }
        const got = sha256(bytes);
        if (got !== entry.sha256) {
          mismatches.push(`${entry.path}: sha256 ${got.slice(0, 12)}… ≠ manifest ${String(entry.sha256).slice(0, 12)}…`);
        }
      }
      const treeOk = verifyTreeHash(manifest);
      if (!treeOk) mismatches.push(`treeHash mismatch (manifest ${manifest.treeHash.slice(0, 12)}…)`);
      passed = mismatches.length === 0;
      report = [
        "WalrusForge CI report",
        `repo: ${repoId}`,
        `pr: ${prId}`,
        `runner: ${ctx.address}`,
        `command: integrity-check (no Move.toml found)`,
        `result: ${passed ? "PASS" : "FAIL"} — verified ${manifest.files.length} file hash(es) + treeHash`,
        `files: ${files.size}`,
        ...(mismatches.length ? ["", "--- mismatches ---", ...mismatches.slice(0, 50)] : []),
      ].join("\n");
    }

    // 4. Upload the report to Walrus (active-network aware — mainnet uses CLI).
    const reportBlob = await storeBlobAuto(report);
    console.log(`report uploaded: ${blobUrl(reportBlob.blobId)} (passed=${passed})`);

    // 5. Submit the review on-chain (CI agent signs).
    const reputationId = await findReputationLedger(repoId);
    if (!reputationId) throw new Error("Reputation ledger not found for repo");
    const res = await submitReviewAsAgent(ctx, {
      repoId,
      reputationId,
      prId,
      agentCapId: capId,
      verdict: passed ? VERDICT_APPROVE : VERDICT_REQUEST_CHANGES,
      reportBlob: reportBlob.blobId,
    });
    console.log(`✓ CI review submitted (${passed ? "approve" : "request-changes"})`);
    console.log(`  report: ${blobUrl(reportBlob.blobId)}`);
    console.log(`  tx:     ${res.digest}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(`\n✗ CI worker failed: ${e.message ?? e}`);
  process.exit(1);
});
