/* ============================================================
   Signet — Playground: chat → AI builds an app → live
   preview → publish to Sui+Walrus → gallery → remix.

   The compelling loop:
   type a prompt, a real LLM builds a self-contained app, you see
   it live, publish it on-chain (verifiable provenance), it lands
   in a public gallery with on-chain visits/stars and a remix graph.

   Static SPA shell with optional backend services: hosted LLM proxy,
   sponsor, portal, zkLogin salt/prover, plus direct Sui RPC and Walrus.
   User settings stay local; provenance, apps, metrics and payments are
   anchored through the chain/RPC-backed services.
   ============================================================ */

import { Transaction } from 'https://esm.sh/@mysten/sui@1.30.0/transactions';
import {
  CFG, SETTINGS, saveSettings, sui, STATE, $, short, escapeHtml, blobUrl, explorerObject, explorerAddress, suiAmount, MIST,
  isValidSuiAddress, withTimeout, decodeSuiError,
} from './shared.js';
import { toast, openModal, closeModal } from './ui.js';
import {
  signAndRun, signAndRunCreated, signAndRunSponsored, walrusPut, nameOrShort, resolveName,
} from './wallet.js';
import { beginZkLogin, zkConfigured, zkSession, zkLogout } from './zklogin.js';

/* The playground module lives in the UPGRADED package; existing forge data stays
   under CFG.packageId, so playground calls/events use playgroundPackageId. */
const PG_PKG = CFG.playgroundPackageId || CFG.packageId;
// Event types keep the original package id where the module first appeared, so
// reads use PG_EVENT while writes/calls use the latest PG_PKG.
const PG_EVENT = CFG.playgroundEventPkg || PG_PKG;
// An event's type carries the package id of the upgrade that DEFINED its struct, so
// different playground events live under different package ids. Query the struct
// across ALL historical packages and merge (dedupe by tx+eventSeq).
const PG_EVENT_PKGS = (CFG.playgroundEventPkgs && CFG.playgroundEventPkgs.length) ? CFG.playgroundEventPkgs : [PG_EVENT];
async function pgEvents(structName, { limit = 200, order = 'descending' } = {}) {
  const seen = new Set(); const out = [];
  const perPkgLimit = Math.max(1, limit);
  await Promise.all(PG_EVENT_PKGS.map(async (pkg) => {
    let cursor = null; let pages = 0; let count = 0;
    do {
      const r = await withTimeout(sui.queryEvents({
        query: { MoveEventType: `${pkg}::playground::${structName}` },
        cursor, limit: Math.min(50, perPkgLimit - count), order,
      }), 15000, `${structName} events`);
      if (!r?.data?.length) break;
      for (const e of r.data) {
        const k = `${e.id?.txDigest}:${e.id?.eventSeq}`;
        if (!seen.has(k)) { seen.add(k); out.push(e); count++; }
      }
      cursor = r.nextCursor;
      if (!r.hasNextPage || count >= perPkgLimit) break;
    } while (cursor && ++pages < 20);
  }));
  return out;
}
const pgCall = (tx, fn, args) => tx.moveCall({ target: `${PG_PKG}::${fn}`, arguments: args });

/* sui.multiGetObjects caps at 50 ids per call — chunk so galleries/bounty lists
   beyond 50 don't error or silently truncate. */
async function multiGetChunked(ids, options) {
  const out = [];
  for (let i = 0; i < ids.length; i += 50) {
    const part = await withTimeout(sui.multiGetObjects({ ids: ids.slice(i, i + 50), options }), 15000, 'playground objects');
    out.push(...part);
  }
  return out;
}
export const PLAYGROUND_READY = !!CFG.playgroundPackageId;

/* ============================================================
   LLM abstraction (BYOK now, proxy-swappable later)
   ============================================================ */
const LLM_KEY = 'wf.llm';
const DEFAULT_MODEL = 'claude-sonnet-4-5';
const MODELS = [
  ['claude-sonnet-4-5', 'Sonnet 4.5 (fast)'],
  ['claude-opus-4-1', 'Opus 4.1 (max quality)'],
  ['claude-haiku-4-5', 'Haiku 4.5 (cheapest)'],
];

export function loadLlmConfig() {
  try { return JSON.parse(localStorage.getItem(LLM_KEY) || '{}'); } catch { return {}; }
}
function saveLlmConfig(cfg) {
  try { localStorage.setItem(LLM_KEY, JSON.stringify(cfg)); } catch {}
}
// Auto-wire to a hosted proxy when one is injected via config.js (CFG.llmProxyUrl);
// a user's saved choice in localStorage still overrides.
let llm = Object.assign(
  { mode: CFG.llmProxyUrl ? 'proxy' : 'byok', apiKey: '', model: DEFAULT_MODEL, proxyUrl: CFG.llmProxyUrl || '' },
  loadLlmConfig(),
);

const SYSTEM_PROMPT = [
  'You are an expert web app builder for Signet Playground.',
  'Given a description, output a COMPLETE, self-contained web app as JSON.',
  'Return ONLY a JSON object, no prose, no markdown fences, with this exact shape:',
  '{"name":"kebab-case-name","category":"one of: game|tool|art|data|social|other",',
  '"files":[{"path":"index.html","content":"<full html>"}]}',
  'Rules: index.html must be a complete document with ALL CSS inline in <style> and ALL JS inline in <script>.',
  'No external network requests, no CDN <script src>, no fetch to third parties, no localStorage to other origins.',
  'Keep it a single index.html unless multiple files are truly needed. Make it polished and functional.',
].join('\n');

/** Strip ```json / ``` fences a model may wrap output in. */
function stripFences(s) {
  return String(s).replace(/^\s*```(?:json|html)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
}

/**
 * Call the LLM with a message list. Returns { text }.
 * mode 'byok'  -> Anthropic Messages API directly from the browser.
 * mode 'proxy' -> a relay that injects the key (future; same shape).
 */
export async function callLLM(messages, { system = SYSTEM_PROMPT, signal } = {}) {
  if (llm.mode === 'proxy') {
    const res = await fetch(llm.proxyUrl || CFG.llmProxyUrl, {
      method: 'POST', signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: llm.model, system, messages }),
    });
    if (!res.ok) throw new Error(`Proxy ${res.status}`);
    const j = await res.json();
    return { text: j.text ?? j.content?.[0]?.text ?? '' };
  }
  // BYOK — direct Anthropic call.
  if (!llm.apiKey) throw new Error('No API key — open settings and paste your Anthropic key.');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', signal,
    headers: {
      'content-type': 'application/json',
      'x-api-key': llm.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({ model: llm.model, max_tokens: 8000, system, messages }),
  });
  if (!res.ok) {
    let detail = ''; try { detail = (await res.json())?.error?.message || ''; } catch {}
    throw new Error(`Anthropic ${res.status}${detail ? ': ' + detail : ''}`);
  }
  const j = await res.json();
  const text = (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  return { text };
}

/** Parse the model's JSON app spec; tolerant of fences/stray prose. */
function parseAppSpec(raw) {
  let s = stripFences(raw);
  const a = s.indexOf('{'); const b = s.lastIndexOf('}');
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  const spec = JSON.parse(s);
  if (!spec.files || !spec.files.length) throw new Error('Model returned no files');
  if (spec.files.length > 24) throw new Error('Too many files (max 24)');
  // Sanitize file paths: POSIX, no leading slash, no traversal, no absolute/UNC.
  spec.files = spec.files.map((f) => {
    const path = String(f.path || '').replace(/\\/g, '/').replace(/^\.?\/+/, '');
    if (!path || path.includes('..') || /^[/~]|^[a-z]:/i.test(path)) {
      throw new Error(`Unsafe file path: ${f.path}`);
    }
    return { path, content: String(f.content ?? '') };
  });
  if (!spec.files.some((f) => f.path === 'index.html')) {
    spec.files[0].path = 'index.html';
  }
  spec.name = (spec.name || 'app').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'app';
  spec.category = ['game', 'tool', 'art', 'data', 'social', 'other'].includes(spec.category) ? spec.category : 'other';
  return spec;
}

/* ============================================================
   Snapshot build (browser) — mirrors app/src/lib/snapshot.ts so the
   existing verifyTreeHashBrowser() in app.js verifies it byte-for-byte.
   ============================================================ */
async function sha256Hex(bytes) {
  const buf = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function gzip(bytes) {
  const cs = new CompressionStream('gzip');
  const stream = new Blob([bytes]).stream().pipeThrough(cs);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
/** length-prefixed archive: [pathLen u32 BE][dataLen u32 BE][path][data], sorted by path, gzipped. */
function packArchive(files) {
  const enc = new TextEncoder();
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : 1));
  const parts = [];
  for (const f of sorted) {
    const p = enc.encode(f.path); const d = enc.encode(f.content);
    const head = new DataView(new ArrayBuffer(8));
    head.setUint32(0, p.length, false); head.setUint32(4, d.length, false);
    parts.push(new Uint8Array(head.buffer), p, d);
  }
  const total = parts.reduce((n, x) => n + x.length, 0);
  const out = new Uint8Array(total); let o = 0;
  for (const x of parts) { out.set(x, o); o += x.length; }
  return out;
}

/** Build { archive, manifest } from app files. nowEpochMs passed in for determinism. */
export async function buildAppSnapshot(files, { name, prompt, model, category, parent, nowEpochMs }) {
  const enc = new TextEncoder();
  // Normalize path separators to POSIX so the treeHash matches snapshot.ts/viewer.
  files = files.map((f) => ({ path: String(f.path).replace(/\\/g, '/'), content: f.content }));
  const entries = [];
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    const bytes = enc.encode(f.content);
    entries.push({ path: f.path, sha256: await sha256Hex(bytes), size: bytes.length });
  }
  const treeHash = await sha256Hex(enc.encode(entries.map((e) => `${e.path}:${e.sha256}`).join('\n')));
  const archive = await gzip(packArchive(files));
  const manifest = {
    name, branch: 'main', createdAtEpochMs: nowEpochMs, previousSnapshot: parent || null,
    files: entries, treeHash,
    playground: { kind: 'playground-app', prompt, model, category, parent: parent || null },
  };
  return { archive, manifest, treeHash };
}

/* ============================================================
   Chat / preview state
   ============================================================ */
const pg = {
  messages: [],          // anthropic message list
  current: null,         // { name, category, files, prompt }
  remixParent: null,     // parent app id when remixing
  remixForkPrice: 0,     // parent's fork price in MIST (>0 => bundle pay_to_fork on publish)
  updateTarget: null,    // existing app id when publishing a new version (update_app)
  basePrompt: null,      // the defining prompt of the current app (set on first build of a session)
  busy: false,
  gallery: [],           // loaded PublishedApp records
  handles: new Map(),    // builder address -> claimed handle
  workspaces: new Map(), // app_id -> Set<member address>
  bounties: [],          // loaded open AppBounty records
  filter: 'newest',
  cat: 'all',
  search: '',
};
const PG_DRAFT_KEY = 'wf.playground.draft';
const PG_FLOW_KEY = 'wf.playground.flow';
function saveDraft() {
  try { sessionStorage.setItem(PG_DRAFT_KEY, $('pgInput')?.value || ''); } catch {}
}
function restoreDraft() {
  try {
    const draft = sessionStorage.getItem(PG_DRAFT_KEY);
    const input = $('pgInput');
    if (draft && input && !input.value) {
      input.value = draft;
      toast('Draft restored after refresh', { kind: 'info', timeout: 1800 });
    }
    const flow = sessionStorage.getItem(PG_FLOW_KEY);
    if (flow) {
      sessionStorage.removeItem(PG_FLOW_KEY);
      toast('Previous build/publish flow was interrupted by refresh. Review the current on-chain state, then retry.', { kind: 'error', action: { label: 'Refresh', onClick: loadGallery } });
    }
  } catch {}
}
function markFlow(name) {
  try {
    if (name) sessionStorage.setItem(PG_FLOW_KEY, name);
    else sessionStorage.removeItem(PG_FLOW_KEY);
  } catch {}
}

/* Inject a CSP that allows inline (the apps are inline by design) but blocks all
   network egress — defense-in-depth on top of the iframe sandbox for untrusted
   LLM-generated code. */
const APP_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'";
function withCSP(html) {
  // Neutralize meta-refresh: a sandboxed frame without allow-top-navigation can still
  // navigate ITSELF, so a <meta http-equiv="refresh"> could redirect the preview away.
  html = String(html).replace(/<meta\b[^>]*http-equiv\s*=\s*["']?\s*refresh[^>]*>/gi, '');
  const meta = `<meta http-equiv="Content-Security-Policy" content="${APP_CSP}">`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + meta);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => m + '<head>' + meta + '</head>');
  return '<!doctype html><head>' + meta + '</head>' + html;
}

/* Inline local <link>/<script src> resources into index.html so multi-file
   apps render inside a srcdoc sandbox (no same-origin, no server to fetch from).
   Only same-bundle text resources are inlined; external URLs are left as-is
   (the CSP blocks them anyway). Mirrored in viewer.html. */
const LOCAL_RE = /^(?!https?:\/\/|\/\/|data:|blob:|mailto:|#)/i;
function fileMap(files) {
  const m = new Map();
  for (const f of files) m.set(String(f.path).replace(/\\/g, '/').replace(/^\.?\//, ''), f.content);
  return m;
}
export function inlineApp(files) {
  const m = fileMap(files);
  let html = m.get('index.html') || [...m.values()][0] || '<!doctype html><p>no index.html</p>';
  const lookup = (href) => m.get(href.replace(/^\.?\//, '').split(/[?#]/)[0]);
  // <link rel="stylesheet" href="local.css"> -> <style>…</style>
  html = html.replace(/<link\b[^>]*?>/gi, (tag) => {
    if (!/rel\s*=\s*["']?stylesheet/i.test(tag)) return tag;
    const hm = tag.match(/href\s*=\s*["']([^"']+)["']/i);
    if (!hm || !LOCAL_RE.test(hm[1])) return tag;
    const css = lookup(hm[1]);
    return css != null ? `<style>\n${css}\n</style>` : tag;
  });
  // <script src="local.js"></script> -> <script>…</script>
  html = html.replace(/<script\b([^>]*?)\bsrc\s*=\s*["']([^"']+)["']([^>]*)><\/script>/gi, (tag, pre, src, post) => {
    if (!LOCAL_RE.test(src)) return tag;
    const js = lookup(src);
    if (js == null) return tag;
    const keepType = /type\s*=\s*["']module["']/i.test(pre + post);
    return `<script${keepType ? ' type="module"' : ''}>\n${js}\n</script>`;
  });
  return html;
}

function previewHtml(spec) {
  return withCSP(inlineApp(spec.files));
}

/* Starter templates — categorized, with detailed prompts that steer the LLM
   toward a complete single-page app. Clicking one fills the prompt box. */
const TEMPLATES = [
  { label: 'DeFi dashboard', category: 'data', prompt: 'A DeFi portfolio dashboard: token balance cards with 24h change, an allocation donut chart, a sortable positions table, and a simple line chart of total value. Drive balances from editable portfolio records entered by the user, use a dark theme, and clean typography. Single self-contained HTML file with inline CSS/JS (no external libraries).' },
  { label: 'NFT mint page', category: 'art', prompt: 'An NFT collection mint page: hero with a collection artwork panel, live mint counter connected to component state, quantity stepper, a prominent Mint button with an interactive wallet status, rarity/traits preview grid, and a roadmap section. Polished web3 aesthetic, responsive, single self-contained HTML file with inline CSS/JS.' },
  { label: 'DAO vote tool', category: 'tool', prompt: 'A DAO governance UI: list of proposals each with title, status (active/passed/failed), vote tallies as For/Against bars, quorum indicator, and Vote For / Vote Against buttons that update proposal records client-side. Include a "Create proposal" modal. Clean governance aesthetic, single self-contained HTML file with inline CSS/JS.' },
  { label: 'Arcade game', category: 'game', prompt: 'A small canvas arcade game (e.g. asteroid dodger or breakout) with start/pause, score, lives, increasing difficulty, keyboard + touch controls, and a game-over screen with restart. 60fps requestAnimationFrame loop. Single self-contained HTML file with inline CSS/JS, no assets.' },
  { label: 'Product landing', category: 'tool', prompt: 'A modern SaaS product landing page: sticky nav, hero with headline + CTA, three feature cards with icons, a pricing table (3 tiers), a testimonial, and a footer. Smooth scroll, subtle entrance animations, responsive, distinctive typography. Single self-contained HTML file with inline CSS/JS.' },
  { label: 'Data visualizer', category: 'data', prompt: 'An interactive data visualizer: paste or import CSV/JSON, then render a bar chart and a line chart with hover tooltips and a metric selector dropdown. Pure SVG/canvas (no chart libraries), dark theme, responsive. Single self-contained HTML file with inline CSS/JS.' },
];

/* ============================================================
   View render
   ============================================================ */
export function renderPlaygroundView() {
  const root = $('view-playground');
  if (!root || root.dataset.built) return;
  root.dataset.built = '1';
  root.innerHTML = `
    <div class="view-head">
      <h1>Build an app — prove it's yours</h1>
      <p><b>Describe an app, an AI builds it live, you publish it to Walrus + Sui.</b>
      Every published app carries <b>verifiable provenance</b> — who built it, the exact content hash,
      and unfakeable on-chain visits, stars and a remix lineage. The gallery below is read live from the chain.
      <span class="pg-dim">(Repos, PRs and releases under <b>Dashboard</b> are the verifiable foundation that makes these numbers trustworthy.)</span></p>
    </div>

    <div class="pg-split">
      <div class="pg-chat">
        <div class="pg-settings-bar">
          <span class="pg-keystate" id="pgKeyState"></span>
          <button class="btn-ghost pg-mini" id="pgSettings">LLM settings</button>
        </div>
        <div class="pg-messages" id="pgMessages">
          <div class="pg-empty">
            <div class="pg-empty-k">// playground</div>
            <p class="pg-empty-lead">Describe an app in plain English — an AI builds it live, right here.</p>
            <ol class="pg-empty-steps">
              <li><span>1</span><div><b>Describe</b> — type below, or pick an example <span class="pg-dim">↓</span></div></li>
              <li><span>2</span><div><b>Build</b> — the AI generates a runnable app <kbd>⌘↵</kbd></div></li>
              <li><span>3</span><div><b>Publish</b> — ship it to Walrus + Sui with verifiable provenance</div></li>
            </ol>
            <p class="pg-empty-note">Every published app gets an unfakeable on-chain record — author, content hash, visits, stars and remix lineage.</p>
          </div>
        </div>
        <div class="pg-composer">
          <textarea id="pgInput" rows="2" placeholder="A pomodoro timer with an animated countdown ring…"></textarea>
          <button class="btn-primary" id="pgSend">Build ⌘↵</button>
        </div>
        <div class="pg-examples" id="pgExamples"></div>
      </div>

      <div class="pg-preview">
        <div class="pg-frame-bar">
          <span class="pg-dot"></span><span class="pg-dot"></span><span class="pg-dot"></span>
          <span class="pg-frame-title" id="pgPreviewTitle">live preview</span>
          <select class="pg-mini" id="pgStorage" title="where to store the app bytes on Walrus">
            <option value="free">Free testnet epochs</option>
            <option value="paid">Paid · you own it (renewable)</option>
          </select>
          <select class="pg-mini" id="pgEpochs" title="how many Walrus storage epochs to pay for" style="display:none">
            <option value="10">10 epochs</option>
            <option value="50" selected>50 epochs</option>
            <option value="200">200 epochs</option>
          </select>
          ${CFG.privacyRegistry ? `<label class="pg-mini" title="encrypt the app with Seal — only you (the builder) can open it" style="display:flex;align-items:center;gap:5px;cursor:pointer">
            <input type="checkbox" id="pgPrivate" style="margin:0"> Private
          </label>` : ''}
          <button class="btn-primary pg-mini" id="pgPublish" disabled>Publish</button>
        </div>
        <div class="pg-frame-wrap">
          <iframe id="pgPreview" class="pg-preview-frame" sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe>
          <div class="pg-preview-empty" id="pgPreviewEmpty"><b>live preview</b>Your app renders here after <b>Build</b>.</div>
        </div>
      </div>
    </div>

    <div class="pg-gallery-head">
      <h2>Gallery</h2>
      <div class="pg-filters" id="pgFilters">
        <button class="pg-pill on" data-sort="newest">Newest</button>
        <button class="pg-pill" data-sort="trending">Trending</button>
        <button class="pg-pill" data-sort="featured">★ Featured</button>
        <button class="pg-pill" data-sort="views">Most Viewed</button>
        <button class="pg-pill" data-sort="stars">Most Stars</button>
        <input class="pg-search" id="pgSearch" placeholder="Search apps…">
      </div>
      <div class="pg-cats" id="pgCats">
        ${['all', 'game', 'tool', 'art', 'data', 'social', 'other'].map((c) =>
          `<button class="pg-cat-pill${c === 'all' ? ' on' : ''}" data-cat="${c}">${c}</button>`).join('')}
      </div>
    </div>
    <div class="card-grid" id="pgGallery"></div>

    <div class="pg-gallery-head">
      <h2>App bounties 💰</h2>
      ${CFG.appBounties ? '<button class="btn-ghost pg-mini" id="pgPostBounty" title="escrow SUI for an app you want built">+ Post a bounty</button>' : ''}
    </div>
    <p class="pg-dim" style="margin:-6px 0 10px">Escrow SUI for an app you want built — a builder (human or agent) publishes it, you award the bounty to their app on-chain.</p>
    <div class="card-grid" id="pgBounties"></div>
  `;

  $('pgExamples').innerHTML = TEMPLATES.map((t) =>
    `<button class="pg-example" data-prompt="${escapeHtml(t.prompt)}" title="${escapeHtml(t.category)} template">${escapeHtml(t.label)}</button>`).join('');
  refreshKeyState();
}

function refreshKeyState() {
  const el = $('pgKeyState'); if (!el) return;
  el.innerHTML = llm.apiKey || llm.mode === 'proxy'
    ? `<span class="pg-ok">● LLM ready</span> · ${escapeHtml(MODELS.find((m) => m[0] === llm.model)?.[1] || llm.model)}`
    : `<span class="pg-warn">● no API key</span> — set one to build`;
}

function pushMsg(role, html) {
  const m = $('pgMessages'); if (!m) return;
  const empty = m.querySelector('.pg-empty'); if (empty) empty.remove(); // first message clears the intro guide
  const div = document.createElement('div');
  div.className = `pg-msg ${role}`;
  div.innerHTML = html;
  m.appendChild(div); m.scrollTop = m.scrollHeight;
  return div;
}

function setPreview(spec) {
  const f = $('pgPreview'); if (!f) return;
  f.srcdoc = previewHtml(spec);
  // Show the file set for multi-file apps (local <link>/<script> are inlined into the
  // preview; all files are stored in the Walrus archive and re-served by the viewer/portal).
  const files = (spec.files || []).map((x) => x.path);
  $('pgPreviewTitle').textContent = files.length > 1 ? `${spec.name} · ${files.length} files: ${files.join(', ')}` : spec.name;
  $('pgPublish').disabled = false;
  const empty = $('pgPreviewEmpty'); if (empty) empty.style.display = 'none'; // app is showing now
}

if (typeof window !== 'undefined') {
  window.__wfTestSetApp = (spec) => {
    pg.current = spec;
    pg.basePrompt = spec.prompt || 'test';
    setPreview(spec);
  };
}

/* ============================================================
   Build flow
   ============================================================ */
async function build(promptText) {
  if (pg.busy) return;
  if (!promptText.trim()) return;
  if (!llm.apiKey && llm.mode === 'byok') { openSettings(); return; }
  if (llm.mode === 'proxy' && !(llm.proxyUrl || CFG.llmProxyUrl)) { toast('Set the proxy URL in LLM settings', { kind: 'error' }); openSettings(); return; }
  pg.busy = true;
  markFlow('build');
  const sendBtn = $('pgSend'); sendBtn.disabled = true; sendBtn.textContent = 'Building…';
  pushMsg('user', escapeHtml(promptText));
  const thinking = pushMsg('bot', '<span class="pg-typing">building your app…</span>');
  pg.messages.push({ role: 'user', content: promptText });
  try {
    const { text } = await callLLM(pg.messages);
    pg.messages.push({ role: 'assistant', content: text });
    const spec = parseAppSpec(text);
    // The app's defining prompt = the FIRST instruction of this session (not frozen to a
    // preloaded remix/update parent's prompt). Set once; iterations keep it.
    if (!pg.basePrompt) pg.basePrompt = promptText;
    spec.prompt = pg.basePrompt;
    pg.current = spec;
    try { sessionStorage.removeItem(PG_DRAFT_KEY); } catch {}
    thinking.innerHTML = `Built <b>${escapeHtml(spec.name)}</b> · <span class="pg-cat">${spec.category}</span>. Live preview ready → iterate or Publish.`;
    setPreview(spec);
  } catch (e) {
    thinking.innerHTML = `<span class="pg-err">${escapeHtml(String(e.message || e))}</span>`;
    toast('Build failed: ' + (e.message || e), { kind: 'error' });
  } finally {
    markFlow(null);
    pg.busy = false; sendBtn.disabled = false; sendBtn.textContent = 'Build ⌘↵';
  }
}

/* ============================================================
   Publish — playground::publish_app
   ============================================================ */
const MAX_APP_BYTES = 512 * 1024; // 512KB cap per app (keeps Walrus uploads small/fast)

/* Paid Walrus upload via the @mysten/walrus SDK: the wallet pays for `epochs` of
   storage and OWNS the resulting blobs, so they don't vanish like free-publisher
   blobs and can be renewed. blobIds are content-addressed (computed via encodeBlob),
   so re-uploading identical bytes later yields the same id — that's how renewApp works.
   Returns Map<identifier, blobId>. */
async function walrusPutSdk(files, epochs) {
  const { WalrusClient, WalrusFile } = await import('https://esm.sh/@mysten/walrus@1.1.7?external=@mysten/sui');
  const walrus = new WalrusClient({
    network: CFG.network,
    suiClient: sui,
    uploadRelay: CFG.network === 'testnet'
      ? { host: 'https://upload-relay.testnet.walrus.space', sendTip: { max: 1000 } }
      : undefined,
  });
  const ids = new Map();
  const wfiles = [];
  for (const f of files) {
    const enc = await walrus.encodeBlob(f.bytes); // content-addressed blobId
    ids.set(f.identifier, enc.blobId);
    wfiles.push(WalrusFile.from({ contents: f.bytes, identifier: f.identifier }));
  }
  const flow = walrus.writeFilesFlow({ files: wfiles });
  await flow.encode();
  const owner = STATE.wallet.address;
  const reg = await signAndRun(flow.register({ epochs, owner, deletable: true }), `Storage reserved · ${epochs} epochs`);
  if (!reg) throw new Error('storage registration cancelled');
  await flow.upload({ digest: reg.digest });
  const cert = await signAndRun(flow.certify(), 'App stored on Walrus (you own it)');
  if (!cert) throw new Error('certification cancelled');
  return ids;
}

async function publish() {
  if (!pg.current) return;
  if (!STATE.wallet) { toast('Connect a wallet to publish', { kind: 'error' }); return; }
  if (!CFG.builderBoard) { toast('Playground not fully deployed on this network', { kind: 'error' }); return; }
  const spec = pg.current;
  // size guard — refuse oversized apps before paying for a Walrus upload
  const totalBytes = spec.files.reduce((n, f) => n + new TextEncoder().encode(f.content).length, 0);
  if (totalBytes > MAX_APP_BYTES) {
    toast(`App too large (${(totalBytes / 1024).toFixed(0)}KB > ${MAX_APP_BYTES / 1024}KB). Ask the AI to simplify it.`, { kind: 'error' });
    return;
  }
  const btn = $('pgPublish'); btn.disabled = true; btn.textContent = 'Publishing…';
  pg.busy = true;
  markFlow('publish');
  try {
    const nowEpochMs = Date.now();
    const { archive, manifest, treeHash } = await buildAppSnapshot(
      spec.files,
      { name: spec.name, prompt: spec.prompt, model: llm.model, category: spec.category, parent: pg.remixParent, nowEpochMs },
    );
    const mode = $('pgStorage')?.value || 'free';
    // Private apps take a dedicated two-step path (encrypt under the new app id).
    if (!!$('pgPrivate')?.checked && CFG.privacyRegistry && !pg.updateTarget && !pg.remixParent) {
      await publishPrivate(spec, archive, manifest, treeHash, mode);
      return;
    }
    let archiveBlob, manifestBlob;
    if (mode === 'paid') {
      // You pay for + own the storage (renewable). Both blobs in one register+certify.
      // manifest omits archiveBlob (the gallery/viewer read archive_blob from chain).
      const epochs = Number($('pgEpochs')?.value || 50);
      const ids = await walrusPutSdk([
        { bytes: archive, identifier: 'archive' },
        { bytes: new TextEncoder().encode(JSON.stringify(manifest)), identifier: 'manifest' },
      ], epochs);
      archiveBlob = ids.get('archive');
      manifestBlob = ids.get('manifest');
    } else {
      archiveBlob = await walrusPut(archive);
      manifestBlob = await walrusPut(JSON.stringify({ ...manifest, archiveBlob }));
    }

    const tx = new Transaction();
    if (pg.updateTarget) {
      // Versioning: re-anchor manifest/archive/treeHash on the SAME app object.
      // update_app_v2 emits AppUpdatedV2 with the version's blob ids so the history
      // can fetch/diff/remix any past version. Old blobs persist in Walrus.
      pgCall(tx, 'playground::update_app_v2', [
        tx.object(pg.updateTarget),
        tx.pure.string(manifestBlob),
        tx.pure.string(archiveBlob),
        tx.pure.string(treeHash),
        tx.object('0x6'),
      ]);
      const r = await signAndRun(tx, 'App updated');
      if (r) {
        toast('New version published ✓ — same app, fresh content hash', { kind: 'success', tx: r.digest });
        pg.updateTarget = null; pg.basePrompt = null;
        await loadGallery();
      } else {
        // Signature rejected/failed — clear the update target so a later, unrelated
        // Publish doesn't silently overwrite this app.
        pg.updateTarget = null;
        toast('Update cancelled', { kind: 'info', timeout: 2000 });
      }
      return;
    }
    const head = [
      tx.pure.string(spec.name),
      tx.pure.string(spec.prompt.slice(0, 300)),
      tx.pure.string(manifestBlob),
      tx.pure.string(archiveBlob),
      tx.pure.string(treeHash),
      tx.pure.string(spec.category),
    ];
    if (pg.remixParent) {
      // Paid fork: if the parent builder set a price, pay it first (in the SAME tx)
      // so the licence payment and the remix are atomic. pay_to_fork sends the
      // builder price−fee, the fee to the Treasury, and refunds any excess.
      if (pg.remixForkPrice > 0 && CFG.forkRegistry && CFG.treasury) {
        const [forkPay] = tx.splitCoins(tx.gas, [tx.pure.u64(pg.remixForkPrice)]);
        pgCall(tx, 'playground::pay_to_fork', [tx.object(CFG.forkRegistry), tx.object(pg.remixParent), tx.object(CFG.treasury), forkPay]);
      }
      // Remix: pass the parent app by reference so the contract credits the parent
      // builder's on-chain reputation (remixes_received). Records lineage on-chain.
      pgCall(tx, 'playground::publish_remix_v3', [
        ...head,
        tx.object(pg.remixParent),
        tx.object(CFG.builderBoard),
        tx.object('0x6'),
      ]);
    } else {
      const parentNone = tx.moveCall({ target: '0x1::option::none', typeArguments: ['0x2::object::ID'], arguments: [] });
      pgCall(tx, 'playground::publish_app_v2', [
        ...head,
        parentNone,
        tx.object(CFG.builderBoard),
        tx.object('0x6'),
      ]);
    }
    const r = await signAndRunCreated(tx, 'App published', '::playground::PublishedApp');
    if (r) {
      toast('Published to the gallery ✓', { kind: 'success', tx: r.digest });
      pg.remixParent = null; pg.remixForkPrice = 0; pg.updateTarget = null; pg.basePrompt = null;
      await loadGallery();
    }
  } catch (e) {
    toast('Publish failed: ' + (e.message || e), { kind: 'error' });
  } finally {
    pg.busy = false;
    markFlow(null);
    btn.disabled = false; btn.textContent = 'Publish';
  }
}

/* Publish a PRIVATE app. Two steps, because the Seal identity must be the app's
   on-chain object id — which only exists after publish. Step 1 publishes the public
   metadata with an EMPTY archive (no secret stored yet). Step 2 encrypts the archive
   under the new app id, stores the ciphertext on Walrus, re-anchors it via update_app,
   and marks the app private. Afterwards only the builder can decrypt it (on-chain
   policy seal_approve_app_owner). */
async function publishPrivate(spec, archive, manifest, treeHash, mode) {
  const { sealEncrypt } = await import('./seal.js');
  const epochs = Number($('pgEpochs')?.value || 50);
  const putManifest = () => mode === 'paid'
    ? walrusPutSdk([{ bytes: new TextEncoder().encode(JSON.stringify(manifest)), identifier: 'manifest' }], epochs).then((m) => m.get('manifest'))
    : walrusPut(JSON.stringify(manifest));

  // Step 1 — publish public metadata with an empty bootstrap archive blob.
  const manifestBlob = await putManifest();
  const tx1 = new Transaction();
  const none = tx1.moveCall({ target: '0x1::option::none', typeArguments: ['0x2::object::ID'], arguments: [] });
  pgCall(tx1, 'playground::publish_app_v2', [
    tx1.pure.string(spec.name), tx1.pure.string(spec.prompt.slice(0, 300)),
    tx1.pure.string(manifestBlob), tx1.pure.string(''), tx1.pure.string(treeHash),
    tx1.pure.string(spec.category), none, tx1.object(CFG.builderBoard), tx1.object('0x6'),
  ]);
  const r1 = await signAndRunCreated(tx1, 'Private app created', '::playground::PublishedApp');
  const appId = r1?.created?.[0];
  if (!appId) { toast('Publish cancelled', { kind: 'info', timeout: 2000 }); return; }

  // Step 2 — encrypt the archive under the new app id, store it, re-anchor + mark private.
  toast('Encrypting with Seal (sign to authorize)…', { kind: 'info', timeout: 2500 });
  const enc = await sealEncrypt(archive, appId);
  const encBlob = mode === 'paid'
    ? (await walrusPutSdk([{ bytes: enc, identifier: 'archive' }], epochs)).get('archive')
    : await walrusPut(enc);
  const tx2 = new Transaction();
  pgCall(tx2, 'playground::update_app', [
    tx2.object(appId), tx2.pure.string(manifestBlob), tx2.pure.string(encBlob), tx2.pure.string(treeHash), tx2.object('0x6'),
  ]);
  pgCall(tx2, 'playground::set_private', [tx2.object(CFG.privacyRegistry), tx2.object(appId), tx2.pure.bool(true)]);
  const r2 = await signAndRun(tx2, 'App encrypted + marked private');
  if (r2) {
    toast('Private app published — only you can open it', { kind: 'success', tx: r2.digest });
    pg.basePrompt = null;
    await loadGallery();
  } else {
    toast('Encryption step cancelled — the app exists but has no content yet; Update it later', { kind: 'info' });
  }
}

/* ============================================================
   Gallery — reads playground::AppPublished -> PublishedApp
   ============================================================ */
export async function loadGallery() {
  const grid = $('pgGallery'); if (!grid) return;
  grid.innerHTML = '<div class="empty-state">Loading apps…</div>';
  try {
    // cursor-paginate AppPublished events (up to ~500 apps) so the gallery is not
    // capped at one page like a fixed limit would be.
    const ids = [];
    let cursor = null; let pages = 0;
    do {
      const ev = await withTimeout(sui.queryEvents({
        query: { MoveEventType: `${PG_EVENT}::playground::AppPublished` },
        cursor, limit: 50, order: 'descending',
      }), 15000, 'AppPublished events');
      for (const e of ev.data) { const id = e.parsedJson?.app_id; if (id) ids.push(id); }
      cursor = ev.nextCursor;
      if (!ev.hasNextPage) break;
    } while (cursor && ++pages < 10);
    if (!ids.length) { grid.innerHTML = emptyGallery(); return; }
    const objs = await multiGetChunked(ids, { showContent: true });
    pg.gallery = objs.map((o) => {
      const f = o.data?.content?.fields; if (!f) return null;
      return {
        id: o.data.objectId, builder: f.builder || '', name: f.name || '', prompt: f.prompt || '',
        manifestBlob: f.manifest_blob, archiveBlob: f.archive_blob, treeHash: f.tree_hash,
        parent: (f.parent?.fields?.vec?.[0] ?? f.parent?.vec?.[0] ?? (typeof f.parent === 'string' ? f.parent : null)), category: f.category || 'other',
        visits: Number(f.visits || 0), stars: Number(f.stars || 0), tips: Number(f.tips_total || 0),
        createdAt: Number(f.created_at_ms || 0),
      };
    }).filter(Boolean);
    await loadModeration();
    await loadForkPrices();
    await loadPrivacy();
    await loadWorkspaceMembers();
    await loadHandles();
    renderGallery();
    loadBounties().then(renderBounties);
    [...new Set(pg.gallery.map((a) => a.builder))].forEach((a) => resolveName(a).then(() => renderGallery()));
  } catch (e) {
    grid.innerHTML = `<div class="empty-state">Gallery unavailable: ${escapeHtml(String(e.message || e))}<br><span class="pg-dim">(publish_app lands on-chain once the playground module is deployed)</span></div>`;
    toast('Gallery did not sync: ' + decodeSuiError(e).message, { kind: 'error', action: { label: 'Retry', onClick: loadGallery } });
  }
}

/* Community moderation: read AppFlagged/AppHidden events (under PG_EVENT, same as
   AppPublished) and attach flagCount + hidden to each gallery app. Hidden apps and
   apps with >= FLAG_HIDE_THRESHOLD flags are filtered out of the gallery. */
const FLAG_HIDE_THRESHOLD = 3;
async function loadModeration() {
  const flags = new Map();   // app_id -> latest flag count
  const hidden = new Map();  // app_id -> latest hidden bool
  try {
    for (const e of await pgEvents('AppFlagged', { order: 'ascending' })) { const j = e.parsedJson; if (j?.app_id) flags.set(j.app_id, Number(j.flags || 0)); }
    for (const e of await pgEvents('AppHidden', { order: 'ascending' })) { const j = e.parsedJson; if (j?.app_id) hidden.set(j.app_id, !!j.hidden); }
  } catch (e) { toast('Moderation status did not sync: ' + decodeSuiError(e).message, { kind: 'error' }); }
  for (const a of pg.gallery) {
    a.flags = flags.get(a.id) || 0;
    a.hidden = hidden.get(a.id) || false;
  }
}

/* Paid fork: read ForkPriceSet events (ascending, latest wins) and attach the
   builder-set fork price (MIST) to each app. price 0 / absent = free to remix. */
async function loadForkPrices() {
  const prices = new Map();
  try {
    for (const e of await pgEvents('ForkPriceSet', { order: 'ascending' })) {
      const j = e.parsedJson; if (j?.app_id) prices.set(j.app_id, Number(j.price || 0));
    }
  } catch (e) { toast('Fork prices did not sync: ' + decodeSuiError(e).message, { kind: 'error' }); }
  for (const a of pg.gallery) a.forkPrice = prices.get(a.id) || 0;
}

/* Private apps: read AppPrivacySet events (ascending, latest wins) and attach the
   private flag to each app. A private app's archive is Seal-encrypted; only the
   builder can decrypt it (on-chain policy seal_approve_app_owner). */
async function loadPrivacy() {
  const priv = new Map();
  try {
    for (const e of await pgEvents('AppPrivacySet', { order: 'ascending' })) {
      const j = e.parsedJson; if (j?.app_id) priv.set(j.app_id, !!j.private);
    }
  } catch (e) { toast('Private app status did not sync: ' + decodeSuiError(e).message, { kind: 'error' }); }
  for (const a of pg.gallery) a.private = priv.get(a.id) || false;
}

/* Team-private workspaces: additive v2 privacy. Without a deployed
   WorkspaceRegistry, private apps stay owner-only and this resolves empty. */
async function loadWorkspaceMembers() {
  const members = new Map();
  try {
    for (const e of await pgEvents('WorkspaceMemberInvited', { limit: 500, order: 'ascending' })) {
      const j = e.parsedJson; if (!j?.app_id || !j.member) continue;
      if (!members.has(j.app_id)) members.set(j.app_id, new Set());
      members.get(j.app_id).add(String(j.member));
    }
    for (const e of await pgEvents('WorkspaceMemberRevoked', { limit: 500, order: 'ascending' })) {
      const j = e.parsedJson; if (!j?.app_id || !j.member) continue;
      members.get(j.app_id)?.delete(String(j.member));
    }
  } catch (e) { toast('Workspace members did not sync: ' + decodeSuiError(e).message, { kind: 'error' }); }
  pg.workspaces = members;
  const me = STATE.wallet?.address || '';
  for (const a of pg.gallery) {
    const list = [...(members.get(a.id) || new Set())];
    a.workspaceMembers = list;
    a.workspaceCount = list.length;
    a.allowed = !!me && (me === a.builder || list.includes(me));
  }
}

function emptyGallery() {
  return '<div class="empty-state">No apps yet. Build one above and hit Publish — it’ll be the first in the gallery.</div>';
}

function sortGallery(apps) {
  const s = pg.filter;
  const a = [...apps];
  if (s === 'views') a.sort((x, y) => y.visits - x.visits);
  else if (s === 'stars') a.sort((x, y) => y.stars - x.stars);
  else if (s === 'trending') a.sort((x, y) => (y.stars * 3 + y.visits) - (x.stars * 3 + x.visits));
  else if (s === 'featured') a.sort((x, y) => (y.stars * 3 + (y.tips || 0) + y.visits) - (x.stars * 3 + (x.tips || 0) + x.visits));
  else a.sort((x, y) => y.createdAt - x.createdAt);
  return a;
}

export function renderGallery() {
  const grid = $('pgGallery'); if (!grid) return;
  let apps = pg.gallery;
  // Moderation: drop builder-hidden apps and apps the community flagged past the threshold.
  apps = apps.filter((a) => !a.hidden && (a.flags || 0) < FLAG_HIDE_THRESHOLD);
  if (pg.cat && pg.cat !== 'all') apps = apps.filter((a) => a.category === pg.cat);
  if (pg.search) {
    const q = pg.search.toLowerCase();
    apps = apps.filter((a) => a.name.toLowerCase().includes(q) || a.prompt.toLowerCase().includes(q) || a.category.includes(q));
  }
  apps = sortGallery(apps);
  if (!apps.length) { grid.innerHTML = emptyGallery(); return; }
  grid.innerHTML = apps.map((a) => `
    <div class="pg-card" data-app="${a.id}">
      <div class="pg-card-head">
        <span class="pg-card-name" title="${escapeHtml(a.name)}">${escapeHtml(a.name)}</span>
        <span class="pg-cat">${escapeHtml(a.category)}</span>
      </div>
      <div class="pg-prompt" title="${escapeHtml(a.prompt)}">${escapeHtml(a.prompt)}</div>
      <div class="pg-card-meta">
        <span class="pg-by">by <button class="pg-builder" data-act="profile" data-builder="${a.builder}">${escapeHtml(displayName(a.builder))}</button></span>
        ${a.parent ? '<span class="pg-lineage" title="remixed from another app">⑂ remix</span>' : ''}
        ${a.forkPrice ? `<span class="pg-lineage" title="forking this app costs ${suiAmount(a.forkPrice)} SUI, paid to the builder">⑂ ${suiAmount(a.forkPrice)} SUI to fork</span>` : ''}
        ${a.private ? '<span class="pg-lineage" title="Seal-encrypted — only the builder can open it">private</span>' : ''}
      </div>
      <div class="pg-stats">
        <span class="pg-stat" title="on-chain visits">▶ ${a.visits}</span>
        <span class="pg-stat" title="on-chain stars">★ ${a.stars}</span>
        ${a.tips ? `<span class="pg-stat" title="tips received">◈ ${suiAmount(a.tips)}</span>` : ''}
      </div>
      <div class="pg-walrus" data-walrus="${a.id}">
        <span>Walrus: checking</span>
        <span>${SETTINGS.portalUrl ? 'portal configured' : 'portal optional'}</span>
      </div>
      <div class="pg-card-actions">
        <button class="btn-primary pg-mini" data-act="open" data-app="${a.id}">Open ↗</button>
        <button class="btn-ghost pg-mini" data-act="share" data-app="${a.id}" title="copy a shareable, verifiable link to this app">Share</button>
        <button class="btn-ghost pg-mini" data-act="history" data-app="${a.id}" title="version history (on-chain AppUpdated events)">History</button>
        <button class="btn-ghost pg-mini" data-act="remix" data-app="${a.id}" title="${a.forkPrice ? `fork costs ${suiAmount(a.forkPrice)} SUI (paid to the builder)` : 'remix this app'}">${a.forkPrice ? `Fork ◈ ${suiAmount(a.forkPrice)}` : 'Remix'}</button>
        <button class="btn-ghost pg-mini" data-act="star" data-app="${a.id}">★</button>
        <button class="btn-ghost pg-mini" data-act="tip" data-app="${a.id}">◈ Tip</button>
        <button class="btn-ghost pg-mini" data-act="site" data-app="${a.id}" title="mint a real on-chain Walrus Site for this app">Site</button>
        ${STATE.wallet && STATE.wallet.address === a.builder
          ? `${CFG.nameRegistry ? `<button class="btn-ghost pg-mini" data-act="edit" data-app="${a.id}" title="publish a new version of your app">Update</button>` : ''}
             ${CFG.forkRegistry ? `<button class="btn-ghost pg-mini" data-act="price" data-app="${a.id}" title="charge a fee to fork your app (paid to you, minus a small protocol fee)">${a.forkPrice ? 'Price ◈ ' + suiAmount(a.forkPrice) : 'Fork price'}</button>` : ''}
             <button class="btn-ghost pg-mini" data-act="renew" data-app="${a.id}" title="re-pin this app's bytes so they don't expire (you pay WAL)">Renew</button>
             <button class="btn-ghost pg-mini" data-act="hide" data-app="${a.id}" title="hide your app from the gallery">Hide</button>`
          : `<button class="btn-ghost pg-mini" data-act="flag" data-app="${a.id}" title="report this app">Flag${a.flags ? ' ' + a.flags : ''}</button>`}
        <a class="pg-verify" href="${explorerObject(a.id)}" target="_blank" rel="noreferrer" title="verifiable on-chain record">✓ on-chain</a>
      </div>
    </div>`).join('');
  renderWorkspaceActions(grid, apps);
  renderWalrusStatuses(grid, apps);
}

async function blobReachable(blobId) {
  if (!blobId) return false;
  try {
    let res = await fetch(blobUrl(blobId), { method: 'HEAD' });
    if (res.ok) return true;
    res = await fetch(blobUrl(blobId), { headers: { range: 'bytes=0-16' } });
    return res.ok;
  } catch {
    return false;
  }
}

function renderWalrusStatuses(grid, apps) {
  for (const app of apps) {
    const el = grid.querySelector(`[data-walrus="${app.id}"]`);
    if (!el) continue;
    Promise.all([blobReachable(app.manifestBlob), blobReachable(app.archiveBlob)]).then(([manifestOk, archiveOk]) => {
      const siteObject = localStorage.getItem('wf.site.' + app.id);
      const status = manifestOk && archiveOk ? 'available' : manifestOk || archiveOk ? 'partial' : 'unavailable';
      el.classList.toggle('bad', status !== 'available');
      el.innerHTML =
        '<span>Walrus: ' + status + '</span>' +
        '<span>manifest ' + (manifestOk ? 'ok' : 'missing') + '</span>' +
        '<span>archive ' + (archiveOk ? 'ok' : 'missing') + '</span>' +
        (siteObject ? '<a class="link mono" target="_blank" rel="noreferrer" href="' + explorerObject(siteObject) + '">site ' + short(siteObject) + '</a>' : '<span>site optional</span>');
    }).catch(() => {
      el.classList.add('bad');
      el.innerHTML = '<span>Walrus: status unavailable</span><span>retry refresh</span>';
    });
  }
}

function renderWorkspaceActions(grid, apps) {
  for (const a of apps) {
    const card = grid.querySelector(`.pg-card[data-app="${a.id}"]`);
    if (!card) continue;
    if (a.private && a.workspaceCount) {
      const meta = card.querySelector('.pg-card-meta');
      const badge = document.createElement('span');
      badge.className = 'pg-lineage';
      badge.title = 'Seal-encrypted - builder and allowlisted collaborators can open it';
      badge.textContent = `team private (${a.workspaceCount})`;
      meta?.appendChild(badge);
    }
    if (!CFG.workspaceRegistry || !STATE.wallet || !a.private || STATE.wallet.address !== a.builder) continue;
    const actions = card.querySelector('.pg-card-actions');
    if (!actions) continue;
    const verify = actions.querySelector('.pg-verify');
    for (const [act, label, title] of [
      ['invite-member', 'Invite', 'Allow a collaborator to decrypt this private app'],
      ['revoke-member', 'Revoke', 'Revoke a collaborator from this private app'],
    ]) {
      const b = document.createElement('button');
      b.className = 'btn-ghost pg-mini';
      b.dataset.act = act;
      b.dataset.app = a.id;
      b.title = title;
      b.textContent = label;
      actions.insertBefore(b, verify || null);
    }
  }
}

/* viewer URL for a published app (Phase 3 viewer-route) */
export function appViewerUrl(app) {
  // Prefer the public portal when configured — it serves clean URLs + Open Graph
  // share cards (link previews). Falls back to the static viewer page otherwise.
  if (SETTINGS.portalUrl) {
    return `${SETTINGS.portalUrl.replace(/\/$/, '')}/app/${app.id}${CFG.network === 'mainnet' ? '?net=mainnet' : ''}`;
  }
  const base = location.origin + location.pathname.replace(/[^/]*$/, '');
  return `${base}viewer.html?app=${app.id}&net=${CFG.network}`;
}

function appById(id) { return pg.gallery.find((a) => a.id === id); }

// Version snapshots keyed by app id, captured for diff/view/remix actions.
const _histVersions = new Map();

/** Version history: merges v1 AppUpdated (tree hash only) and v2 AppUpdatedV2
    (with blob ids). v2 versions can be viewed, diffed, and remixed. */
async function showAppHistory(id) {
  const app = appById(id);
  openModal({ title: `Version history${app ? ' — ' + escapeHtml(app.name) : ''}`, bodyHtml: '<div id="pgHist" class="verify-steps">loading…</div>' });
  try {
    const [v1ev, v2ev] = await Promise.all([
      pgEvents('AppUpdated', { limit: 500, order: 'ascending' }),
      pgEvents('AppUpdatedV2', { limit: 500, order: 'ascending' }),
    ]);
    const updates = [
      ...v1ev.filter((e) => e.parsedJson?.app_id === id).map((e) => ({ treeHash: e.parsedJson.tree_hash, ts: Number(e.parsedJson.updated_at_ms) || 0, manifestBlob: null, archiveBlob: null })),
      ...v2ev.filter((e) => e.parsedJson?.app_id === id).map((e) => ({ treeHash: e.parsedJson.tree_hash, ts: Number(e.parsedJson.updated_at_ms) || 0, manifestBlob: e.parsedJson.manifest_blob, archiveBlob: e.parsedJson.archive_blob })),
    ].sort((a, b) => a.ts - b.ts);
    const rows = [{ v: 1, label: 'published', treeHash: app?.treeHash || '', ts: app?.createdAt || 0, manifestBlob: app?.manifestBlob, archiveBlob: app?.archiveBlob }];
    updates.forEach((u, i) => rows.push({ v: i + 2, label: 'updated', ...u }));
    _histVersions.set(id, rows);
    const host = $('pgHist'); if (!host) return;
    host.innerHTML = rows.slice().reverse().map((r, idx) => {
      const canDo = !!r.archiveBlob && !app?.private;
      const actions = canDo
        ? '<span class="hist-actions">' +
            '<button class="btn-ghost pg-mini" data-hist="view" data-app="' + id + '" data-v="' + r.v + '">View</button>' +
            (r.v !== rows.length ? '<button class="btn-ghost pg-mini" data-hist="diff" data-app="' + id + '" data-v="' + r.v + '">Diff vs latest</button>' : '') +
            '<button class="btn-ghost pg-mini" data-hist="remix" data-app="' + id + '" data-v="' + r.v + '">Remix this version</button>' +
          '</span>'
        : (app?.private ? '<span class="pg-dim">private</span>' : '<span class="pg-dim">legacy (no blob id)</span>');
      return '<div class="vstep ok"><span class="vmark">v' + r.v + (idx === 0 ? ' ★' : '') + '</span>' +
        '<span class="vlabel">' + r.label + (r.ts ? ' · ' + new Date(r.ts).toLocaleString() : '') + ' · <span class="mono">' + escapeHtml(short(r.treeHash || '—')) + '</span></span>' +
        actions + '</div>';
    }).join('') + (updates.length ? '' : '<p class="pg-dim">No updates yet — this is the original version.</p>');
    host.querySelectorAll('[data-hist]').forEach((b) => b.addEventListener('click', () => {
      const act = b.dataset.hist; const v = Number(b.dataset.v);
      if (act === 'view') viewVersion(id, v);
      else if (act === 'diff') diffVersion(id, v);
      else if (act === 'remix') remixVersion(id, v);
    }));
  } catch (e) {
    const host = $('pgHist'); if (host) host.innerHTML = '<p class="pg-warn">History unavailable: ' + escapeHtml(e.message || String(e)) + '</p>';
  }
}

function _histRow(id, v) { return (_histVersions.get(id) || []).find((r) => r.v === v); }

/** Fetch a version's index.html by its archive blob (public apps only). */
async function fetchVersionHtml(archiveBlob) {
  const html = await fetchAppHtml({ id: 'version', archiveBlob, private: false });
  return html;
}

/** Open a past version's rendered HTML in a new tab. */
async function viewVersion(id, v) {
  const row = _histRow(id, v); if (!row?.archiveBlob) return;
  toast('Loading version…', { kind: 'info', timeout: 1200 });
  try {
    const html = await fetchVersionHtml(row.archiveBlob);
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  } catch (e) { toast('View failed: ' + (e.message || e), { kind: 'error' }); }
}

/** Show a simple line-diff between a past version and the latest. */
async function diffVersion(id, v) {
  const rows = _histVersions.get(id) || []; const row = _histRow(id, v);
  const latest = rows[rows.length - 1];
  if (!row?.archiveBlob || !latest?.archiveBlob) return;
  openModal({ title: `Diff — v${v} vs v${latest.v}`, bodyHtml: '<div id="pgDiff" class="diff-body">computing…</div>' });
  try {
    const [oldH, newH] = await Promise.all([fetchVersionHtml(row.archiveBlob), fetchVersionHtml(latest.archiveBlob)]);
    const host = $('pgDiff'); if (!host) return;
    host.innerHTML = lineDiffHtml(oldH, newH);
  } catch (e) { const host = $('pgDiff'); if (host) host.innerHTML = '<p class="pg-warn">Diff failed: ' + escapeHtml(e.message || String(e)) + '</p>'; }
}

/** Minimal LCS-free line diff: marks lines present only in old (−) or new (+). */
function lineDiffHtml(oldText, newText) {
  const o = oldText.split('\n'), n = newText.split('\n');
  const oSet = new Set(o), nSet = new Set(n);
  const removed = o.filter((l) => !nSet.has(l)).length;
  const added = n.filter((l) => !oSet.has(l)).length;
  const merged = [];
  const seen = new Set();
  for (const l of o) if (!nSet.has(l) && !seen.has('-' + l)) { merged.push({ t: '-', l }); seen.add('-' + l); }
  for (const l of n) if (!oSet.has(l) && !seen.has('+' + l)) { merged.push({ t: '+', l }); seen.add('+' + l); }
  const body = merged.slice(0, 400).map((d) =>
    '<div class="diff-line ' + (d.t === '+' ? 'add' : 'del') + '"><span class="diff-sign">' + d.t + '</span>' + escapeHtml(d.l.slice(0, 300)) + '</div>').join('');
  return '<div class="diff-summary"><span class="diff-add">+' + added + '</span> <span class="diff-del">−' + removed + '</span> lines changed</div>' +
    (body || '<p class="pg-dim">No textual differences.</p>');
}

/** Load a past version into the editor as a remix (rollback-by-remix). */
async function remixVersion(id, v) {
  const app = appById(id); const row = _histRow(id, v); if (!row?.archiveBlob) return;
  toast('Loading version into editor…', { kind: 'info', timeout: 1500 });
  try {
    const html = await fetchVersionHtml(row.archiveBlob);
    closeModal();
    pg.updateTarget = null;
    pg.remixParent = id;
    pg.remixForkPrice = app?.forkPrice || 0;
    pg.basePrompt = app?.prompt || null;
    pg.messages = [
      { role: 'user', content: `Here is version v${v} of app "${app?.name || id}" to remix. The current index.html is:\n\n${html}\n\nWait for my next instruction.` },
      { role: 'assistant', content: 'Loaded that version. Tell me what to change and I will produce the updated app JSON.' },
    ];
    pg.current = { name: (app?.name || 'app') + '-v' + v, category: app?.category || 'other', prompt: app?.prompt || '', files: [{ path: 'index.html', content: html }] };
    setPreview(pg.current);
    $('pgMessages').innerHTML = '';
    pushMsg('bot', `Remixing <b>${escapeHtml(app?.name || id)} v${v}</b> — preview loaded. Describe changes, then Publish (records lineage on-chain).`);
    $('pgInput').focus();
  } catch (e) { toast('Remix failed: ' + (e.message || e), { kind: 'error' }); }
}

/** Prefer an on-chain claimed handle (@name) over a SuiNS/short address. */
function displayName(addr) {
  const h = pg.handles.get(addr);
  return h ? '@' + h : nameOrShort(addr);
}

async function openLiveApp(id) {
  const app = appById(id); if (!app) return;
  // Private apps are Seal-encrypted; the public viewer has no wallet, so an
  // authorized builder/member opens them in-app.
  if (app.private) { openPrivateApp(app); return; }
  // Only record a visit when it's gas-free (sponsor configured) — otherwise "Open" would
  // pop a wallet signature for a read-only action, which is jarring.
  if (STATE.wallet && SETTINGS.sponsorUrl) {
    recordVisit(id).catch((e) => toast('Visit metric did not sync: ' + decodeSuiError(e).message, { kind: 'error' }));
  }
  window.open(appViewerUrl(app), '_blank', 'noopener');
}

/* Open a private app: decrypt for the builder or an allowlisted workspace member
   and render it in a sandboxed iframe inside a modal. */
async function openPrivateApp(app) {
  if (!STATE.wallet) {
    toast('Private app - connect the builder or an allowlisted collaborator wallet', { kind: 'error' });
    return;
  }
  if (!(STATE.wallet.address === app.builder || app.workspaceMembers?.includes(STATE.wallet.address))) {
    toast('Private app - this wallet is not allowlisted for the workspace', { kind: 'error' });
    return;
  }
  toast('Decrypting with Seal (sign to unlock)…', { kind: 'info', timeout: 2500 });
  try {
    let html = await fetchAppHtml(app); // fetchAppArchiveGz Seal-decrypts for private apps
    // Defense-in-depth: neutralize meta-refresh + lock the sandbox down (no network).
    html = html.replace(/<meta\b[^>]*http-equiv\s*=\s*["']?\s*refresh[^>]*>/gi, '');
    const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'">`;
    if (/<head[^>]*>/i.test(html)) html = html.replace(/<head[^>]*>/i, (m) => m + csp);
    else html = '<!doctype html><head>' + csp + '</head>' + html;
    openModal({
      title: `${app.name} - private`,
      wide: true,
      bodyHtml: `<iframe id="pgPrivFrame" sandbox="allow-scripts" referrerpolicy="no-referrer" style="width:100%;height:68vh;border:0;background:var(--bg-app);border-radius:4px"></iframe>`,
      onMount(m) { m.querySelector('#pgPrivFrame').srcdoc = html; },
    });
  } catch (e) {
    toast('Decrypt failed: ' + (e.message || e), { kind: 'error' });
  }
}

/* Copy a canonical, verifiable share link (viewer route). The viewer re-verifies
   the treeHash against the on-chain anchor, so the link proves provenance. */
async function shareApp(id) {
  const app = appById(id); if (!app) return;
  const url = appViewerUrl(app);
  try {
    await navigator.clipboard.writeText(url);
    toast('Share link copied — verifiable provenance baked in');
  } catch {
    // Clipboard blocked (insecure context / permissions) — fall back to opening it.
    window.prompt('Copy this shareable link:', url);
  }
}

/* Value-free action: try the sponsor first (gas-free for the user), else the
   user pays their own gas. Optional refresh() runs on success. */
async function runSocial(tx, okMsg, refresh) {
  let r = await signAndRunSponsored(tx, okMsg);
  if (r === undefined) r = await signAndRun(tx, okMsg);
  if (r && refresh) refresh();
  return r;
}

async function recordVisit(id) {
  const tx = new Transaction();
  pgCall(tx, 'playground::record_visit', [tx.object(id)]);
  await runSocial(tx, 'Visit recorded');
}

async function starApp(id) {
  if (!STATE.wallet) { toast('Connect a wallet to star', { kind: 'error' }); return; }
  if (!CFG.builderBoard) { toast('Playground not fully deployed on this network', { kind: 'error' }); return; }
  const tx = new Transaction();
  pgCall(tx, 'playground::star_v2', [tx.object(id), tx.object(CFG.starRegistry), tx.object(CFG.builderBoard)]);
  await runSocial(tx, 'Starred ★', loadGallery);
}

async function flagApp(id) {
  if (!STATE.wallet) { toast('Connect a wallet to flag', { kind: 'error' }); return; }
  if (!CFG.flagRegistry) { toast('Moderation not deployed on this network', { kind: 'error' }); return; }
  const tx = new Transaction();
  pgCall(tx, 'playground::flag_app', [tx.object(id), tx.object(CFG.flagRegistry)]);
  await runSocial(tx, 'Reported', loadGallery);
}

async function setHidden(id, hidden) {
  if (!STATE.wallet) { toast('Connect a wallet', { kind: 'error' }); return; }
  if (!CFG.flagRegistry) { toast('Moderation not deployed on this network', { kind: 'error' }); return; }
  const tx = new Transaction();
  pgCall(tx, 'playground::set_hidden', [tx.object(id), tx.object(CFG.flagRegistry), tx.pure.bool(hidden)]);
  await runSocial(tx, hidden ? 'App hidden' : 'App unhidden', loadGallery);
}

async function tipApp(id) {
  if (!STATE.wallet) { toast('Connect a wallet to tip', { kind: 'error' }); return; }
  const app = appById(id); if (!app) return;
  openModal({
    title: `Tip ${app.name}`,
    bodyHtml: `
      <label>Amount (SUI) — goes to the builder, minus a 2.5% fee</label>
      <input type="number" id="pgTipAmt" min="0.01" step="0.01" value="0.1">
      <div class="modal-actions">
        <button class="btn-ghost" id="pgTipCancel">Cancel</button>
        <button class="btn-primary" id="pgTipSend">Send tip</button>
      </div>`,
    onMount(m) {
      m.querySelector('#pgTipCancel').addEventListener('click', closeModal);
      m.querySelector('#pgTipSend').addEventListener('click', async () => {
        const sui = Number(m.querySelector('#pgTipAmt').value);
        if (!(sui > 0)) { toast('Enter a positive amount', { kind: 'error' }); return; }
        const mist = Math.round(sui * MIST);
        const tx = new Transaction();
        const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(mist)]);
        if (CFG.treasury) {
          // Real protocol fee accrues to the Treasury (vs tip_app which refunds it).
          pgCall(tx, 'playground::tip_app_v2', [tx.object(id), tx.object(CFG.treasury), coin]);
        } else {
          pgCall(tx, 'playground::tip_app', [tx.object(id), coin]);
        }
        const r = await signAndRun(tx, `Tipped ${sui} SUI`); if (r) { closeModal(); loadGallery(); }
      });
    },
  });
}

/** Builder sets (or clears) a fork price on their own app. Forking a priced app
    then costs that fee, paid to the builder (minus a 2.5% protocol fee). */
async function setForkPrice(id) {
  if (!STATE.wallet) { toast('Connect a wallet', { kind: 'error' }); return; }
  if (!CFG.forkRegistry) { toast('Paid-fork not deployed on this network', { kind: 'error' }); return; }
  const app = appById(id); if (!app) return;
  if (STATE.wallet.address !== app.builder) { toast('Only the builder can price this app', { kind: 'error' }); return; }
  const current = app.forkPrice ? (app.forkPrice / MIST) : 0;
  openModal({
    title: `Fork price · ${app.name}`,
    bodyHtml: `
      <label>Price to fork (SUI) — paid to you, minus a 2.5% protocol fee. Set 0 to make it free.</label>
      <input type="number" id="pgForkAmt" min="0" step="0.1" value="${current}">
      <div class="pg-dim" style="margin-top:6px">Forkers pay this once via <code>pay_to_fork</code>, then publish their remix — both in one transaction, recorded on-chain.</div>
      <div class="modal-actions">
        <button class="btn-ghost" id="pgForkCancel">Cancel</button>
        <button class="btn-primary" id="pgForkSave">Save price</button>
      </div>`,
    onMount(m) {
      m.querySelector('#pgForkCancel').addEventListener('click', closeModal);
      m.querySelector('#pgForkSave').addEventListener('click', async () => {
        const sui = Number(m.querySelector('#pgForkAmt').value);
        if (!(sui >= 0)) { toast('Enter 0 or a positive amount', { kind: 'error' }); return; }
        const mist = Math.round(sui * MIST);
        const tx = new Transaction();
        pgCall(tx, 'playground::set_fork_price', [tx.object(CFG.forkRegistry), tx.object(id), tx.pure.u64(mist)]);
        const r = await signAndRun(tx, mist ? `Fork price set to ${sui} SUI` : 'Fork price cleared (free)');
        if (r) { closeModal(); loadGallery(); }
      });
    },
  });
}

async function inviteWorkspaceMember(id) {
  if (!STATE.wallet) { toast('Connect a wallet', { kind: 'error' }); return; }
  if (!CFG.workspaceRegistry) { toast('Team-private workspace registry is not deployed on this network', { kind: 'error' }); return; }
  const app = appById(id); if (!app) return;
  if (STATE.wallet.address !== app.builder) { toast('Only the builder can invite workspace members', { kind: 'error' }); return; }
  openModal({
    title: `Invite collaborator - ${app.name}`,
    bodyHtml: `
      <label>Collaborator Sui address</label>
      <input type="text" id="pgWorkspaceMember" placeholder="0x..." autocomplete="off">
      <div class="pg-dim" style="margin-top:6px">Invited collaborators can decrypt this private app through the v2 Seal policy. The app owner stays unchanged.</div>
      <div class="modal-actions">
        <button class="btn-ghost" id="pgWorkspaceCancel">Cancel</button>
        <button class="btn-primary" id="pgWorkspaceSave">Invite</button>
      </div>`,
    onMount(m) {
      m.querySelector('#pgWorkspaceCancel').addEventListener('click', closeModal);
      m.querySelector('#pgWorkspaceSave').addEventListener('click', async () => {
        const member = m.querySelector('#pgWorkspaceMember').value.trim();
        if (!isValidSuiAddress(member)) { toast('Enter a valid Sui address', { kind: 'error' }); return; }
        const tx = new Transaction();
        pgCall(tx, 'playground::invite_workspace_member', [tx.object(CFG.workspaceRegistry), tx.object(id), tx.pure.address(member)]);
        const r = await signAndRun(tx, 'Workspace member invited');
        if (r) { closeModal(); await loadGallery(); }
      });
    },
  });
}

async function revokeWorkspaceMember(id) {
  if (!STATE.wallet) { toast('Connect a wallet', { kind: 'error' }); return; }
  if (!CFG.workspaceRegistry) { toast('Team-private workspace registry is not deployed on this network', { kind: 'error' }); return; }
  const app = appById(id); if (!app) return;
  if (STATE.wallet.address !== app.builder) { toast('Only the builder can revoke workspace members', { kind: 'error' }); return; }
  const members = app.workspaceMembers || [];
  openModal({
    title: `Revoke collaborator - ${app.name}`,
    bodyHtml: `
      <label>Collaborator Sui address</label>
      <input type="text" id="pgWorkspaceMember" placeholder="0x..." autocomplete="off" value="${escapeHtml(members[0] || '')}">
      ${members.length ? `<div class="pg-dim" style="margin-top:6px">Current members: ${members.map((a) => `<span class="mono">${short(a)}</span>`).join(', ')}</div>` : '<div class="pg-dim" style="margin-top:6px">No indexed members yet. You can still paste an address to revoke.</div>'}
      <div class="modal-actions">
        <button class="btn-ghost" id="pgWorkspaceCancel">Cancel</button>
        <button class="btn-primary" id="pgWorkspaceSave">Revoke</button>
      </div>`,
    onMount(m) {
      m.querySelector('#pgWorkspaceCancel').addEventListener('click', closeModal);
      m.querySelector('#pgWorkspaceSave').addEventListener('click', async () => {
        const member = m.querySelector('#pgWorkspaceMember').value.trim();
        if (!isValidSuiAddress(member)) { toast('Enter a valid Sui address', { kind: 'error' }); return; }
        const tx = new Transaction();
        pgCall(tx, 'playground::revoke_workspace_member', [tx.object(CFG.workspaceRegistry), tx.object(id), tx.pure.address(member)]);
        const r = await signAndRun(tx, 'Workspace member revoked');
        if (r) { closeModal(); await loadGallery(); }
      });
    },
  });
}

/** Builder profile: aggregate that address's published apps + totals. */
async function showBuilderProfile(addr) {
  openModal({
    title: 'Builder profile',
    wide: true,
    bodyHtml: '<div class="empty-state">Loading…</div>',
    onMount: async (m) => {
      await resolveName(addr).catch(() => {});
      const apps = pg.gallery.filter((a) => a.builder === addr);
      const totalVisits = apps.reduce((n, a) => n + a.visits, 0);
      const totalStars = apps.reduce((n, a) => n + a.stars, 0);
      const totalTips = apps.reduce((n, a) => n + a.tips, 0);
      const remixes = apps.filter((a) => a.parent).length;
      // Authoritative score from the on-chain BuilderBoard; fall back to the
      // client-side approximation only if the read fails or the board is absent.
      const onChainScore = await readBuilderScore(addr);
      const score = onChainScore != null ? onChainScore : apps.length * 5 + totalStars * 3;
      const isMe = STATE.wallet && STATE.wallet.address === addr;
      const handle = pg.handles.get(addr);
      m.innerHTML = `
        <div class="pg-profile-head">
          <div class="pg-profile-name">${escapeHtml(handle ? '@' + handle : nameOrShort(addr))}</div>
          <a class="link mono" href="${explorerAddress(addr)}" target="_blank" rel="noreferrer">${short(addr)} ↗</a>
        </div>
        ${isMe && CFG.nameRegistry ? `
        <div class="pg-claim-row" style="display:flex;gap:8px;margin:8px 0">
          <input id="pgHandle" placeholder="claim a handle (a-z, 0-9, -)" value="${escapeHtml(handle || '')}" style="flex:1">
          <button class="btn-ghost pg-mini" id="pgClaim">${handle ? 'Change' : 'Claim'} handle</button>
        </div>` : ''}
        <div class="pg-profile-stats">
          <div><b>${apps.length}</b><span>apps</span></div>
          <div><b>${totalVisits}</b><span>visits</span></div>
          <div><b>${totalStars}</b><span>stars</span></div>
          <div><b>${suiAmount(totalTips)}</b><span>SUI tips</span></div>
          <div><b>${remixes}</b><span>remixes</span></div>
          <div><b>${score}</b><span>builder score</span></div>
        </div>
        <div class="pg-dim" style="margin-top:6px">Builder score earned on-chain</div>
        <div class="card-grid" style="margin-top:16px">
          ${apps.map((a) => `
            <div class="pg-card">
              <div class="pg-card-head"><span class="pg-card-name">${escapeHtml(a.name)}</span><span class="pg-cat">${escapeHtml(a.category)}</span></div>
              <div class="pg-prompt">${escapeHtml(a.prompt)}</div>
              <div class="pg-stats"><span class="pg-stat">▶ ${a.visits}</span><span class="pg-stat">★ ${a.stars}</span></div>
              <a class="pg-verify" href="${explorerObject(a.id)}" target="_blank" rel="noreferrer">✓ on-chain</a>
            </div>`).join('') || '<div class="empty-state">No apps yet.</div>'}
        </div>`;
      const claimBtn = m.querySelector('#pgClaim');
      if (claimBtn) claimBtn.addEventListener('click', async () => {
        await claimName(m.querySelector('#pgHandle').value);
        closeModal();
      });
    },
  });
}

/* ============================================================
   Walrus Site per-app (optional) — mints a real on-chain Site object
   for the app via the Walrus Sites Move package, signed by the wallet.
   The app bytes are (re)uploaded to Walrus via the @mysten/walrus SDK so
   we get the rootHash that `site::new_resource` requires. On testnet there
   is no public portal, so we surface the Site object id + base36 subdomain
   as the durable artifact (live URL needs a local/self-hosted portal).
   ============================================================ */
const WALRUS_SITE_PKG = {
  testnet: '0x22b8c1496650eb45fbcca0f8f37fae77ed33b7d4eaab4da5f0bb9b62a8708dcb',
  mainnet: '0x5a0c509a659ba982f91ff1189872b8d528f8c02b5f6285a3931fc4c2869ccc9c',
};

/** object id (hex) -> base36 subdomain string (walrus-sites convention). */
function objectIdToBase36(hexId) {
  let n = BigInt(hexId);
  const digits = '0123456789abcdefghijklmnopqrstuvwxyz';
  if (n === 0n) return '0';
  let out = '';
  while (n > 0n) { out = digits[Number(n % 36n)] + out; n /= 36n; }
  return out;
}

async function publishAsWalrusSite(id) {
  const app = appById(id); if (!app) return;
  if (!STATE.wallet) { toast('Connect a wallet first', { kind: 'error' }); return; }
  const sitePkg = WALRUS_SITE_PKG[CFG.network];
  if (!sitePkg) { toast('Walrus Sites not configured for this network', { kind: 'error' }); return; }
  toast('Preparing Walrus Site… (needs testnet SUI + WAL)', { kind: 'info', timeout: 3000 });
  try {
    const html = await fetchAppHtml(app);
    const bytes = new TextEncoder().encode(html);

    // Load the Walrus SDK lazily so a WASM/load issue never breaks the rest of the page.
    const { WalrusClient, blobIdToInt } = await import('https://esm.sh/@mysten/walrus@1.1.7?external=@mysten/sui');
    const walrus = new WalrusClient({
      network: CFG.network,
      suiClient: sui,
      uploadRelay: CFG.network === 'testnet'
        ? { host: 'https://upload-relay.testnet.walrus.space', sendTip: { max: 1000 } }
        : undefined,
    });

    // local encode -> blobId + rootHash (rootHash is what new_resource wants as blob_hash)
    const enc = await walrus.encodeBlob(bytes);
    const blobId = enc.blobId;
    // rootHash comes back as a 32-byte Uint8Array; new_resource's blob_hash is a u256
    // = big-endian interpretation of those bytes. Convert before tx.pure.u256.
    const rh = enc.rootHash;
    const rootHash = (rh instanceof Uint8Array)
      ? BigInt('0x' + [...rh].map((b) => b.toString(16).padStart(2, '0')).join(''))
      : BigInt(rh);

    // upload the blob (writeFilesFlow: register + certify = 2 signs)
    const { WalrusFile } = await import('https://esm.sh/@mysten/walrus@1.1.7?external=@mysten/sui');
    const file = WalrusFile.from({ contents: bytes, identifier: 'index.html', tags: { 'content-type': 'text/html' } });
    const flow = walrus.writeFilesFlow({ files: [file] });
    await flow.encode();
    const owner = STATE.wallet.address;
    const regTx = flow.register({ epochs: 5, owner, deletable: true });
    const reg = await signAndRun(regTx, 'Blob registered'); if (!reg) return;
    await flow.upload({ digest: reg.digest });
    const certTx = flow.certify();
    const cert = await signAndRun(certTx, 'Blob certified'); if (!cert) return;

    // build the Site PTB (1 more sign)
    const tx = new Transaction();
    const P = sitePkg;
    const none = () => tx.pure.option('string', null);
    const metadata = tx.moveCall({ target: `${P}::metadata::new_metadata`, arguments: [none(), none(), none(), none(), none()] });
    const site = tx.moveCall({ target: `${P}::site::new_site`, arguments: [tx.pure.string(app.name), metadata] });
    const range = tx.moveCall({ target: `${P}::site::new_range_option`, arguments: [tx.pure.option('u64', null), tx.pure.option('u64', null)] });
    const resource = tx.moveCall({ target: `${P}::site::new_resource`, arguments: [
      tx.pure.string('/index.html'), tx.pure.u256(blobIdToInt(blobId)), tx.pure.u256(rootHash), range,
    ] });
    tx.moveCall({ target: `${P}::site::add_resource`, arguments: [site, resource] });
    tx.moveCall({ target: `${P}::site::create_routes`, arguments: [site] });
    tx.moveCall({ target: `${P}::site::insert_route`, arguments: [site, tx.pure.string('/'), tx.pure.string('/index.html')] });
    tx.transferObjects([site], owner);

    const r = await signAndRunCreated(tx, 'Walrus Site created', '::site::Site');
    const siteId = r?.created?.[0];
    if (siteId) {
      try { localStorage.setItem('wf.site.' + app.id, siteId); } catch {}
      const b36 = objectIdToBase36(siteId);
      openModal({
        title: 'Walrus Site created ✓',
        bodyHtml: `
          <p>Your app now has its own on-chain <b>Site object</b>.</p>
          <p class="pg-dim" style="font-size:12px">Site id:</p>
          <a class="link mono" href="${explorerObject(siteId)}" target="_blank" rel="noreferrer">${short(siteId)} ↗</a>
          <p class="pg-dim" style="font-size:12px;margin-top:10px">Subdomain (base36):</p>
          <code class="mono" style="word-break:break-all">${b36}</code>
          <p class="pg-dim" style="font-size:12px;margin-top:10px">${CFG.network === 'testnet'
            ? 'Testnet has no public portal — browse via a self-hosted portal at <code>' + b36 + '.localhost:3000</code>, or register a SuiNS name for a public URL.'
            : 'On mainnet, register a SuiNS name pointing at this site for a public <code>*.wal.app</code> URL.'}</p>
          <div class="modal-actions"><button class="btn-primary" id="pgSiteOk">Done</button></div>`,
        onMount(m) { m.querySelector('#pgSiteOk').addEventListener('click', closeModal); },
      });
    }
  } catch (e) {
    toast('Walrus Site failed: ' + (e.message || e), { kind: 'error' });
  }
}

async function remixApp(id) {
  const app = appById(id); if (!app) return;
  toast('Loading app to remix…', { kind: 'info', timeout: 1500 });
  try {
    const html = await fetchAppHtml(app);
    pg.remixParent = id;
    pg.remixForkPrice = app.forkPrice || 0; // >0 => publish bundles pay_to_fork (licensed remix)
    pg.updateTarget = null;
    pg.basePrompt = null; // the remix's own prompt = the user's next instruction, not the parent's
    pg.messages = [
      { role: 'user', content: `Here is an existing app to remix (original prompt: "${app.prompt}"). The current index.html is:\n\n${html}\n\nWait for my next instruction on what to change.` },
      { role: 'assistant', content: 'Loaded. Tell me what to change and I will produce the updated app JSON.' },
    ];
    pg.current = { name: app.name + '-remix', category: app.category, prompt: app.prompt, files: [{ path: 'index.html', content: html }] };
    setPreview(pg.current);
    $('pgMessages').innerHTML = '';
    pushMsg('bot', `Remixing <b>${escapeHtml(app.name)}</b> — preview loaded.${pg.remixForkPrice ? ` This app charges <b>${suiAmount(pg.remixForkPrice)} SUI</b> to fork, paid to the builder when you Publish.` : ''} Describe your changes, then Publish (records lineage on-chain).`);
    $('pgInput').focus();
  } catch (e) {
    toast('Remix load failed: ' + (e.message || e), { kind: 'error' });
  }
}

/** Load your OWN app into the editor to publish a NEW VERSION (update_app, in place). */
async function editApp(id) {
  const app = appById(id); if (!app) return;
  if (!STATE.wallet || STATE.wallet.address !== app.builder) { toast('Only the builder can update this app', { kind: 'error' }); return; }
  toast('Loading your app to update…', { kind: 'info', timeout: 1500 });
  try {
    const html = await fetchAppHtml(app);
    pg.updateTarget = id;
    pg.remixParent = null;
    pg.remixForkPrice = 0;
    pg.basePrompt = app.prompt || null; // keep the app's existing prompt across an update
    pg.messages = [
      { role: 'user', content: `Here is my published app "${app.name}" (prompt: "${app.prompt}"). The current index.html is:\n\n${html}\n\nWait for my next instruction on what to change.` },
      { role: 'assistant', content: 'Loaded. Tell me what to change and I will produce the updated app JSON.' },
    ];
    pg.current = { name: app.name, category: app.category, prompt: app.prompt, files: [{ path: 'index.html', content: html }] };
    setPreview(pg.current);
    $('pgMessages').innerHTML = '';
    pushMsg('bot', `Updating <b>${escapeHtml(app.name)}</b> — preview loaded. Describe changes, then Publish to ship a new version (same app, re-anchored hash).`);
    $('pgInput').focus();
  } catch (e) {
    toast('Edit load failed: ' + (e.message || e), { kind: 'error' });
  }
}

/** Renew (re-pin) an app's Walrus storage so its bytes don't expire. Re-uploads
   the exact stored bytes via the SDK with fresh epochs; blobIds are content-addressed
   so the on-chain ids stay valid (no contract write needed). Builder pays the WAL. */
async function renewApp(id) {
  const app = appById(id); if (!app) return;
  if (!STATE.wallet || STATE.wallet.address !== app.builder) { toast('Only the builder can renew storage', { kind: 'error' }); return; }
  openModal({
    title: `Renew storage · ${escapeHtml(app.name)}`,
    bodyHtml: `
      <label>Keep this app's bytes available for how many Walrus epochs? You pay the WAL.</label>
      <select id="pgRenewEpochs">
        <option value="10">10 epochs</option>
        <option value="50" selected>50 epochs</option>
        <option value="200">200 epochs</option>
      </select>
      <div class="modal-actions">
        <button class="btn-ghost" id="pgRenewCancel">Cancel</button>
        <button class="btn-primary" id="pgRenewGo">Renew storage</button>
      </div>`,
    onMount(m) {
      m.querySelector('#pgRenewCancel').addEventListener('click', closeModal);
      m.querySelector('#pgRenewGo').addEventListener('click', async () => {
        const epochs = Number(m.querySelector('#pgRenewEpochs').value);
        try {
          const arRes = await fetch(blobUrl(app.archiveBlob));
          if (!arRes.ok) throw new Error('archive bytes no longer available to re-pin');
          const files = [{ bytes: new Uint8Array(await arRes.arrayBuffer()), identifier: 'archive' }];
          const mfRes = await fetch(blobUrl(app.manifestBlob));
          if (mfRes.ok) files.push({ bytes: new Uint8Array(await mfRes.arrayBuffer()), identifier: 'manifest' });
          const ids = await walrusPutSdk(files, epochs);
          closeModal();
          // blobId is content-addressed: a match means the SAME on-chain blob's life was
          // extended. A mismatch means these bytes hashed differently (e.g. the app was
          // published to the free publisher) — re-pinning made a NEW blob the on-chain
          // record doesn't point at, so it did NOT renew this app. Be honest about that.
          if (ids.get('archive') === app.archiveBlob) {
            toast(`Storage renewed ✓ · ${epochs} epochs`, { kind: 'success' });
          } else {
            toast('Could not renew in place — this app was stored via the free publisher (not owned). Re-publish with "Paid · you own it" to make it renewable.', { kind: 'error', timeout: 7000 });
          }
        } catch (e) { toast('Renew failed: ' + (e.message || e), { kind: 'error' }); }
      });
    },
  });
}

/** Claim a unique builder handle (e.g. "alice") for human-readable profile URLs. */
async function claimName(name) {
  if (!STATE.wallet) { toast('Connect a wallet to claim a handle', { kind: 'error' }); return; }
  if (!CFG.nameRegistry) { toast('Handles not deployed on this network', { kind: 'error' }); return; }
  const clean = String(name || '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!clean) { toast('Enter a valid handle (a-z, 0-9, -)', { kind: 'error' }); return; }
  const tx = new Transaction();
  pgCall(tx, 'playground::claim_name', [tx.object(CFG.nameRegistry), tx.pure.string(clean)]);
  const r = await runSocial(tx, `Claimed @${clean}`); if (r) { await loadHandles(); loadGallery(); }
}

/** Load claimed handles (address -> @name) from NameClaimed/NameReleased events. */
async function loadHandles() {
  if (!CFG.nameRegistry) return;
  const map = new Map();
  try {
    for (const e of await pgEvents('NameClaimed', { limit: 500, order: 'ascending' })) { const j = e.parsedJson; if (j?.owner && j?.name) map.set(j.owner, j.name); }
    for (const e of await pgEvents('NameReleased', { limit: 500, order: 'ascending' })) { const j = e.parsedJson; if (j?.owner && map.get(j.owner) === j.name) map.delete(j.owner); }
  } catch (e) { toast('Handles did not sync: ' + decodeSuiError(e).message, { kind: 'error' }); }
  pg.handles = map;
}

/** Read the AUTHORITATIVE on-chain builder score from BuilderBoard (devInspect, read-only). */
async function readBuilderScore(addr) {
  if (!CFG.builderBoard) return null;
  try {
    const tx = new Transaction();
    pgCall(tx, 'playground::builder_score', [tx.object(CFG.builderBoard), tx.pure.address(addr)]);
    const res = await sui.devInspectTransactionBlock({ sender: addr, transactionBlock: tx });
    const rv = res.results?.[0]?.returnValues?.[0];
    if (!rv) return null;
    const bytes = Uint8Array.from(rv[0]); // u64, little-endian BCS
    let v = 0n; for (let i = 0; i < 8; i++) v += BigInt(bytes[i] || 0) << (8n * BigInt(i));
    return Number(v);
  } catch { return null; }
}

/* ============================================================
   App bounties — escrow SUI for an app you want built
   ============================================================ */
async function loadBounties() {
  if (!CFG.appBounties) { pg.bounties = []; return; }
  try {
    const ids = (await pgEvents('AppBountyPosted', { order: 'descending' })).map((e) => e.parsedJson?.bounty_id).filter(Boolean);
    if (!ids.length) { pg.bounties = []; return; }
    const objs = await multiGetChunked(ids, { showContent: true });
    pg.bounties = objs.map((o) => {
      const f = o.data?.content?.fields; if (!f) return null;
      const reward = Number(typeof f.reward === 'object' ? (f.reward.fields?.value ?? 0) : (f.reward ?? 0));
      const winner = f.winner?.fields?.vec?.[0] ?? (typeof f.winner === 'string' ? f.winner : null);
      return { id: o.data.objectId, poster: f.poster || '', description: f.description || '', reward, open: f.open, winner };
    }).filter(Boolean).filter((b) => b.open);
  } catch (e) {
    pg.bounties = null;
    toast('Bounties did not sync: ' + decodeSuiError(e).message, { kind: 'error', action: { label: 'Retry', onClick: () => loadBounties().then(renderBounties) } });
  }
}

function renderBounties() {
  const root = $('pgBounties'); if (!root) return;
  if (!CFG.appBounties) { root.innerHTML = '<div class="empty-state">Bounties aren\'t available on this network yet.</div>'; return; }
  if (pg.bounties == null) { root.innerHTML = '<div class="empty-state err">Bounties did not sync. Retry from the toast or refresh.</div>'; return; }
  if (!pg.bounties.length) { root.innerHTML = '<div class="empty-state">No open bounties yet — post the first one.</div>'; return; }
  root.innerHTML = pg.bounties.map((b) => {
    const mine = STATE.wallet && STATE.wallet.address === b.poster;
    return `<div class="pg-card">
      <div class="pg-card-head"><span class="pg-card-name">💰 ${suiAmount(b.reward)} SUI</span></div>
      <div class="pg-prompt">${escapeHtml(b.description)}</div>
      <span class="pg-by">by <button class="pg-builder" data-act="profile" data-builder="${b.poster}">${escapeHtml(displayName(b.poster))}</button></span>
      <div class="pg-card-actions">
        ${mine
          ? `<button class="btn-primary pg-mini" data-act="bounty-award" data-bounty="${b.id}">Award…</button>
             <button class="btn-ghost pg-mini" data-act="bounty-cancel" data-bounty="${b.id}">Cancel</button>`
          : `<a class="pg-verify" href="${explorerObject(b.id)}" target="_blank" rel="noreferrer">✓ escrowed on-chain</a>`}
      </div>
    </div>`;
  }).join('');
}

async function postBounty() {
  if (!STATE.wallet) { toast('Connect a wallet to post a bounty', { kind: 'error' }); return; }
  if (!CFG.appBounties) { toast('Bounties not available on this network', { kind: 'error' }); return; }
  openModal({
    title: 'Post an app bounty',
    bodyHtml: `
      <label>What app do you want built?</label>
      <input id="pgBDesc" placeholder="e.g. a metronome with tap-tempo">
      <label style="margin-top:8px">Reward (SUI) — escrowed on-chain until you award it</label>
      <input type="number" id="pgBAmt" min="0.01" step="0.01" value="1">
      <div class="modal-actions"><button class="btn-ghost" id="pgBCancel">Cancel</button><button class="btn-primary" id="pgBGo">Sign &amp; submit</button></div>`,
    onMount(m) {
      m.querySelector('#pgBCancel').addEventListener('click', closeModal);
      m.querySelector('#pgBGo').addEventListener('click', async () => {
        const desc = m.querySelector('#pgBDesc').value.trim();
        const amt = Number(m.querySelector('#pgBAmt').value);
        if (!desc) { toast('Describe the app you want', { kind: 'error' }); return; }
        if (!(amt > 0)) { toast('Enter a positive reward', { kind: 'error' }); return; }
        const tx = new Transaction();
        const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(Math.round(amt * MIST))]);
        pgCall(tx, 'playground::post_app_bounty', [tx.pure.string(desc.slice(0, 200)), coin, tx.object('0x6')]);
        const go = m.querySelector('#pgBGo');
        go.disabled = true; go.textContent = 'Signing...';
        try {
          const r = await signAndRun(tx, `Bounty posted · ${amt} SUI`);
          if (r) { closeModal(); await loadBounties(); renderBounties(); }
        } finally {
          go.disabled = false; go.textContent = 'Sign & submit';
        }
      });
    },
  });
}

async function awardBounty(id) {
  const b = pg.bounties.find((x) => x.id === id); if (!b) return;
  const opts = pg.gallery.map((a) => `<option value="${a.id}">${escapeHtml(a.name)} · by ${escapeHtml(displayName(a.builder))}</option>`).join('');
  openModal({
    title: 'Award bounty',
    bodyHtml: `
      <label>Which published app fulfills “${escapeHtml(b.description)}”?</label>
      <select id="pgAwApp">${opts || '<option disabled>No apps in the gallery yet</option>'}</select>
      <p class="pg-dim" style="font-size:12px">Releases ${suiAmount(b.reward)} SUI to that app's builder (minus a 2.5% fee to the Treasury).</p>
      <div class="modal-actions"><button class="btn-ghost" id="pgAwCancel">Cancel</button><button class="btn-primary" id="pgAwGo">Award ${suiAmount(b.reward)} SUI</button></div>`,
    onMount(m) {
      m.querySelector('#pgAwCancel').addEventListener('click', closeModal);
      m.querySelector('#pgAwGo').addEventListener('click', async () => {
        const appId = m.querySelector('#pgAwApp').value; if (!appId) { toast('Pick an app', { kind: 'error' }); return; }
        const tx = new Transaction();
        pgCall(tx, 'playground::award_app_bounty', [tx.object(id), tx.object(appId), tx.object(CFG.treasury)]);
        const r = await signAndRun(tx, 'Bounty awarded ✓'); if (r) { closeModal(); await loadBounties(); renderBounties(); }
      });
    },
  });
}

async function cancelBounty(id) {
  const tx = new Transaction();
  pgCall(tx, 'playground::cancel_app_bounty', [tx.object(id)]);
  const r = await signAndRun(tx, 'Bounty cancelled'); if (r) { await loadBounties(); renderBounties(); }
}

/** Fetch + inflate an app's index.html from its Walrus archive blob. */
/* Fetch an app's archive gzip bytes, transparently Seal-decrypting it for a
   private app (only the builder can succeed — the on-chain policy gates it). */
async function fetchAppArchiveGz(app) {
  const res = await fetch(blobUrl(app.archiveBlob));
  if (!res.ok) throw new Error('archive unavailable');
  let gz = new Uint8Array(await res.arrayBuffer());
  if (app.private) {
    const { sealDecrypt } = await import('./seal.js');
    gz = new Uint8Array(await sealDecrypt(gz, app.id));
  }
  return gz;
}

export async function fetchAppHtml(app) {
  const gz = await fetchAppArchiveGz(app);
  const ds = new DecompressionStream('gzip');
  const flat = new Uint8Array(await new Response(new Blob([gz]).stream().pipeThrough(ds)).arrayBuffer());
  const dv = new DataView(flat.buffer, flat.byteOffset, flat.byteLength);
  const dec = new TextDecoder(); let o = 0; const files = {};
  while (o + 8 <= flat.length) {
    const pl = dv.getUint32(o, false); const dl = dv.getUint32(o + 4, false); o += 8;
    const path = dec.decode(flat.subarray(o, o + pl)); o += pl;
    const data = dec.decode(flat.subarray(o, o + dl)); o += dl;
    files[path] = data;
  }
  return files['index.html'] || Object.values(files)[0] || '';
}

/* ============================================================
   Settings modal (BYOK key + model)
   ============================================================ */
function openSettings() {
  openModal({
    title: 'LLM settings',
    bodyHtml: `
      <label>How to reach the model</label>
      <select id="pgMode">
        <option value="byok" ${llm.mode !== 'proxy' ? 'selected' : ''}>My own Anthropic key (BYOK)</option>
        <option value="proxy" ${llm.mode === 'proxy' ? 'selected' : ''}>Hosted proxy (no key needed)</option>
      </select>
      <div id="pgByokBox" style="${llm.mode === 'proxy' ? 'display:none' : ''}">
        <label style="margin-top:8px">Anthropic API key (stored locally in your browser)</label>
        <input type="password" id="pgKey" placeholder="sk-ant-…" value="${escapeHtml(llm.apiKey || '')}">
        <p class="pg-dim" style="font-size:12px;margin-top:4px">Your key never leaves your browser; requests go straight to Anthropic. Get one at console.anthropic.com.</p>
      </div>
      <div id="pgProxyBox" style="${llm.mode === 'proxy' ? '' : 'display:none'}">
        <label style="margin-top:8px">Proxy URL (the hosted relay's /llm endpoint)</label>
        <input type="text" id="pgProxyUrl" placeholder="https://your-proxy.example.com/llm" value="${escapeHtml(llm.proxyUrl || CFG.llmProxyUrl || '')}">
        <p class="pg-dim" style="font-size:12px;margin-top:4px">No key needed — the relay holds it server-side. See server/llm-proxy.</p>
      </div>
      <label style="margin-top:8px">Model</label>
      <select id="pgModel">${MODELS.map((m) => `<option value="${m[0]}" ${m[0] === llm.model ? 'selected' : ''}>${m[1]}</option>`).join('')}</select>
      <label style="margin-top:8px">Sponsor URL (optional — gas-free stars/visits/publish)</label>
      <input type="text" id="pgSponsorUrl" placeholder="https://your-sponsor.example.com/sponsor" value="${escapeHtml(SETTINGS.sponsorUrl || '')}">
      <p class="pg-dim" style="font-size:12px;margin-top:4px">When set, value-free actions are gas-sponsored — you don't need SUI. Falls back to your wallet if unset/unavailable. See server/sponsor.</p>
      <label style="margin-top:8px">Portal URL (optional — share links with previews)</label>
      <input type="text" id="pgPortalUrl" placeholder="https://your-portal.example.com" value="${escapeHtml(SETTINGS.portalUrl || '')}">
      <p class="pg-dim" style="font-size:12px;margin-top:4px">When set, Share uses <code>&lt;portal&gt;/app/&lt;id&gt;</code> — clean URLs with Open Graph link previews. See server/portal.</p>
      <details style="margin-top:10px">
        <summary class="pg-dim" style="cursor:pointer">Sign in with Google (zkLogin) — no wallet</summary>
        <label style="margin-top:6px">Google OAuth client id</label>
        <input type="text" id="pgZkClient" placeholder="…apps.googleusercontent.com" value="${escapeHtml(SETTINGS.zkGoogleClientId || '')}">
        <label style="margin-top:6px">Salt service URL</label>
        <input type="text" id="pgZkSalt" placeholder="https://…/salt" value="${escapeHtml(SETTINGS.zkSaltUrl || '')}">
        <label style="margin-top:6px">zk prover URL</label>
        <input type="text" id="pgZkProver" placeholder="https://prover.mystenlabs.com/v1" value="${escapeHtml(SETTINGS.zkProverUrl || '')}">
        <div style="margin-top:8px">
          ${zkSession()
            ? `<span class="pg-ok">● signed in as ${escapeHtml(short(zkSession().address))}</span> <button class="btn-ghost pg-mini" id="pgZkOut">Sign out</button>`
            : `<button class="btn-ghost pg-mini" id="pgZkIn">Sign in with Google</button>`}
        </div>
        <p class="pg-dim" style="font-size:12px;margin-top:4px">Needs the salt service (server/salt) + a prover. Combined with the sponsor, you act with no wallet and no gas.</p>
      </details>
      <div class="modal-actions">
        <button class="btn-ghost" id="pgKeyClear">Clear key</button>
        <button class="btn-primary" id="pgKeySave">Save</button>
      </div>`,
    onMount(m) {
      const modeSel = m.querySelector('#pgMode');
      const sync = () => {
        const proxy = modeSel.value === 'proxy';
        m.querySelector('#pgByokBox').style.display = proxy ? 'none' : '';
        m.querySelector('#pgProxyBox').style.display = proxy ? '' : 'none';
      };
      modeSel.addEventListener('change', sync);
      m.querySelector('#pgKeySave').addEventListener('click', () => {
        llm.mode = modeSel.value;
        llm.model = m.querySelector('#pgModel').value;
        if (llm.mode === 'proxy') llm.proxyUrl = m.querySelector('#pgProxyUrl').value.trim();
        else llm.apiKey = m.querySelector('#pgKey').value.trim();
        SETTINGS.sponsorUrl = m.querySelector('#pgSponsorUrl').value.trim();
        SETTINGS.portalUrl = m.querySelector('#pgPortalUrl').value.trim();
        SETTINGS.zkGoogleClientId = m.querySelector('#pgZkClient').value.trim();
        SETTINGS.zkSaltUrl = m.querySelector('#pgZkSalt').value.trim();
        SETTINGS.zkProverUrl = m.querySelector('#pgZkProver').value.trim();
        saveSettings();
        saveLlmConfig(llm); refreshKeyState(); closeModal();
        toast('Settings saved', { kind: 'success', timeout: 1500 });
      });
      const zkIn = m.querySelector('#pgZkIn');
      if (zkIn) zkIn.addEventListener('click', () => {
        SETTINGS.zkGoogleClientId = m.querySelector('#pgZkClient').value.trim();
        SETTINGS.zkSaltUrl = m.querySelector('#pgZkSalt').value.trim();
        SETTINGS.zkProverUrl = m.querySelector('#pgZkProver').value.trim();
        saveSettings();
        if (!zkConfigured()) { toast('Fill Google client id + salt + prover URLs first', { kind: 'error' }); return; }
        beginZkLogin();
      });
      const zkOut = m.querySelector('#pgZkOut');
      if (zkOut) zkOut.addEventListener('click', () => { zkLogout(); closeModal(); toast('Signed out'); });
      m.querySelector('#pgKeyClear').addEventListener('click', () => {
        llm.apiKey = ''; saveLlmConfig(llm); refreshKeyState(); closeModal();
      });
    },
  });
}

/* ============================================================
   Wiring
   ============================================================ */
export function wirePlayground() {
  const root = $('view-playground'); if (!root) return;
  restoreDraft();
  window.addEventListener('beforeunload', (e) => {
    if (!pg.busy) return;
    e.preventDefault();
    e.returnValue = '';
  });
  root.addEventListener('click', (e) => {
    const t = e.target;
    if (t.id === 'pgSend') build($('pgInput').value);
    else if (t.id === 'pgSettings') openSettings();
    else if (t.id === 'pgPublish') publish();
    else if (t.id === 'pgPostBounty') postBounty();
    else if (t.classList?.contains('pg-example')) { $('pgInput').value = t.dataset.prompt || t.textContent; saveDraft(); $('pgInput').focus(); }
    else if (t.classList?.contains('pg-pill')) {
      root.querySelectorAll('.pg-pill').forEach((p) => p.classList.toggle('on', p === t));
      pg.filter = t.dataset.sort; renderGallery();
    } else if (t.classList?.contains('pg-cat-pill')) {
      root.querySelectorAll('.pg-cat-pill').forEach((p) => p.classList.toggle('on', p === t));
      pg.cat = t.dataset.cat; renderGallery();
    } else if (t.dataset?.act === 'bounty-award') awardBounty(t.dataset.bounty);
    else if (t.dataset?.act === 'bounty-cancel') cancelBounty(t.dataset.bounty);
    else if (t.dataset?.act) {
      const id = t.dataset.app;
      if (t.dataset.act === 'open') openLiveApp(id);
      else if (t.dataset.act === 'history') showAppHistory(id);
      else if (t.dataset.act === 'share') shareApp(id);
      else if (t.dataset.act === 'remix') remixApp(id);
      else if (t.dataset.act === 'edit') editApp(id);
      else if (t.dataset.act === 'price') setForkPrice(id);
      else if (t.dataset.act === 'invite-member') inviteWorkspaceMember(id);
      else if (t.dataset.act === 'revoke-member') revokeWorkspaceMember(id);
      else if (t.dataset.act === 'renew') renewApp(id);
      else if (t.dataset.act === 'star') starApp(id);
      else if (t.dataset.act === 'tip') tipApp(id);
      else if (t.dataset.act === 'site') publishAsWalrusSite(id);
      else if (t.dataset.act === 'flag') flagApp(id);
      else if (t.dataset.act === 'hide') setHidden(id, true);
      else if (t.dataset.act === 'unhide') setHidden(id, false);
      else if (t.dataset.act === 'profile') showBuilderProfile(t.dataset.builder);
    }
  });
  root.addEventListener('keydown', (e) => {
    if (e.target.id === 'pgInput' && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); build($('pgInput').value); }
  });
  root.addEventListener('input', (e) => {
    if (e.target.id === 'pgInput') saveDraft();
    if (e.target.id === 'pgSearch') { pg.search = e.target.value; renderGallery(); }
  });
  root.addEventListener('change', (e) => {
    if (e.target.id === 'pgStorage') {
      const ep = $('pgEpochs'); if (ep) ep.style.display = e.target.value === 'paid' ? '' : 'none';
    }
  });
}
