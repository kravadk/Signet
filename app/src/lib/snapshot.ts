/**
 * Snapshot + manifest helpers for Signet.
 *
 * A "snapshot" is a deterministic, gzipped archive of a repo directory plus a
 * `manifest.json` describing the file tree and content hashes. Both the archive
 * and the manifest are stored in Walrus; the manifest blob id is what we anchor
 * on-chain as the repo's current ref / a PR's head.
 *
 * The archive format is intentionally simple and dependency-free: a length-
 * prefixed concatenation of (path, bytes) entries, sorted by path for
 * determinism, then gzipped. This keeps demos fast and reproducible.
 */

import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

export interface FileEntry {
  path: string; // POSIX-style relative path
  sha256: string;
  size: number;
}

export interface Manifest {
  name: string;
  branch: string;
  /** Unix epoch milliseconds — deterministic integer, not a locale string. */
  createdAtEpochMs: number;
  /** Walrus blob id of the previous snapshot manifest, or null for the first. */
  previousSnapshot: string | null;
  files: FileEntry[];
  /** Hash over the sorted (path, sha256) pairs — identifies the whole tree. */
  treeHash: string;
  /**
   * Merkle root over the per-file leaves (sha256("path:sha256")). Lets anyone
   * prove a single file belongs to this snapshot with a O(log n) proof — without
   * fetching the whole archive. Optional: snapshots built before this field lack it.
   */
  merkleRoot?: string;
}

const IGNORE = new Set([
  ".git",
  ".forge", // local CLI state — never part of the snapshot
  "node_modules",
  "build",
  ".sui",
  "target",
  ".DS_Store",
]);

function walk(dir: string, root: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (IGNORE.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, root, out);
    else if (st.isFile()) out.push(full);
  }
}

function toPosix(p: string): string {
  return p.split(sep).join("/");
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Build a deterministic archive + manifest for `repoDir`. `nowEpochMs` is passed
 * in (not read from the clock here) so callers control timestamp determinism in
 * tests.
 */
export function buildSnapshot(args: {
  repoDir: string;
  name: string;
  branch: string;
  previousSnapshot: string | null;
  nowEpochMs: number;
}): { archive: Uint8Array; manifest: Manifest } {
  const paths: string[] = [];
  walk(args.repoDir, args.repoDir, paths);

  const files = paths.map((full) => ({
    path: toPosix(relative(args.repoDir, full)),
    content: new Uint8Array(readFileSync(full)),
  }));

  return buildSnapshotFromMemory({ ...args, files });
}

/**
 * Build a deterministic archive + manifest from in-memory files (not the
 * filesystem). Used by the MCP server, where an agent passes proposed file
 * contents inline. Produces byte-for-byte the same output as `buildSnapshot`
 * for the same logical file set.
 */
export function buildSnapshotFromMemory(args: {
  files: { path: string; content: Uint8Array | string }[];
  name: string;
  branch: string;
  previousSnapshot: string | null;
  nowEpochMs: number;
}): { archive: Uint8Array; manifest: Manifest } {
  const normalized = args.files
    .map((f) => ({
      path: toPosix(f.path),
      bytes:
        typeof f.content === "string"
          ? new TextEncoder().encode(f.content)
          : f.content,
    }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const entries: FileEntry[] = [];
  const chunks: Uint8Array[] = [];

  for (const { path, bytes } of normalized) {
    entries.push({ path, sha256: sha256(bytes), size: bytes.length });

    // Length-prefixed archive entry: [pathLen u32][path][dataLen u32][data]
    const pathBytes = new TextEncoder().encode(path);
    const header = new Uint8Array(8);
    const dv = new DataView(header.buffer);
    dv.setUint32(0, pathBytes.length, false);
    dv.setUint32(4, bytes.length, false);
    chunks.push(header, pathBytes, bytes);
  }

  const flat = concat(chunks);
  const archive = new Uint8Array(gzipSync(flat));

  const treeHash = sha256(
    new TextEncoder().encode(entries.map((e) => `${e.path}:${e.sha256}`).join("\n")),
  );
  const merkleRoot = computeMerkleRoot(entries.map(fileLeaf));

  const manifest: Manifest = {
    name: args.name,
    branch: args.branch,
    createdAtEpochMs: args.nowEpochMs,
    previousSnapshot: args.previousSnapshot,
    files: entries,
    treeHash,
    merkleRoot,
  };

  return { archive, manifest };
}

/** Parse and lightly validate a manifest JSON string. */
export function parseManifest(json: string): Manifest {
  const m = JSON.parse(json) as Manifest;
  if (!m.name || !Array.isArray(m.files) || !m.treeHash) {
    throw new Error("Invalid manifest: missing required fields");
  }
  return m;
}

/** Recompute the tree hash from a manifest's file list (integrity check). */
export function verifyTreeHash(m: Manifest): boolean {
  const recomputed = sha256(
    new TextEncoder().encode(m.files.map((e) => `${e.path}:${e.sha256}`).join("\n")),
  );
  return recomputed === m.treeHash;
}

// ===== Merkle inclusion proofs =====
//
// Leaf = sha256("path:sha256"); parent = sha256(left || right) over the hex
// strings; odd nodes duplicate the last. A proof lets anyone verify a single
// file belongs to a snapshot against `manifest.merkleRoot` without the archive.

function sha256hex(s: string): string {
  return createHash("sha256").update(new TextEncoder().encode(s)).digest("hex");
}
/** The Merkle leaf for a file entry. */
export function fileLeaf(e: { path: string; sha256: string }): string {
  return sha256hex(`${e.path}:${e.sha256}`);
}
/** Compute the Merkle root over an ordered list of leaf hashes (hex). */
export function computeMerkleRoot(leaves: string[]): string {
  if (leaves.length === 0) return sha256hex("");
  let level = leaves.slice();
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = i + 1 < level.length ? level[i + 1] : left; // duplicate odd
      next.push(sha256hex(left + right));
    }
    level = next;
  }
  return level[0];
}

export interface MerkleProof {
  path: string;
  sha256: string;
  leaf: string;
  index: number;
  /** Bottom-up sibling hashes; `left` = sibling sits on the left of the pair. */
  siblings: { hash: string; left: boolean }[];
  root: string;
}

/** Build an inclusion proof for `filePath` against a manifest's file list. */
export function merkleProof(m: Manifest, filePath: string): MerkleProof | null {
  const target = toPosix(filePath);
  const idx = m.files.findIndex((e) => e.path === target);
  if (idx < 0) return null;
  let level = m.files.map(fileLeaf);
  const leaf = level[idx];
  const siblings: { hash: string; left: boolean }[] = [];
  let i = idx;
  while (level.length > 1) {
    const isRight = i % 2 === 1;
    const sibIdx = isRight ? i - 1 : i + 1;
    const sib = sibIdx < level.length ? level[sibIdx] : level[i]; // duplicated odd
    siblings.push({ hash: sib, left: isRight });
    const next: string[] = [];
    for (let k = 0; k < level.length; k += 2) {
      const left = level[k];
      const right = k + 1 < level.length ? level[k + 1] : left;
      next.push(sha256hex(left + right));
    }
    level = next;
    i = Math.floor(i / 2);
  }
  return { path: target, sha256: m.files[idx].sha256, leaf, index: idx, siblings, root: level[0] };
}

/** Verify an inclusion proof folds up to `expectedRoot`. */
export function verifyMerkleProof(proof: MerkleProof, expectedRoot: string): boolean {
  // The leaf must match the claimed file (path:sha256), then fold to the root.
  if (proof.leaf !== fileLeaf({ path: proof.path, sha256: proof.sha256 })) return false;
  let h = proof.leaf;
  for (const s of proof.siblings) h = s.left ? sha256hex(s.hash + h) : sha256hex(h + s.hash);
  return h === proof.root && proof.root === expectedRoot;
}

/** Inflate an archive produced by buildSnapshot back into path -> bytes. */
export function extractArchive(archive: Uint8Array): Map<string, Uint8Array> {
  const flat = new Uint8Array(gunzipSync(archive));
  const dv = new DataView(flat.buffer, flat.byteOffset, flat.byteLength);
  const out = new Map<string, Uint8Array>();
  let off = 0;
  while (off < flat.length) {
    const pathLen = dv.getUint32(off, false);
    off += 4;
    const dataLen = dv.getUint32(off, false);
    off += 4;
    const path = new TextDecoder().decode(flat.subarray(off, off + pathLen));
    off += pathLen;
    const data = flat.subarray(off, off + dataLen);
    off += dataLen;
    out.set(path, data);
  }
  return out;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}
