/**
 * Walrus HTTP client for WalrusForge.
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

export interface WalrusConfig {
  publisher: string;
  aggregator: string;
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
  const cfg = opts.config ?? WALRUS_TESTNET;
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

/** Read raw bytes for a blob id from the aggregator. */
export async function readBlob(
  blobId: string,
  opts: { config?: WalrusConfig } = {},
): Promise<Uint8Array> {
  const cfg = opts.config ?? WALRUS_TESTNET;
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
export function blobUrl(blobId: string, config: WalrusConfig = WALRUS_TESTNET): string {
  return `${config.aggregator}/v1/blobs/${blobId}`;
}
