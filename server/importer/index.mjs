/**
 * Signet — GitHub importer service (backend P0, keyless).
 *
 * Browsers can't clone a GitHub repo (CORS) or build a CLI-compatible snapshot,
 * so this service does it server-side: shallow-clone -> buildSnapshot (the SAME
 * code the CLI uses, so the tree hash is identical and verifiable) -> upload the
 * archive + manifest to Walrus -> return the blob ids. It signs NOTHING: the web
 * app then calls forge::create_repo with the returned manifest blob, signed by
 * the user's own wallet. No keys live here.
 *
 *   POST /import { url, branch }  ->  { name, branch, treeHash, files, archiveBlob, manifestBlob }
 *   GET  /health                 ->  { ok: true }
 *
 * Only https://github.com/* URLs are accepted (SSRF guard). Run on testnet:
 *   FORGE_NETWORK=testnet node --import tsx index.mjs
 */
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { installShutdown, log, strictCors, makeRateLimiter, clientIp, makeMetrics, captureError } from './lib.mjs';
import { buildSnapshot } from '../../app/src/lib/snapshot.ts';
import { storeBlobAuto } from '../../app/src/lib/walrus.ts';

const PORT = Number(process.env.PORT || 8795);
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const MAX_FILES = Number(process.env.MAX_FILES || 2000);
const EPOCHS = Number(process.env.EPOCHS || 30);
const CLONE_TIMEOUT_MS = Number(process.env.CLONE_TIMEOUT_MS || 60_000);
const MAX_BODY = 4 * 1024;

/** Accept only well-formed https://github.com/<owner>/<repo> URLs (SSRF guard). */
function normalizeGitHubUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { throw new Error('invalid url'); }
  if (u.protocol !== 'https:' || u.hostname !== 'github.com') throw new Error('only https://github.com URLs are allowed');
  const parts = u.pathname.replace(/^\/+/, '').split('/');
  if (parts.length < 2 || !parts[0] || !parts[1]) throw new Error('expected github.com/<owner>/<repo>');
  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/, '');
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) throw new Error('bad owner/repo');
  return { url: `https://github.com/${owner}/${repo}.git`, name: repo };
}

function safeBranch(b) {
  const s = String(b || 'main');
  if (!/^[\w./-]+$/.test(s)) throw new Error('bad branch name');
  return s;
}

async function importRepo(rawUrl, rawBranch) {
  const { url, name } = normalizeGitHubUrl(rawUrl);
  const branch = safeBranch(rawBranch);
  const tmp = mkdtempSync(join(tmpdir(), 'signet-import-'));
  try {
    execFileSync('git', ['clone', '--depth', '1', '--branch', branch, '--', url, tmp],
      { stdio: 'ignore', timeout: CLONE_TIMEOUT_MS });
    rmSync(join(tmp, '.git'), { recursive: true, force: true });
    const { archive, manifest } = buildSnapshot({
      repoDir: tmp, name, branch, previousSnapshot: null, nowEpochMs: Date.now(),
    });
    if (manifest.files.length === 0) throw new Error('repo has no files');
    if (manifest.files.length > MAX_FILES) throw new Error(`repo too large (${manifest.files.length} > ${MAX_FILES} files)`);
    const archiveBlob = await storeBlobAuto(archive, { epochs: EPOCHS });
    const manifestWithArchive = { ...manifest, archiveBlob: archiveBlob.blobId };
    const manifestBlob = await storeBlobAuto(JSON.stringify(manifestWithArchive), { epochs: EPOCHS });
    return {
      name, branch, treeHash: manifest.treeHash, files: manifest.files.length,
      archiveBlob: archiveBlob.blobId, manifestBlob: manifestBlob.blobId,
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', (c) => { n += c.length; if (n > MAX_BODY) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// Cloning is expensive, so default to a tighter limit than other services.
const limited = makeRateLimiter({ perMin: Number(process.env.RATE_LIMIT_PER_MIN || 10) });
const metrics = makeMetrics('importer');

const server = createServer(async (req, res) => {
  strictCors(res, req.headers.origin, ALLOWED_ORIGIN);
  if (req.method === 'GET' && req.url === '/metrics') {
    res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' }); return res.end(metrics.text());
  }
  res.setHeader('content-type', 'application/json');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (req.method === 'GET' && req.url === '/health') { res.writeHead(200); return res.end(JSON.stringify({ ok: true })); }
  if (req.method === 'POST' && (req.url === '/import' || req.url === '/')) {
    metrics.inc('requests_total');
    if (limited(clientIp(req))) { metrics.inc('rate_limited_total'); res.writeHead(429, { 'Retry-After': '60' }); return res.end(JSON.stringify({ error: 'rate limit — clones are expensive, slow down' })); }
    try {
      const { url, branch } = JSON.parse((await readBody(req)) || '{}');
      if (!url) { res.writeHead(400); return res.end(JSON.stringify({ error: 'url required' })); }
      const out = await importRepo(url, branch);
      log('info', 'imported', { name: out.name, files: out.files });
      res.writeHead(200); return res.end(JSON.stringify(out));
    } catch (e) {
      metrics.inc('request_errors_total');
      captureError(e, { at: 'import' });
      res.writeHead(400); return res.end(JSON.stringify({ error: String(e.message || e) }));
    }
  }
  res.writeHead(404); res.end(JSON.stringify({ error: 'not found' }));
});

if (process.env.NODE_ENV !== 'test') {
  server.listen(PORT, () => log('info', 'importer listening', { port: PORT, network: process.env.FORGE_NETWORK || 'testnet' }));
  installShutdown(server);
}

export { importRepo, normalizeGitHubUrl };
