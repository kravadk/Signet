/**
 * Real agent ↔ MCP demo driver.
 *
 * Spawns the WalrusForge MCP server over stdio exactly as an MCP client (Claude
 * Desktop / Cursor) would, signing as a *separate agent identity* via
 * FORGE_AGENT_KEY (loaded from app/.agent.env — never printed). It performs the
 * real agent loop over the protocol:
 *   tools/list  →  pr_create  →  review_submit  →  agent_reputation
 *
 * This is the proof that an AI agent can drive WalrusForge through MCP — not a
 * scripted owner transaction.
 *
 * Usage: node --import tsx scripts/mcp-agent-demo.mjs <repoId> <agentCapId>
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = process.argv[2];
const CAP = process.argv[3];
if (!REPO || !CAP) {
  console.error('usage: node --import tsx scripts/mcp-agent-demo.mjs <repoId> <agentCapId>');
  process.exit(1);
}

// Load the agent key from .agent.env into this process env (not logged).
const envText = readFileSync(join(__dirname, '..', '.agent.env'), 'utf8');
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2];
}
const AGENT = process.env.AGENT_ADDRESS || '(unknown)';
console.log(`[demo] acting as agent ${AGENT} via MCP stdio (key from .agent.env, not shown)`);

// Spawn the MCP server exactly like an MCP client would.
const server = spawn('npx', ['tsx', join(__dirname, '..', 'src', 'mcp', 'server.ts')], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: process.env,
  shell: process.platform === 'win32',
});

let buf = '';
const pending = new Map();
server.stdout.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  }
});

let nextId = 1;
function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
function notify(method, params) {
  server.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}
const text = (r) => r?.result?.content?.map((c) => c.text).join('') ?? JSON.stringify(r?.error ?? r?.result);

async function main() {
  // MCP handshake
  await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'walrusforge-agent-demo', version: '1.0.0' },
  });
  notify('notifications/initialized', {});

  const tools = await rpc('tools/list', {});
  const names = (tools.result?.tools ?? []).map((t) => t.name);
  console.log(`[demo] MCP exposes ${names.length} tools: ${names.join(', ')}`);

  console.log('[demo] → pr_create (agent opens a PR via MCP)…');
  const pr = await rpc('tools/call', {
    name: 'pr_create',
    arguments: {
      repoId: REPO,
      agentCapId: CAP,
      title: 'Agent-authored PR via MCP',
      files: [{ path: 'sources/agent_note.move', content: '// proposed by an MCP agent\nmodule demo::agent_note { }\n' }],
    },
  });
  console.log('   ', text(pr));
  const prId = (() => { try { return JSON.parse(text(pr)).prId; } catch { return null; } })();

  if (prId) {
    console.log('[demo] → review_submit (agent reviews its own PR — approve)…');
    const rev = await rpc('tools/call', {
      name: 'review_submit',
      arguments: { repoId: REPO, prId, agentCapId: CAP, verdict: 1, reportText: 'LGTM — automated agent review via MCP.' },
    });
    console.log('   ', text(rev));
  }

  console.log('[demo] → agent_reputation (read earned score)…');
  const rep = await rpc('tools/call', { name: 'agent_reputation', arguments: { repoId: REPO, agent: AGENT } });
  console.log('   ', text(rep));

  console.log('[demo] ✓ agent loop completed over MCP.');
  server.kill();
  process.exit(0);
}

main().catch((e) => { console.error('[demo] failed:', e); server.kill(); process.exit(1); });
