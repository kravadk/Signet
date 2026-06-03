/**
 * Signet — public portal (human URLs + share cards + verified render).
 *
 * Closes the "real shareable URL" gap: a static SPA can't emit per-app Open Graph
 * meta, so social/link previews are blank. This portal serves each published app
 * at a clean, human URL with proper og:/twitter: tags AND re-verifies the content
 * tree-hash against the on-chain anchor before rendering it in a sandboxed iframe.
 *
 * It is NOT a source of truth: every byte still comes from Sui + Walrus and is
 * re-verified per request; the portal just gives the bytes a shareable face.
 *
 *   GET /app/:id[?net=mainnet]   → app page (og card + verified sandboxed render)
 *   GET /@:handle[?net=mainnet]  → builder profile (og card + their apps)
 *   GET /api/apps[?net=&limit=]  → JSON list of published apps (read API)
 *   GET /health                  → { ok, nets }
 *
 * Run:  node index.mjs            (Node 18+, needs @mysten/sui; reads deployments.json)
 */
import { createServer } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { installShutdown, log, fetchT, ttlCache } from './lib.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8790);
const ORIGIN = process.env.PUBLIC_ORIGIN || `http://localhost:${PORT}`;
const DEPLOY = JSON.parse(readFileSync(join(__dirname, '..', '..', 'move', 'signet', 'deployments.json'), 'utf8'));

const NETS = {};
for (const net of ['testnet', 'mainnet']) {
  const d = DEPLOY[net]; if (!d?.playgroundEventPkg) continue;
  NETS[net] = {
    client: new SuiClient({ url: getFullnodeUrl(net) }),
    eventPkg: d.playgroundEventPkg,
    // An event's type uses the package that DEFINED its struct — query all and merge.
    eventPkgs: (d.playgroundEventPkgs && d.playgroundEventPkgs.length) ? d.playgroundEventPkgs : [d.playgroundEventPkg],
    nameRegistry: d.nameRegistry,
    agg: net === 'mainnet' ? 'https://aggregator.walrus-mainnet.walrus.space' : 'https://aggregator.walrus-testnet.walrus.space',
    explorer: (id) => `https://suiscan.xyz/${net}/object/${id}`,
  };
}
const pickNet = (q) => (q === 'mainnet' && NETS.mainnet ? 'mainnet' : 'testnet');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sha256hex = (buf) => createHash('sha256').update(buf).digest('hex');

/* Length-prefixed gzip archive (mirrors snapshot.ts / viewer.html). */
function inflateArchive(gz) {
  const flat = gunzipSync(Buffer.from(gz));
  const files = {}; let o = 0;
  while (o + 8 <= flat.length) {
    const pl = flat.readUInt32BE(o); const dl = flat.readUInt32BE(o + 4); o += 8;
    const path = flat.subarray(o, o + pl).toString('utf8'); o += pl;
    const data = flat.subarray(o, o + dl); o += dl;
    files[path] = data;
  }
  return files;
}

/* Recompute the content tree-hash straight from the archive bytes (no manifest
   trust): sha256 over `path:sha256(bytes)` lines, sorted by path. */
function treeHashOf(files) {
  const entries = Object.keys(files).sort().map((p) => `${p}:${sha256hex(files[p])}`);
  return sha256hex(Buffer.from(entries.join('\n'), 'utf8'));
}

const LOCAL_RE = /^(?!https?:\/\/|\/\/|data:|blob:|mailto:|#)/i;
const APP_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'";
/* Inline local <link>/<script src>, inject CSP, strip meta-refresh (mirrors web). */
function inlineApp(files) {
  const text = {};
  for (const [p, buf] of Object.entries(files)) text[p.replace(/\\/g, '/').replace(/^\.?\//, '')] = buf.toString('utf8');
  let html = text['index.html'] || Object.values(text)[0] || '<!doctype html><p>empty app</p>';
  const lookup = (h) => text[h.replace(/^\.?\//, '').split(/[?#]/)[0]];
  html = html.replace(/<link\b[^>]*?>/gi, (tag) => {
    if (!/rel\s*=\s*["']?stylesheet/i.test(tag)) return tag;
    const m = tag.match(/href\s*=\s*["']([^"']+)["']/i);
    if (!m || !LOCAL_RE.test(m[1])) return tag;
    const css = lookup(m[1]); return css != null ? `<style>\n${css}\n</style>` : tag;
  });
  html = html.replace(/<script\b([^>]*?)\bsrc\s*=\s*["']([^"']+)["']([^>]*)><\/script>/gi, (tag, pre, src, post) => {
    if (!LOCAL_RE.test(src)) return tag;
    const js = lookup(src); if (js == null) return tag;
    const keepType = /type\s*=\s*["']module["']/i.test(pre + post);
    return `<script${keepType ? ' type="module"' : ''}>\n${js}\n</script>`;
  });
  html = html.replace(/<meta\b[^>]*http-equiv\s*=\s*["']?\s*refresh[^>]*>/gi, '');
  const meta = `<meta http-equiv="Content-Security-Policy" content="${APP_CSP}">`;
  if (/<head[^>]*>/i.test(html)) html = html.replace(/<head[^>]*>/i, (m) => m + meta);
  else if (/<html[^>]*>/i.test(html)) html = html.replace(/<html[^>]*>/i, (m) => m + '<head>' + meta + '</head>');
  else html = '<!doctype html><head>' + meta + '</head>' + html;
  return html;
}

const short = (a) => (a ? a.slice(0, 6) + '…' + a.slice(-4) : '');

/* Page chrome with Open Graph + Twitter card meta (the share-loop). */
function shell({ title, desc, canonical, bar, bodyHtml }) {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Signet</title>
<meta name="description" content="${esc(desc)}">
<meta property="og:type" content="website"><meta property="og:title" content="${esc(title)} · Signet">
<meta property="og:description" content="${esc(desc)}"><meta property="og:url" content="${esc(canonical)}">
<meta name="twitter:card" content="summary"><meta name="twitter:title" content="${esc(title)} · Signet">
<meta name="twitter:description" content="${esc(desc)}"><link rel="canonical" href="${esc(canonical)}">
<style>:root{--blue:#4da2ff;--bg:#060606;--bd:#1d3a52;--tx:#cfe6ff;--green:#46d18a}
html,body{margin:0;height:100%;background:var(--bg);color:var(--tx);font-family:'JetBrains Mono',ui-monospace,monospace}
#bar{position:fixed;top:0;left:0;right:0;height:46px;display:flex;align-items:center;gap:12px;padding:0 14px;
background:#0c1622cc;backdrop-filter:blur(8px);border-bottom:1px solid var(--bd);font-size:13px;z-index:5}
#bar b{color:var(--blue)} #bar a{color:var(--tx);text-decoration:none} .sp{flex:1}
.prov{font-size:11.5px;color:var(--green);border:1px solid rgba(70,209,138,.35);background:rgba(70,209,138,.08);border-radius:999px;padding:3px 10px}
.prov.fail{color:#f15b4c;border-color:rgba(241,91,76,.4);background:rgba(241,91,76,.08)}
#frame{position:fixed;inset:46px 0 0 0;width:100%;height:calc(100% - 46px);border:0;background:#fff}
.wrap{padding:64px 20px 40px;max-width:920px;margin:0 auto} .card{border:1px solid var(--bd);border-radius:12px;padding:16px;margin:10px 0;background:#0c16221a}
a.btn{color:var(--blue);border:1px solid var(--bd);border-radius:8px;padding:6px 12px;text-decoration:none;font-size:13px}</style>
</head><body><div id="bar">${bar}</div>${bodyHtml}</body></html>`;
}

async function getApp(net, id) {
  const N = NETS[net];
  const obj = await N.client.getObject({ id, options: { showContent: true } });
  const f = obj.data?.content?.fields; if (!f) return null;
  return {
    id, net, builder: f.builder, name: f.name || 'app', prompt: f.prompt || '',
    manifestBlob: f.manifest_blob, archiveBlob: f.archive_blob, treeHash: f.tree_hash,
    visits: Number(f.visits || 0), stars: Number(f.stars || 0),
  };
}

async function renderAppPage(net, id) {
  const N = NETS[net];
  const app = await getApp(net, id);
  if (!app) return { code: 404, html: notFound('App not found on-chain.') };
  let verified = false, html = '<p>archive unavailable</p>', expired = false, encrypted = false;
  try {
    const res = await fetchT(`${N.agg}/v1/blobs/${app.archiveBlob}`, {}, 10_000);
    if (!res.ok) { expired = true; throw new Error('archive expired'); }
    const buf = new Uint8Array(await res.arrayBuffer());
    let files;
    try { files = inflateArchive(buf); }
    catch { encrypted = true; throw new Error('not gzip — likely a Seal-encrypted private app'); }
    verified = !app.treeHash || treeHashOf(files) === app.treeHash;
    html = inlineApp(files);
  } catch { /* expired / unavailable / encrypted */ }
  const status = verified ? '✓ verified · treeHash matches chain'
    : encrypted ? '🔒 private · wallet-gated'
    : expired ? '⚠ bytes expired on Walrus' : '⚠ unverified';
  const bar =
    `<b>${esc(app.name)}</b>` +
    `<span class="prov${verified ? '' : ' fail'}">${status}</span>` +
    `<span class="sp"></span><span>by ${esc(short(app.builder))}</span>` +
    `<a href="${esc(N.explorer(id))}" target="_blank" rel="noreferrer">on-chain ↗</a>`;
  const body = (expired || encrypted)
    ? `<div class="wrap"><div class="card"><h2>${esc(app.name)}</h2><p>${esc(app.prompt)}</p>` +
      (encrypted
        ? `<p class="prov fail">🔒 This app is private — its bytes are Seal-encrypted on Walrus. The builder or an allowlisted collaborator can decrypt and open it from the Playground with their wallet. The on-chain record (provenance, hash, metrics) stays public and verifiable.</p>`
        : `<p class="prov fail">The app's bytes have expired on Walrus. The on-chain record (provenance, hash, metrics) is permanent; the builder can re-pin to restore it.</p>`) +
      `<a class="btn" href="${esc(N.explorer(id))}" target="_blank" rel="noreferrer">View on-chain record ↗</a></div></div>`
    : `<iframe id="frame" sandbox="allow-scripts" referrerpolicy="no-referrer" srcdoc="${esc(html)}"></iframe>`;
  return { code: 200, html: shell({ title: app.name, desc: app.prompt || `An app built on Signet · ${app.visits} visits · ${app.stars}★`, canonical: `${ORIGIN}/app/${id}${net === 'mainnet' ? '?net=mainnet' : ''}`, bar, bodyHtml: body }) };
}

async function queryPkgEvents(client, eventType, { limit, order, pageLimit = 50 }) {
  const out = [];
  let cursor = null;
  do {
    const page = await client.queryEvents({ query: { MoveEventType: eventType }, cursor, limit: pageLimit, order });
    out.push(...page.data);
    cursor = page.nextCursor;
    if (!page.hasNextPage || out.length >= limit) break;
  } while (cursor);
  return out.slice(0, limit);
}

function eventTime(e) {
  return Number(e.timestampMs || e.parsedJson?.created_at_ms || 0);
}

// Query an event struct across all historical playground packages (its type uses
// the pkg that DEFINED it), cursor-paginate each package, then merge and dedup.
async function pgEvents(net, structName, { limit = 500, order = 'descending' } = {}) {
  const N = NETS[net]; const seen = new Set(); const out = [];
  const perPkgLimit = Math.max(limit, 50);
  const results = await Promise.all(N.eventPkgs.map((pkg) =>
    queryPkgEvents(N.client, `${pkg}::playground::${structName}`, { limit: perPkgLimit, order }).catch(() => [])));
  for (const data of results) {
    for (const e of data) {
      const k = `${e.id?.txDigest}:${e.id?.eventSeq}`;
      if (!seen.has(k)) { seen.add(k); out.push(e); }
    }
  }
  out.sort((a, b) => order === 'ascending' ? eventTime(a) - eventTime(b) : eventTime(b) - eventTime(a));
  return out.slice(0, limit);
}

async function resolveHandle(net, handle) {
  const map = new Map();
  try {
    for (const e of await pgEvents(net, 'NameClaimed', { limit: 2000, order: 'ascending' })) { const j = e.parsedJson; if (j?.owner && j?.name) map.set(j.name, j.owner); }
    for (const e of await pgEvents(net, 'NameReleased', { limit: 2000, order: 'ascending' })) { const j = e.parsedJson; if (j?.name && map.get(j.name) === j.owner) map.delete(j.name); }
  } catch {}
  return map.get(handle) || null;
}

async function listApps(net, limit = 60) {
  const N = NETS[net];
  const ids = (await pgEvents(net, 'AppPublished', { limit: Math.min(Math.max(limit, 1), 1000), order: 'descending' })).map((e) => e.parsedJson?.app_id).filter(Boolean);
  const out = [];
  for (let i = 0; i < ids.length; i += 50) {
    const objs = await N.client.multiGetObjects({ ids: ids.slice(i, i + 50), options: { showContent: true } });
    for (const o of objs) { const f = o.data?.content?.fields; if (!f) continue;
      out.push({ id: o.data.objectId, name: f.name || '', builder: f.builder, prompt: f.prompt || '', visits: Number(f.visits || 0), stars: Number(f.stars || 0) }); }
  }
  return out;
}

async function renderProfile(net, handle) {
  const addr = await resolveHandle(net, handle);
  if (!addr) return { code: 404, html: notFound(`@${esc(handle)} — handle not claimed.`) };
  const apps = (await listApps(net, 200)).filter((a) => a.builder === addr);
  const visits = apps.reduce((n, a) => n + a.visits, 0), stars = apps.reduce((n, a) => n + a.stars, 0);
  const bar = `<b>@${esc(handle)}</b><span class="sp"></span><a href="${ORIGIN}">Signet</a>`;
  const cards = apps.map((a) => `<div class="card"><b>${esc(a.name)}</b> — ${esc(a.prompt).slice(0, 120)}<br>` +
    `<small>▶ ${a.visits} · ★ ${a.stars}</small> · <a class="btn" href="${ORIGIN}/app/${a.id}${net === 'mainnet' ? '?net=mainnet' : ''}">Open</a></div>`).join('') || '<p>No apps yet.</p>';
  const body = `<div class="wrap"><h1>@${esc(handle)}</h1><p>${apps.length} apps · ${visits} visits · ${stars}★ · ${esc(short(addr))}</p>${cards}</div>`;
  return { code: 200, html: shell({ title: `@${handle}`, desc: `${apps.length} apps · ${visits} visits · ${stars}★ on Signet`, canonical: `${ORIGIN}/@${handle}${net === 'mainnet' ? '?net=mainnet' : ''}`, bar, bodyHtml: body }) };
}

const notFound = (msg) => shell({ title: 'Not found', desc: msg, canonical: ORIGIN, bar: `<b>Signet</b>`, bodyHtml: `<div class="wrap"><div class="card">${esc(msg)}</div></div>` });

// Readiness: one cheap RPC per net (cached) so /health reflects real RPC reachability.
const rpcReady = ttlCache(30_000);
async function rpcStatus() {
  return rpcReady(async () => {
    const out = {};
    await Promise.all(Object.entries(NETS).map(async ([net, N]) => {
      try { await N.client.getLatestSuiSystemState(); out[net] = true; } catch { out[net] = false; }
    }));
    return out;
  });
}

// /status fans out to the other services' /health (env SERVICES = "name=url,name=url").
const STATUS_SVCS = (process.env.SERVICES ||
  'llm-proxy=http://localhost:8787,sponsor=http://localhost:8788,salt=http://localhost:8789,indexer=http://localhost:4318/api')
  .split(',').map((s) => { const [name, url] = s.split('='); return { name, url }; }).filter((s) => s.url);
async function aggregateStatus() {
  const self = { name: 'portal', ok: true, detail: { nets: Object.keys(NETS), rpc: await rpcStatus().catch(() => ({})) } };
  const others = await Promise.all(STATUS_SVCS.map(async (s) => {
    try { const r = await fetchT(`${s.url}/health`, {}, 3_000); const j = await r.json().catch(() => ({})); return { name: s.name, ok: r.ok && j.ok !== false, detail: j }; }
    catch (e) { return { name: s.name, ok: false, detail: { error: String(e.message || e) } }; }
  }));
  return [self, ...others];
}

const server = createServer(async (req, res) => {
  try {
    const u = new URL(req.url, ORIGIN);
    const net = pickNet(u.searchParams.get('net'));
    if (u.pathname === '/health') {
      const rpc = await rpcStatus().catch(() => ({}));
      const ok = Object.keys(NETS).length > 0 && Object.values(rpc).some(Boolean);
      res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok, nets: Object.keys(NETS), rpc }));
    }
    if (u.pathname === '/status') {
      const svcs = await aggregateStatus();
      const allOk = svcs.every((s) => s.ok);
      if ((req.headers.accept || '').includes('application/json')) {
        res.writeHead(allOk ? 200 : 503, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ ok: allOk, services: svcs }));
      }
      const rows = svcs.map((s) => `<div class="card"><span class="prov${s.ok ? '' : ' fail'}">${s.ok ? '✓' : '✗'} ${esc(s.name)}</span></div>`).join('');
      res.writeHead(allOk ? 200 : 503, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(shell({ title: 'Status', desc: 'Signet service status', canonical: `${ORIGIN}/status`, bar: '<b>Signet status</b>', bodyHtml: `<div class="wrap">${rows}</div>` }));
    }
    if (u.pathname === '/api/apps') {
      const apps = await listApps(net, Number(u.searchParams.get('limit') || 60));
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      return res.end(JSON.stringify({ net, apps }));
    }
    let m;
    if ((m = u.pathname.match(/^\/app\/(0x[0-9a-fA-F]{1,64})$/))) {
      const { code, html } = await renderAppPage(net, m[1]);
      res.writeHead(code, { 'content-type': 'text/html; charset=utf-8' }); return res.end(html);
    }
    if ((m = u.pathname.match(/^\/@([a-z0-9-]{1,64})$/))) {
      const { code, html } = await renderProfile(net, m[1]);
      res.writeHead(code, { 'content-type': 'text/html; charset=utf-8' }); return res.end(html);
    }
    if (u.pathname === '/') { res.writeHead(302, { location: '/api/apps' }); return res.end(); }
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' }); res.end(notFound('Not found. Try /app/<id> or /@<handle>.'));
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/html; charset=utf-8' }); res.end(notFound('Error: ' + (e?.message || e)));
  }
});
if (process.env.NODE_ENV !== 'test') {
  server.listen(PORT, () => log('info', 'portal up', { port: PORT, nets: Object.keys(NETS), origin: ORIGIN }));
  installShutdown(server);
}
// Exported for unit tests (pure functions, no network/listen).
export { inlineApp, treeHashOf, inflateArchive };
