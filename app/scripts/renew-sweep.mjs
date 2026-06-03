/**
 * Scheduled Walrus renew sweep (run by .github/workflows/renew.yml).
 *
 * Re-pins every published Playground app's archive + manifest blobs for more
 * epochs so they don't expire. Content-addressed, so blob ids are unchanged.
 * Keyless on testnet (free publisher); mainnet would need the walrus CLI + WAL.
 *
 * Env: FORGE_NETWORK (default testnet), EPOCHS (default 30).
 * Usage: node --import tsx scripts/renew-sweep.mjs
 */
import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import { loadDeployment } from "../src/lib/sui.ts";
import { renewBlob } from "../src/lib/walrus.ts";

const NET = process.env.FORGE_NETWORK === "mainnet" ? "mainnet" : "testnet";
const EPOCHS = Number(process.env.EPOCHS || 30);
const dep = loadDeployment(NET);
const client = new SuiClient({ url: getFullnodeUrl(NET) });

// An app's AppPublished event lives under whichever upgrade first defined that
// struct, so scan every historical playground package and merge.
const pkgs = dep.playgroundEventPkgs?.length
  ? dep.playgroundEventPkgs
  : [dep.playgroundEventPkg || dep.playgroundPackageId].filter(Boolean);
console.log(`[renew] ${NET} · epochs=${EPOCHS} · scanning ${pkgs.length} event pkg(s)`);

const ids = new Set();
for (const pkg of pkgs) {
  let cursor = null;
  do {
    let page;
    try {
      page = await client.queryEvents({
        query: { MoveEventType: `${pkg}::playground::AppPublished` },
        cursor, limit: 50, order: "descending",
      });
    } catch { break; }
    for (const e of page.data) { const id = e.parsedJson?.app_id; if (id) ids.add(id); }
    cursor = page.nextCursor;
    if (!page.hasNextPage) break;
  } while (cursor);
}
console.log(`[renew] ${ids.size} app(s)`);

let ok = 0, fail = 0, skip = 0;
for (const id of ids) {
  try {
    const obj = await client.getObject({ id, options: { showContent: true } });
    const f = obj.data?.content?.fields ?? {};
    const blobs = [f.archive_blob, f.manifest_blob].filter(Boolean);
    if (!blobs.length) { skip++; continue; }
    for (const b of blobs) await renewBlob(b, EPOCHS);
    ok++;
    console.log(`  ✓ ${id.slice(0, 10)}… (${blobs.length} blob(s))`);
  } catch (e) {
    fail++;
    console.log(`  ✗ ${id.slice(0, 10)}…: ${String(e?.message ?? e).slice(0, 70)}`);
  }
}
console.log(`[renew] done — renewed=${ok} skipped=${skip} failed=${fail}`);
