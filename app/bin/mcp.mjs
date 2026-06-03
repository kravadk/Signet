#!/usr/bin/env node
// Signet MCP server launcher (stdio). Agents point their MCP client at
// `signet-mcp` with FORGE_AGENT_KEY set. Runs the TypeScript via tsx.
import { register } from "tsx/esm/api";
register();
await import(new URL("../src/mcp/server.ts", import.meta.url).href);
