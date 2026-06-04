/* ============================================================
   Signet landing — interactive. Live on-chain stats + activity
   ticker + a real in-browser release verifier + live app frames +
   a mouse-reactive hero constellation. Only a bare SuiClient.
   ============================================================ */
import { SuiClient, getFullnodeUrl } from 'https://esm.sh/@mysten/sui@1.30.0/client';

/* Testnet ids (mirror web/shared.js). */
const PKG = '0x07b63031a435ba7e38909e858c97e9bb6cad14ca5cb51dc9d1fdb9720f237de1';
const PG_ORIG = '0x78ff7299034508b8581a9725d8c6d6bda86813fbdacc5bb8666c0789908b1fcd';
const AGG = 'https://aggregator.walrus-testnet.walrus.space';
const SCAN = 'https://suiscan.xyz/testnet';
const sui = new SuiClient({ url: getFullnodeUrl('testnet') });

const $ = (id) => document.getElementById(id);
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const short = (s, a = 6, b = 4) => !s ? '' : s.length <= a + b + 2 ? s : `${s.slice(0, a)}…${s.slice(-b)}`;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function ago(ms) {
  if (!ms) return '';
  const s = Math.max(1, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return s + 's ago'; if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago'; return Math.floor(s / 86400) + 'd ago';
}
async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/* ---------- live counts (count-up animated) ---------- */
async function countEvents(MoveEventType, { distinct = null, maxPages = 6, limit = 50 } = {}) {
  let cursor = null, n = 0, more = false;
  const seen = distinct ? new Set() : null;
  for (let p = 0; p < maxPages; p++) {
    const res = await sui.queryEvents({ query: { MoveEventType }, cursor, limit, order: 'descending' });
    for (const e of res.data) { if (seen) { const v = e.parsedJson?.[distinct]; if (v) seen.add(v); } else n++; }
    if (res.hasNextPage && res.nextCursor) cursor = res.nextCursor; else { cursor = null; break; }
    if (p === maxPages - 1) more = true;
  }
  return { n: seen ? seen.size : n, more };
}
function countUp(el, target, suffix) {
  if (reduceMotion) { el.textContent = target + suffix; return; }
  const dur = 900, t0 = performance.now();
  const tick = (t) => {
    const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3);
    el.textContent = Math.round(target * e) + (k === 1 ? suffix : '');
    if (k < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
async function loadStats() {
  const jobs = [
    ['stat-repos', `${PKG}::forge::RepoCreated`, {}],
    ['stat-releases', `${PKG}::release::ReleasePublished`, {}],
    ['stat-agents', `${PKG}::reputation::ReputationUpdated`, { distinct: 'agent' }],
    ['stat-apps', `${PG_ORIG}::playground::AppPublished`, {}],
  ];
  await Promise.all(jobs.map(async ([id, type, opts]) => {
    const el = $(id); if (!el) return;
    try { const { n, more } = await countEvents(type, opts); countUp(el, n, more ? '+' : ''); }
    catch { el.textContent = '—'; }
  }));
}

/* ---------- live activity ticker ---------- */
const TICKER_SRC = [
  { type: `${PKG}::forge::RepoCreated`, label: 'Repo', txt: (j) => esc(j.name || 'repo') },
  { type: `${PKG}::release::ReleasePublished`, label: 'Release', txt: (j) => esc(j.version || 'release') },
  { type: `${PKG}::pull_request::PrOpened`, label: 'PR', txt: (j) => esc((j.title || 'pull request').slice(0, 32)) },
  { type: `${PKG}::bounty::BountyPosted`, label: 'Bounty', txt: (j) => esc((j.title || 'bounty').slice(0, 28)) },
  { type: `${PG_ORIG}::playground::AppPublished`, label: 'App', txt: (j) => esc(j.name || 'app') },
];
async function loadTicker() {
  const host = $('ticker'); if (!host) return;
  const all = (await Promise.all(TICKER_SRC.map(async (s) => {
    try {
      const r = await sui.queryEvents({ query: { MoveEventType: s.type }, limit: 6, order: 'descending' });
      return r.data.map((e) => ({ label: s.label, txt: s.txt(e.parsedJson || {}), ts: Number(e.timestampMs) || 0, tx: e.id?.txDigest || '' }));
    } catch { return []; }
  }))).flat().filter((x) => x.tx).sort((a, b) => b.ts - a.ts).slice(0, 14);
  if (!all.length) { host.innerHTML = '<span class="ticker-item muted">no recent activity — be the first ↗</span>'; return; }
  const item = (e) => `<span class="ticker-item"><span class="tk-type">${e.label}</span> ${e.txt}` +
    `<span class="tk-dot"></span><a href="${SCAN}/tx/${e.tx}" target="_blank" rel="noreferrer">${short(e.tx)}</a>` +
    `<span class="tk-dot"></span>${ago(e.ts)}</span>`;
  const row = all.map(item).join('');
  // duplicate for a seamless marquee loop
  host.innerHTML = `<div class="ticker-track">${row}${row}</div>`;
}

/* ---------- interactive release verifier ---------- */
let releaseMap = new Map();
async function loadReleases() {
  const sel = $('vfSelect'), btn = $('vfRun'); if (!sel) return;
  try {
    const r = await sui.queryEvents({ query: { MoveEventType: `${PKG}::release::ReleasePublished` }, limit: 25, order: 'descending' });
    releaseMap = new Map();
    for (const e of r.data) { const j = e.parsedJson || {}; if (j.release_id) releaseMap.set(j.release_id, j); }
    if (!releaseMap.size) { sel.innerHTML = '<option>no releases yet</option>'; return; }
    sel.innerHTML = [...releaseMap.entries()].map(([id, j]) =>
      `<option value="${id}">${esc(j.version || 'release')} · ${short(id)}</option>`).join('');
    btn.disabled = false;
  } catch { sel.innerHTML = '<option>releases unavailable</option>'; }
}
function stepRow(state, label, detail) {
  const mark = state === 'ok' ? '✓' : state === 'bad' ? '✕' : '•';
  return `<div class="vstep ${state}"><span class="vmark">${mark}</span><span class="vcol">` +
    `<span class="vlabel">${esc(label)}</span>${detail ? `<span class="vdetail">${esc(detail)}</span>` : ''}</span></div>`;
}
async function verifyRelease(id) {
  const host = $('vfSteps'), j = releaseMap.get(id); if (!host || !j) return;
  const steps = [];
  const paint = (extra = '') => { host.innerHTML = extra + steps.join(''); };
  steps.push(stepRow('run', 'Reading release object on-chain…', id)); paint();
  let allOk = true;
  // 1. release object exists
  try {
    const obj = await sui.getObject({ id, options: { showType: true } });
    const ok = !!obj.data; steps[0] = stepRow(ok ? 'ok' : 'bad', ok ? 'Release object on-chain' : 'Release object missing', id); allOk &&= ok;
  } catch { steps[0] = stepRow('bad', 'Release object lookup failed', id); allOk = false; }
  paint();
  // 2. manifest fetched from Walrus
  steps.push(stepRow('run', 'Fetching source manifest from Walrus…', j.source_snapshot)); paint();
  let manifest = null;
  try {
    const res = await fetch(`${AGG}/v1/blobs/${j.source_snapshot}`);
    if (!res.ok) throw new Error('blob ' + res.status);
    manifest = await res.json();
    steps[1] = stepRow('ok', `Manifest fetched from Walrus (${manifest.files?.length ?? 0} files)`, j.source_snapshot);
  } catch (e) { steps[1] = stepRow('bad', 'Manifest unavailable on Walrus', String(e.message || e)); allOk = false; }
  paint();
  // 3. recompute tree hash
  if (manifest?.files && manifest.treeHash) {
    steps.push(stepRow('run', 'Recomputing SHA-256 tree hash…', '')); paint();
    const recomputed = await sha256Hex(manifest.files.map((f) => `${f.path}:${f.sha256}`).join('\n'));
    const ok = recomputed === manifest.treeHash;
    steps[2] = stepRow(ok ? 'ok' : 'bad', ok ? 'Tree hash recomputes — source is authentic' : 'Tree hash MISMATCH', `${recomputed.slice(0, 24)}… ${ok ? '==' : '≠'} ${String(manifest.treeHash).slice(0, 24)}…`);
    allOk &&= ok;
  } else { steps.push(stepRow('bad', 'Manifest has no tree hash to check', '')); allOk = false; }
  paint();
  // 4. artifact + report anchored
  const hasArt = !!j.build_artifact, hasRep = !!j.test_report;
  steps.push(stepRow(hasArt && hasRep ? 'ok' : 'bad', 'Build artifact + CI report anchored', `artifact ${short(j.build_artifact) || '—'} · report ${short(j.test_report) || '—'}`));
  allOk &&= (hasArt && hasRep);
  const badge = allOk
    ? '<div class="vbadge pass">✓ Verified — provenance checks out</div>'
    : '<div class="vbadge fail">✕ Verification incomplete</div>';
  paint(badge);
}

/* ---------- live app frames (render the REAL app, not the viewer chrome) ---------- */
// Inflate a buildSnapshot archive (gzip + [u32 pathLen][u32 dataLen][path][data]) and
// return its index.html — the same format the app's viewer uses.
async function inflateIndexHtml(archiveBlob) {
  const res = await fetch(`${AGG}/v1/blobs/${archiveBlob}`);
  if (!res.ok) throw new Error('archive ' + res.status);
  const gz = new Uint8Array(await res.arrayBuffer());
  const flat = new Uint8Array(await new Response(new Blob([gz]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
  const dv = new DataView(flat.buffer, flat.byteOffset, flat.byteLength);
  const dec = new TextDecoder(); let o = 0; const files = {};
  while (o + 8 <= flat.length) {
    const pl = dv.getUint32(o, false), dl = dv.getUint32(o + 4, false); o += 8;
    const path = dec.decode(flat.subarray(o, o + pl)); o += pl;
    const data = dec.decode(flat.subarray(o, o + dl)); o += dl;
    files[path] = data;
  }
  return files['index.html'] || files[Object.keys(files).find((k) => k.endsWith('.html'))] || null;
}
async function loadApps() {
  const grid = $('appsGrid'); if (!grid) return;
  try {
    const r = await sui.queryEvents({ query: { MoveEventType: `${PG_ORIG}::playground::AppPublished` }, limit: 18, order: 'descending' });
    const ids = [...new Set(r.data.map((e) => e.parsedJson?.app_id).filter(Boolean))].slice(0, 10);
    if (!ids.length) { grid.innerHTML = '<p class="muted">No published apps yet.</p>'; return; }
    const objs = await sui.multiGetObjects({ ids, options: { showContent: true } });
    const apps = objs.map((o) => { const f = o.data?.content?.fields; return f ? { id: o.data.objectId, name: f.name, archive: f.archive_blob, cat: f.category, priv: !!f.private } : null; })
      .filter((a) => a && a.archive && !a.priv).slice(0, 6);
    if (!apps.length) { grid.innerHTML = '<p class="muted">No public apps to preview yet.</p>'; return; }
    grid.innerHTML = apps.map((a) =>
      `<div class="app-card"><div class="app-frame"><div class="app-load mono">rendering…</div>` +
      `<iframe data-archive="${a.archive}" loading="lazy" title="${esc(a.name || 'app')}" sandbox="allow-scripts" scrolling="no"></iframe>` +
      `<a class="app-open" href="viewer.html?app=${a.id}&net=testnet" target="_blank" rel="noreferrer" title="open the verifiable record ↗"></a></div>` +
      `<div class="app-meta"><span class="an">${esc(a.name || 'untitled')}</span><span class="ac">${esc(a.cat || 'live')}</span></div></div>`).join('');
    // Render lazily: fetch + inflate + srcdoc the real app HTML when scrolled near.
    const io = new IntersectionObserver((ents) => {
      for (const en of ents) {
        if (!en.isIntersecting) continue;
        const f = en.target; io.unobserve(f);
        const load = f.previousElementSibling;
        inflateIndexHtml(f.dataset.archive)
          .then((html) => { if (html) { f.srcdoc = html; load?.remove(); } else if (load) load.textContent = 'preview n/a · open ↗'; })
          .catch(() => { if (load) load.textContent = 'preview n/a · open ↗'; });
      }
    }, { rootMargin: '250px' });
    grid.querySelectorAll('iframe[data-archive]').forEach((f) => io.observe(f));
  } catch { grid.innerHTML = '<p class="muted">Live apps unavailable right now.</p>'; }
}

/* ---------- hero constellation (mouse-reactive) ---------- */
function initCanvas() {
  const cv = $('heroCanvas'); if (!cv || reduceMotion) return;
  const ctx = cv.getContext('2d'); let w, h, dpr, nodes, raf;
  const mouse = { x: -999, y: -999 };
  function resize() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    const r = cv.parentElement.getBoundingClientRect();
    w = r.width; h = r.height; cv.width = w * dpr; cv.height = h * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const count = Math.max(28, Math.min(72, Math.floor(w * h / 16000)));
    nodes = Array.from({ length: count }, () => ({
      x: Math.random() * w, y: Math.random() * h,
      vx: (Math.random() - 0.5) * 0.25, vy: (Math.random() - 0.5) * 0.25,
    }));
  }
  function frame() {
    ctx.clearRect(0, 0, w, h);
    for (const n of nodes) {
      n.x += n.vx; n.y += n.vy;
      if (n.x < 0 || n.x > w) n.vx *= -1; if (n.y < 0 || n.y > h) n.vy *= -1;
      const dx = mouse.x - n.x, dy = mouse.y - n.y, d = Math.hypot(dx, dy);
      if (d < 140 && d > 0.1) { n.x += (dx / d) * 0.5; n.y += (dy / d) * 0.5; }
    }
    for (let i = 0; i < nodes.length; i++) {
      for (let k = i + 1; k < nodes.length; k++) {
        const a = nodes[i], b = nodes[k], dist = Math.hypot(a.x - b.x, a.y - b.y);
        if (dist < 120) {
          ctx.strokeStyle = `rgba(77,162,255,${(1 - dist / 120) * 0.32})`;
          ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        }
      }
    }
    for (const n of nodes) {
      const near = Math.hypot(mouse.x - n.x, mouse.y - n.y) < 140;
      ctx.fillStyle = near ? 'rgba(192,230,255,.9)' : 'rgba(77,162,255,.55)';
      ctx.beginPath(); ctx.arc(n.x, n.y, near ? 2.6 : 1.6, 0, 6.283); ctx.fill();
    }
    raf = requestAnimationFrame(frame);
  }
  const hero = cv.parentElement;
  hero.addEventListener('pointermove', (e) => { const r = hero.getBoundingClientRect(); mouse.x = e.clientX - r.left; mouse.y = e.clientY - r.top; });
  hero.addEventListener('pointerleave', () => { mouse.x = -999; mouse.y = -999; });
  window.addEventListener('resize', resize, { passive: true });
  resize(); frame();
}

/* ---------- scroll reveal ---------- */
function initReveal() {
  const els = document.querySelectorAll('.reveal');
  if (reduceMotion || !('IntersectionObserver' in window)) { els.forEach((e) => e.classList.add('in')); return; }
  const io = new IntersectionObserver((entries) => {
    for (const en of entries) if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); }
  }, { threshold: 0.12, rootMargin: '0px 0px -8% 0px' });
  els.forEach((e) => io.observe(e));
}

/* ---------- nav ---------- */
function initNav() {
  const nav = $('nav'), links = $('navLinks'), burger = $('burger');
  const onScroll = () => nav.classList.toggle('scrolled', window.scrollY > 8);
  onScroll(); window.addEventListener('scroll', onScroll, { passive: true });
  if (burger && links) {
    burger.addEventListener('click', () => { const open = links.classList.toggle('open'); burger.setAttribute('aria-expanded', open ? 'true' : 'false'); });
    links.querySelectorAll('a').forEach((a) => a.addEventListener('click', () => { links.classList.remove('open'); burger.setAttribute('aria-expanded', 'false'); }));
  }
}

/* ---------- chain: auto-cycle + clickable ---------- */
function initChain() {
  const nodes = [...document.querySelectorAll('.chain-node')];
  const arrows = [...document.querySelectorAll('.chain-arrow')];
  if (!nodes.length) return;
  let i = 0, timer = null;
  const light = (k) => { nodes.forEach((n, x) => n.classList.toggle('on', x === k)); arrows.forEach((a, x) => a.classList.toggle('lit', x === k)); };
  const start = () => { if (reduceMotion) return; timer = setInterval(() => { light(i); i = (i + 1) % nodes.length; }, 1100); };
  nodes.forEach((n, k) => n.addEventListener('click', () => { if (timer) { clearInterval(timer); timer = null; } i = k; light(k); }));
  start();
}

/* ---------- feature card tilt ---------- */
function initTilt() {
  if (reduceMotion || window.matchMedia('(pointer: coarse)').matches) return;
  document.querySelectorAll('.feat').forEach((card) => {
    card.addEventListener('pointermove', (e) => {
      const r = card.getBoundingClientRect(), px = (e.clientX - r.left) / r.width - 0.5, py = (e.clientY - r.top) / r.height - 0.5;
      card.style.transform = `translateY(-3px) perspective(700px) rotateX(${(-py * 5).toFixed(2)}deg) rotateY(${(px * 6).toFixed(2)}deg)`;
    });
    card.addEventListener('pointerleave', () => { card.style.transform = ''; });
  });
}

/* ---------- boot ---------- */
initNav(); initReveal(); initChain(); initTilt(); initCanvas();
loadStats(); loadTicker(); loadReleases(); loadApps();
const vfBtn = $('vfRun');
if (vfBtn) vfBtn.addEventListener('click', () => { const id = $('vfSelect')?.value; if (id && releaseMap.has(id)) verifyRelease(id); });
