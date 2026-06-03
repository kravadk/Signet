/**
 * Walrus HTTP client for Signet.
 *
 * Uses the public Walrus testnet publisher (writes) and aggregator (reads)
 * over plain HTTP — no wallet needed for public testnet services. Blobs are
 * snapshots, diff manifests, review reports and build artifacts; we only ever
 * pass around their `blobId` on-chain.
 *
 * Docs: https://docs.wal.app/docs/http-api/storing-blobs
 */

export const WALRUS_TESTNET = {
  publisher: "https://publisher.walrus-testnet.walrus.space",
  aggregator: "https://aggregator.walrus-testnet.walrus.space",
} as const;

// Mainnet public services. Reads are free from the public aggregator. There is
// NO free public mainnet publisher (writes spend real WAL+SUI, so public ones
// require auth); mainnet blobs are written via the `walrus store` CLI instead.
// The publisher URL here is a best-effort placeholder for the HTTP path and is
// not expected to accept anonymous writes on mainnet.
export const WALRUS_MAINNET = {
  publisher: "https://publisher.walrus-mainnet.walrus.space",
  aggregator: "https://aggregator.walrus-mainnet.walrus.space",
} as const;

export interface WalrusConfig {
  publisher: string;
  aggregator: string;
}

/** Pick the Walrus HTTP config for a Sui network. */
export function walrusConfigFor(network: string): WalrusConfig {
  return network === "mainnet" ? WALRUS_MAINNET : WALRUS_TESTNET;
}

// Active network for module-level read defaults (testnet | mainnet) from
// FORGE_NETWORK env. Keeps reads/URLs aligned with the signing context.
export const ACTIVE_NETWORK = process.env.FORGE_NETWORK === "mainnet" ? "mainnet" : "testnet";
export const ACTIVE_WALRUS = walrusConfigFor(ACTIVE_NETWORK);

/**
 * Store a blob on the active network: HTTP publisher on testnet (free), and the
 * `walrus store` CLI on mainnet (no free public publisher; spends WAL). Use this
 * from network-agnostic write paths (PR/review) so they work on either network.
 */
export async function storeBlobAuto(
  data: Uint8Array | string,
  opts: { epochs?: number } = {},
): Promise<StoredBlob> {
  if (ACTIVE_NETWORK === "mainnet") {
    return storeBlobViaCli(data, { epochs: opts.epochs ?? 5 });
  }
  return storeBlob(data, { epochs: opts.epochs, config: ACTIVE_WALRUS });
}

export interface StoredBlob {
  blobId: string;
  /** Sui object id of the Blob object, when newly created. */
  blobObjectId?: string;
  /** True if Walrus already had a certified blob with this id. */
  alreadyCertified: boolean;
  size?: number;
}

/**
 * Store bytes in Walrus for `epochs` storage epochs. Returns the blob id that
 * downstream on-chain objects reference.
 */
export async function storeBlob(
  data: Uint8Array | string,
  opts: { epochs?: number; config?: WalrusConfig } = {},
): Promise<StoredBlob> {
  // Default to the active network's config (not a hardcoded testnet) so a blob
  // written without an explicit config lands on the same network as the on-chain
  // object that will reference it.
  const cfg = opts.config ?? ACTIVE_WALRUS;
  const epochs = opts.epochs ?? 5;
  const url = `${cfg.publisher}/v1/blobs?epochs=${epochs}`;

  const body = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const res = await fetch(url, {
    method: "PUT",
    body,
    headers: { "content-type": "application/octet-stream" },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Walrus store failed: ${res.status} ${res.statusText} ${text}`);
  }

  const json: any = await res.json();

  if (json.newlyCreated) {
    const obj = json.newlyCreated.blobObject;
    return {
      blobId: obj.blobId,
      blobObjectId: obj.id,
      alreadyCertified: false,
      size: obj.size,
    };
  }
  if (json.alreadyCertified) {
    return { blobId: json.alreadyCertified.blobId, alreadyCertified: true };
  }
  throw new Error(`Unexpected Walrus response: ${JSON.stringify(json).slice(0, 300)}`);
}

/**
 * Store bytes in Walrus via the local `walrus store` CLI, charging the active
 * Sui wallet in WAL+SUI. This is the path for MAINNET, where there is no free
 * public HTTP publisher. Requires the `walrus` binary and a config with the
 * given context (e.g. mainnet). Returns the same shape as `storeBlob`.
 */
export async function storeBlobViaCli(
  data: Uint8Array | string,
  opts: { epochs?: number; bin?: string; config?: string; context?: string } = {},
): Promise<StoredBlob> {
  const { spawn } = await import("node:child_process");
  const os = await import("node:os");
  const fs = await import("node:fs/promises");
  const path = await import("node:path");

  const epochs = opts.epochs ?? 5;
  const bin = opts.bin ?? process.env.WALRUS_BIN ?? "walrus";
  const config = opts.config ?? process.env.WALRUS_CONFIG;
  const context = opts.context ?? "mainnet";

  const body = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const tmp = path.join(os.tmpdir(), `wf-blob-${process.pid}-${body.byteLength}-${epochs}.bin`);
  await fs.writeFile(tmp, body);

  const args: string[] = [];
  if (config) args.push("--config", config);
  args.push("--context", context, "store", tmp, "--epochs", String(epochs), "--json");

  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => (out += d.toString()));
      child.stderr.on("data", (d) => (err += d.toString()));
      child.on("error", reject);
      child.on("close", (code) =>
        code === 0 ? resolve(out) : reject(new Error(`walrus store exited ${code}: ${err.slice(-400)}`)),
      );
    });

    // --json prints a JSON array of per-file results (interleaved with logs on
    // stderr; stdout is clean). Grab the last JSON array in the output.
    const start = stdout.indexOf("[");
    const end = stdout.lastIndexOf("]");
    if (start < 0 || end < 0) throw new Error(`No JSON in walrus output: ${stdout.slice(-300)}`);
    const arr = JSON.parse(stdout.slice(start, end + 1));
    const r = arr[0]?.blobStoreResult;
    if (r?.newlyCreated) {
      const o = r.newlyCreated.blobObject;
      return { blobId: o.blobId, blobObjectId: o.id, alreadyCertified: false, size: o.size };
    }
    if (r?.alreadyCertified) {
      return { blobId: r.alreadyCertified.blobId, alreadyCertified: true };
    }
    throw new Error(`Unexpected walrus store result: ${JSON.stringify(arr).slice(0, 300)}`);
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
}

/** Read raw bytes for a blob id from the aggregator. */
export async function readBlob(
  blobId: string,
  opts: { config?: WalrusConfig } = {},
): Promise<Uint8Array> {
  const cfg = opts.config ?? ACTIVE_WALRUS;
  const res = await fetch(`${cfg.aggregator}/v1/blobs/${blobId}`);
  if (!res.ok) {
    throw new Error(`Walrus read failed: ${res.status} ${res.statusText}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

/** Convenience: read a blob and decode as UTF-8 text (e.g. a manifest). */
export async function readBlobText(
  blobId: string,
  opts: { config?: WalrusConfig } = {},
): Promise<string> {
  return new TextDecoder().decode(await readBlob(blobId, opts));
}

/** Public URL where a blob can be fetched (for UI links). */
export function blobUrl(blobId: string, config: WalrusConfig = ACTIVE_WALRUS): string {
  return `${config.aggregator}/v1/blobs/${blobId}`;
}

/**
 * Renew (re-pin) an existing blob for more storage epochs by reading its bytes
 * back from the aggregator and re-storing them. Blobs are content-addressed, so
 * the blobId is unchanged — only the storage lifetime is extended. testnet uses
 * the free publisher (no key); mainnet uses the `walrus store` CLI (spends WAL).
 * Used by `forge renew` + the scheduled renew sweep so published apps don't expire.
 */
export async function renewBlob(blobId: string, epochs = 30): Promise<StoredBlob> {
  const bytes = await readBlob(blobId);
  const stored = await storeBlobAuto(bytes, { epochs });
  if (stored.blobId !== blobId) {
    console.warn(`renewBlob: id changed ${blobId} -> ${stored.blobId} (unexpected for content-addressed blob)`);
  }
  return stored;
}
