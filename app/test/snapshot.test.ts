// Unit tests for the deterministic snapshot/manifest core (the verifiable integrity
// layer). Pure functions, no network. Run: `npm test` (node --import tsx --test).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildSnapshotFromMemory,
  parseManifest,
  verifyTreeHash,
  extractArchive,
  sha256,
} from "../src/lib/snapshot.ts";

const files = [
  { path: "b.txt", content: "beta" },
  { path: "a/x.txt", content: "alpha" },
  { path: "index.html", content: "<h1>hi</h1>" },
];
const opts = { name: "demo", branch: "main", previousSnapshot: null, nowEpochMs: 1_700_000_000_000 };

test("buildSnapshotFromMemory is deterministic and input-order-independent", () => {
  const a = buildSnapshotFromMemory({ ...opts, files });
  const b = buildSnapshotFromMemory({ ...opts, files: [...files].reverse() });
  assert.equal(a.manifest.treeHash, b.manifest.treeHash);
  assert.deepEqual([...a.archive], [...b.archive]); // byte-identical regardless of order
});

test("manifest files are path-sorted with correct sha256/size and a valid treeHash", () => {
  const { manifest } = buildSnapshotFromMemory({ ...opts, files });
  assert.deepEqual(manifest.files.map((f) => f.path), ["a/x.txt", "b.txt", "index.html"]);
  const beta = manifest.files.find((f) => f.path === "b.txt")!;
  assert.equal(beta.sha256, sha256(new TextEncoder().encode("beta")));
  assert.equal(beta.size, 4);
  assert.ok(verifyTreeHash(manifest));
});

test("verifyTreeHash detects tampering", () => {
  const { manifest } = buildSnapshotFromMemory({ ...opts, files });
  manifest.files[0].sha256 = "deadbeef";
  assert.equal(verifyTreeHash(manifest), false);
});

test("treeHash changes when content changes", () => {
  const a = buildSnapshotFromMemory({ ...opts, files });
  const b = buildSnapshotFromMemory({
    ...opts,
    files: [{ path: "b.txt", content: "BETA" }, files[1], files[2]],
  });
  assert.notEqual(a.manifest.treeHash, b.manifest.treeHash);
});

test("extractArchive round-trips the archive back to path -> bytes", () => {
  const { archive } = buildSnapshotFromMemory({ ...opts, files });
  const out = extractArchive(archive);
  assert.equal(out.size, 3);
  assert.equal(new TextDecoder().decode(out.get("a/x.txt")), "alpha");
  assert.equal(new TextDecoder().decode(out.get("index.html")), "<h1>hi</h1>");
});

test("parseManifest accepts a valid manifest and rejects an invalid one", () => {
  const { manifest } = buildSnapshotFromMemory({ ...opts, files });
  const round = parseManifest(JSON.stringify(manifest));
  assert.equal(round.treeHash, manifest.treeHash);
  assert.throws(() => parseManifest('{"name":"x"}'));
});
