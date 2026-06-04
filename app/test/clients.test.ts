import test from "node:test";
import assert from "node:assert/strict";

import { BountyClient, toSignetResult } from "../src/clients.js";

test("toSignetResult wraps successful action output with anchors", async () => {
  const res = await toSignetResult(async () => ({
    txDigest: "TX",
    repoId: "0xrepo",
    headBlob: "blob-1",
  }));
  assert.equal(res.ok, true);
  assert.equal(res.digest, "TX");
  assert.deepEqual(res.created, ["0xrepo"]);
  assert.deepEqual(res.reverify?.blobIds, ["blob-1"]);
});

test("toSignetResult converts thrown errors into structured failures", async () => {
  const res = await toSignetResult(async () => {
    throw new Error("boom");
  });
  assert.equal(res.ok, false);
  assert.equal(res.error?.message, "boom");
});

test("write clients fail explicitly without a signing context", async () => {
  const res = await new BountyClient().post({ repoId: "0xrepo", title: "Fix", amountMist: 1 });
  assert.equal(res.ok, false);
  assert.match(res.error?.message ?? "", /ForgeContext required/);
});
