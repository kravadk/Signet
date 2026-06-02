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

  const manifest: Manifest = {
    name: args.name,
    branch: args.branch,
    createdAtEpochMs: args.nowEpochMs,
    previousSnapshot: args.previousSnapshot,
    files: entries,
    treeHash,
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
