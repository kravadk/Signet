import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const appRoot = join(__dirname, "..");
const mockImport = pathToFileURL(join(__dirname, "mcp-fetch-mock.mjs")).href;

function parseToolText(result: any) {
  const text = result?.content?.find((c: any) => c.type === "text")?.text;
  assert.equal(typeof text, "string");
  return JSON.parse(text);
}

test("MCP server exposes Sui primitives and dry-run/write-safe Signet tools", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", mockImport, "--import", "tsx", "src/mcp/server.ts"],
    cwd: appRoot,
    stderr: "pipe",
    env: { ...process.env, FORGE_NETWORK: "testnet" } as Record<string, string>,
  });
  const client = new Client({ name: "signet-test", version: "0.0.0" });
  await client.connect(transport);
  try {
    const listed = await client.listTools();
    const names = new Set(listed.tools.map((t) => t.name));
    for (const name of ["sui_balance", "sui_object", "release_verify", "signet_tool_manifest"]) {
      assert.ok(names.has(name), `missing MCP tool ${name}`);
    }

    const manifest = parseToolText(await client.callTool({ name: "signet_tool_manifest", arguments: {} }));
    assert.ok(manifest.tools.some((t: any) => t.name === "sui_balance"));

    const balance = parseToolText(await client.callTool({
      name: "sui_balance",
      arguments: { address: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef" },
    }));
    assert.equal(balance.totalBalance, "123000000");

    const object = parseToolText(await client.callTool({ name: "sui_object", arguments: { objectId: "0x2" } }));
    assert.equal(object.data.objectId, "0x2");

    const verify = parseToolText(await client.callTool({
      name: "release_verify",
      arguments: { releaseId: "0x00000000000000000000000000000000000000000000000000000000000000dd" },
    }));
    assert.equal(verify.pass, false);
    assert.equal(verify.steps[0].key, "exists");

    const dry = parseToolText(await client.callTool({
      name: "issue_create",
      arguments: { dryRun: true, repoId: "0xrepo", title: "dry", body: "body" },
    }));
    assert.equal(dry.dryRun, true);
    assert.equal(dry.willSign, false);
  } finally {
    await client.close();
  }
});
