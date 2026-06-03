#!/usr/bin/env node
/**
 * Emit GitHub Actions outputs + step summary for a Signet release check.
 *
 * Run after `forge release` and `forge verify`. The job itself is the visible
 * GitHub Check; this script writes the check payload that reviewers need:
 * tree hash, release id, PR id, verification level, and reverify anchors.
 */

import { appendFileSync } from "node:fs";

import { verifyRelease } from "../src/lib/actions.ts";
import { fetchManifest, getRelease } from "../src/lib/forge-read.ts";

function arg(name, fallback = "") {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

function writeOutput(key, value) {
  if (!process.env.GITHUB_OUTPUT) return;
  const v = value == null ? "" : String(value).replace(/\r?\n/g, " ");
  appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${v}\n`);
}

function mdEscape(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

const releaseId = arg("--release", process.env.SIGNET_RELEASE_ID ?? "");
if (!releaseId) {
  console.error("usage: node --import tsx scripts/github-signet-check.mjs --release <releaseId> [--pr <mergedPrId>]");
  process.exit(1);
}

const requestedPrId = arg("--pr", process.env.SIGNET_MERGED_PR_ID ?? "");
const network = arg("--network", process.env.FORGE_NETWORK ?? "testnet");
const uploadedSnapshot = arg("--snapshot", process.env.SIGNET_SNAPSHOT_BLOB ?? "");

const [verify, rel] = await Promise.all([
  verifyRelease(releaseId),
  getRelease(releaseId),
]);
const manifest = rel ? await fetchManifest(rel.sourceSnapshot) : null;
const prId = rel?.mergedPrId ?? requestedPrId;

const anchors = {
  network,
  releaseId,
  repoId: verify.repoId ?? rel?.repoId ?? "",
  mergedPrId: prId ?? "",
  sourceSnapshot: rel?.sourceSnapshot ?? "",
  uploadedSnapshot,
  buildArtifact: rel?.buildArtifact ?? "",
  testReport: rel?.testReport ?? "",
  treeHash: manifest?.treeHash ?? "",
  verificationLevel: verify.levelLabel,
  pass: verify.pass,
};

for (const [key, value] of Object.entries(anchors)) writeOutput(key, value);
writeOutput("verification_level", verify.levelLabel);
writeOutput("verification_pass", verify.pass ? "true" : "false");
writeOutput("tree_hash", anchors.treeHash);
writeOutput("release_id", anchors.releaseId);
writeOutput("pr_id", anchors.mergedPrId);

const rows = [
  ["Network", anchors.network],
  ["Release id", anchors.releaseId],
  ["PR id", anchors.mergedPrId || "legacy fallback"],
  ["Tree hash", anchors.treeHash || "manifest unavailable"],
  ["Verification", anchors.verificationLevel],
  ["Source blob", anchors.sourceSnapshot],
  ["Uploaded CI snapshot", anchors.uploadedSnapshot || "not captured"],
  ["Artifact blob", anchors.buildArtifact],
  ["Report blob", anchors.testReport],
];

const stepRows = verify.steps.map((s) => `| ${s.ok ? "PASS" : "FAIL"} | ${mdEscape(s.label)} | ${mdEscape(s.detail)} |`).join("\n");
const summary = [
  "## Signet Provenance Check",
  "",
  "| Field | Value |",
  "|---|---|",
  ...rows.map(([k, v]) => `| ${mdEscape(k)} | ${mdEscape(v)} |`),
  "",
  "| Result | Step | Detail |",
  "|---|---|---|",
  stepRows,
  "",
  "Reverify with:",
  "",
  "```sh",
  `FORGE_NETWORK=${network} npm --prefix app run forge -- verify --release ${releaseId}`,
  "```",
  "",
].join("\n");

if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
console.log(JSON.stringify(anchors, null, 2));

if (!verify.pass) process.exit(2);
