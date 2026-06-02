/**
 * Signet — LLM proxy (backend P0, onboarding accelerator).
 *
 * A tiny, dependency-free relay that holds the Anthropic API key server-side so
 * Playground users don't need their own (no BYOK). It is intentionally NOT a
 * source of truth: it only forwards prompt → completion. All reads/writes that
 * matter (publish, gallery, metrics) stay on Sui + Walrus and are unaffected if
 * this service is down — the client falls back to BYOK.
 *
 * Contract (matches web/playground.js callLLM `mode:'proxy'`):
 *   POST /llm   { model, system, messages }  ->  { text }
 *   GET  /health                             ->  { ok: true }
 *
 * Hardening: model allowlist (claude-* only), max_tokens cap, per-IP rate limit,
 * request-size cap, CORS locked to ALLOWED_ORIGIN (default: any).
 *
 * Run:  ANTHROPIC_API_KEY=sk-ant-... node index.mjs      (Node 18+, global fetch)
 * Env:  ANTHROPIC_API_KEY (required), PORT=8787, ALLOWED_ORIGIN=https://your.site,
 *       RATE_LIMIT_PER_MIN=20, MAX_TOKENS=8000
 */
import { createServer } from 'node:http';
import { installShutdown, log, fetchT } from './lib.mjs';

const PORT = Number(process.env.PORT || 8787);
const API_KEY = process.env.ANTHROPIC_API_KEY || '';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const RATE_LIMIT_PER_MIN = Number(process.env.RATE_LIMIT_PER_MIN || 20);
const MAX_TOKENS = Number(process.env.MAX_TOKENS || 8000);
const MAX_BODY_BYTES = 256 * 1024; // generous for prompts, blocks abuse
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

if (!API_KEY) {
  console.error('FATAL: ANTHROPIC_API_KEY is not set. Refusing to start.');
  process.exit(1);
}

// ---- per-IP sliding-window rate limit (in-memory; swap for Redis at scale) ----
const hits = new Map(); // ip -> { count, resetAt }
function rateLimited(ip) {
  const now = Date.now();
  const rec = hits.get(ip);
  if (!rec || now > rec.resetAt) { hits.set(ip, { count: 1, resetAt: now + 60_000 }); return false; }
  rec.count += 1;
  return rec.count > RATE_LIMIT_PER_MIN;
}
// periodic cleanup so the map can't grow unbounded
setInterval(() => { const now = Date.now(); for (const [ip, r] of hits) if (now > r.resetAt) hits.delete(ip); }, 120_000).unref();

function cors(res, origin) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN === '*' ? (origin || '*') : ALLOWED_ORIGIN);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.setHeader('Access-Control-Max-Age', '86400');
}
function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}
const clientIp = (req) =>
  (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim() || req.socket.remoteAddress || 'unknown';

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { reject(new Error('payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  const origin = req.headers.origin;
  cors(res, origin);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'GET' && req.url === '/health') return json(res, 200, { ok: true });

  if (req.method !== 'POST' || req.url !== '/llm') return json(res, 404, { error: 'not found' });

  const ip = clientIp(req);
  if (rateLimited(ip)) return json(res, 429, { error: 'rate limit — slow down a moment' });

  let body;
  try { body = JSON.parse(await readBody(req)); }
  catch (e) { return json(res, 400, { error: e.message === 'payload too large' ? 'payload too large' : 'invalid JSON' }); }

  const { model, system, messages } = body || {};
  if (typeof model !== 'string' || !model.startsWith('claude-')) return json(res, 400, { error: 'invalid model' });
  if (!Array.isArray(messages) || !messages.length) return json(res, 400, { error: 'messages required' });

  try {
    const upstream = await fetchT(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ model, system, messages, max_tokens: MAX_TOKENS }),
    }, 30_000);
    if (!upstream.ok) {
      let detail = ''; try { detail = (await upstream.json())?.error?.message || ''; } catch {}
      return json(res, 502, { error: `anthropic ${upstream.status}${detail ? ': ' + detail : ''}` });
    }
    const j = await upstream.json();
    const text = (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    return json(res, 200, { text });
  } catch (e) {
    return json(res, 502, { error: 'upstream error: ' + (e.message || e) });
  }
});

server.listen(PORT, () => log('info', 'llm-proxy up', { port: PORT, origin: ALLOWED_ORIGIN, rateLimitPerMin: RATE_LIMIT_PER_MIN }));
installShutdown(server);
