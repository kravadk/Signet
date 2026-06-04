#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const root = new URL('..', import.meta.url);
const deployments = JSON.parse(await readFile(new URL('move/signet/deployments.json', root), 'utf8'));
const defaultWalrusAggregators = {
  testnet: 'https://aggregator.walrus-testnet.walrus.space',
  mainnet: 'https://aggregator.walrus-mainnet.walrus.space',
};
const profileArg = process.argv.find((a) => a.startsWith('--profile='));
const profile = profileArg ? profileArg.split('=')[1] : (process.argv[process.argv.indexOf('--profile') + 1] || process.env.SIGNET_PROFILE || 'all');
const networks = profile === 'all' ? ['testnet', 'mainnet'] : profile === 'localnet' ? ['localnet'] : [profile];

function ok(name, pass, detail = '') {
  console.log(`${pass ? '[ok]' : '[!!]'} ${name}${detail ? ' - ' + detail : ''}`);
  return pass;
}

function command(name, args = ['--version']) {
  const res = spawnSync(name, args, { encoding: 'utf8', shell: process.platform === 'win32' });
  return { pass: res.status === 0, out: (res.stdout || res.stderr || '').trim().split('\n')[0] || `exit ${res.status}` };
}

async function health(name, url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return ok(name, res.ok, `${res.status} ${url}`);
  } catch (e) {
    return ok(name, false, `${url} (${e.message})`);
  }
}

async function reachable(name, url) {
  try {
    const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(3000) });
    return ok(name, true, `${res.status} ${url}`);
  } catch (e) {
    return ok(name, false, `${url} (${e.message})`);
  }
}

let pass = true;
const node = command('node');
pass = ok('node', node.pass, node.out) && pass;
const sui = command('sui', ['--version']);
pass = ok('sui cli', sui.pass, sui.out) && pass;

for (const net of networks) {
  const d = deployments[net] || {};
  if (net === 'localnet') {
    pass = ok('localnet rpc', Boolean(process.env.SUI_LOCALNET_RPC || 'http://127.0.0.1:9000'), process.env.SUI_LOCALNET_RPC || 'http://127.0.0.1:9000') && pass;
    await health('localnet fullnode', process.env.SUI_LOCALNET_RPC || 'http://127.0.0.1:9000');
    continue;
  }
  pass = ok(`${net} packageId`, Boolean(d.packageId), d.packageId || 'missing') && pass;
  pass = ok(`${net} forgeRegistry`, Boolean(d.forgeRegistry), d.forgeRegistry || 'missing') && pass;
  const walrusAggregator = d.walrusAggregator || defaultWalrusAggregators[net];
  pass = ok(`${net} Walrus aggregator`, Boolean(walrusAggregator), walrusAggregator || 'missing') && pass;
  if (walrusAggregator) await reachable(`${net} Walrus aggregator`, walrusAggregator);
}

await health('indexer health', process.env.SIGNET_INDEXER_HEALTH || 'http://localhost:4318/health');
await health('sponsor health', process.env.SIGNET_SPONSOR_HEALTH || 'http://localhost:8788/health');
await health('salt health', process.env.SIGNET_SALT_HEALTH || 'http://localhost:8789/health');
await health('portal health', process.env.SIGNET_PORTAL_HEALTH || 'http://localhost:8790/health');

process.exit(pass ? 0 : 1);
