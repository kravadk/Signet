/* ============================================================
   WalrusForge — lightweight UI annotator (local dev tool).

   A no-dependency, vanilla replacement for Agentation (which needs
   React). Toggle annotate mode, click any element, leave a note;
   notes are stored in localStorage and exportable as JSON so Claude
   can read exactly which element you meant and what to change.

   100% client-side. Nothing is sent anywhere. Self-contained: own
   `wfa-` class namespace + injected styles, does not touch app.js
   or styles.css. Load with: <script type="module" src="annotate.js">
   ============================================================ */

const STORE_KEY = 'wf.annotations';

/* ---------- storage ---------- */
function load() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || '[]'); } catch { return []; }
}
function save(list) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(list)); } catch {}
}
let notes = load();
let active = false;

/* ---------- a stable-ish CSS selector for a clicked element ---------- */
function selectorFor(el) {
  if (!el || el === document.body) return 'body';
  if (el.id) return '#' + el.id;
  const parts = [];
  let node = el;
  let depth = 0;
  while (node && node.nodeType === 1 && node !== document.body && depth < 4) {
    let part = node.tagName.toLowerCase();
    if (node.id) { parts.unshift('#' + node.id); break; }
    const cls = (node.getAttribute('class') || '')
      .split(/\s+/).filter((c) => c && !c.startsWith('wfa-')).slice(0, 2);
    if (cls.length) part += '.' + cls.join('.');
    const parent = node.parentElement;
    if (parent) {
      const sibs = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
      if (sibs.length > 1) part += ':nth-of-type(' + (sibs.indexOf(node) + 1) + ')';
    }
    parts.unshift(part);
    node = node.parentElement;
    depth++;
  }
  return parts.join(' > ');
}

/* short human label for the element */
function labelFor(el) {
  const txt = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40);
  return (el.tagName.toLowerCase()) + (txt ? ' “' + txt + '”' : '');
}

/* which dashboard view is currently visible (for context) */
function currentView() {
  const v = Array.from(document.querySelectorAll('.view')).find((x) => x.style.display !== 'none');
  return v ? (v.id || '').replace(/^view-/, '') : '';
}

/* ---------- styles (injected, themed to match the dashboard) ---------- */
function injectStyles() {
  if (document.getElementById('wfa-style')) return;
  const s = document.createElement('style');
  s.id = 'wfa-style';
  s.textContent = `
    .wfa-fab { position: fixed; right: 18px; bottom: 18px; z-index: 99999;
      display: inline-flex; align-items: center; gap: 8px; padding: 10px 14px;
      font: 600 13px/1 'JetBrains Mono', ui-monospace, monospace; cursor: pointer;
      color: #cfe6ff; background: #0c1622; border: 1px solid #1d3a52;
      border-radius: 12px; box-shadow: 0 6px 24px rgba(0,0,0,.5); user-select: none;
      transition: .15s; }
    .wfa-fab:hover { color: #fff; border-color: #4da2ff; }
    .wfa-fab.on { color: #061018; background: #4da2ff; border-color: #4da2ff; }
    .wfa-fab .wfa-badge { background: rgba(255,255,255,.18); border-radius: 999px;
      padding: 1px 7px; font-size: 11px; }
    .wfa-fab.on .wfa-badge { background: rgba(6,16,24,.25); }

    body.wfa-active * { cursor: crosshair !important; }
    .wfa-hover-outline { outline: 2px solid #4da2ff !important; outline-offset: 1px; }

    .wfa-pop { position: fixed; z-index: 100000; width: 300px; padding: 12px;
      background: #0c1622; border: 1px solid #1d3a52; border-radius: 12px;
      box-shadow: 0 10px 36px rgba(0,0,0,.6);
      font: 400 13px/1.4 'JetBrains Mono', ui-monospace, monospace; color: #cfe6ff; }
    .wfa-pop .wfa-target { font-size: 11px; color: #6fb0ec; margin-bottom: 8px;
      word-break: break-all; }
    .wfa-pop textarea { width: 100%; min-height: 70px; resize: vertical; padding: 8px;
      background: #061018; color: #eef6ff; border: 1px solid #1d3a52; border-radius: 8px;
      font: inherit; box-sizing: border-box; }
    .wfa-pop .wfa-row { display: flex; gap: 8px; margin-top: 8px; }
    .wfa-btn { flex: 1; padding: 7px; cursor: pointer; border-radius: 8px;
      font: 600 12px/1 'JetBrains Mono', monospace; border: 1px solid #1d3a52;
      background: #0e1d2c; color: #cfe6ff; transition: .15s; }
    .wfa-btn.primary { background: #4da2ff; color: #061018; border-color: #4da2ff; }
    .wfa-btn:hover { border-color: #4da2ff; }

    .wfa-panel { position: fixed; right: 18px; bottom: 70px; z-index: 99999;
      width: 320px; max-height: 60vh; overflow: auto; padding: 12px;
      background: #0c1622; border: 1px solid #1d3a52; border-radius: 12px;
      box-shadow: 0 10px 36px rgba(0,0,0,.6); display: none;
      font: 400 12px/1.45 'JetBrains Mono', ui-monospace, monospace; color: #cfe6ff; }
    .wfa-panel.open { display: block; }
    .wfa-panel h4 { font-size: 12px; color: #6fb0ec; margin: 0 0 8px; display: flex;
      justify-content: space-between; align-items: center; }
    .wfa-item { padding: 8px; border: 1px solid #14283a; border-radius: 8px;
      margin-bottom: 8px; background: #08111b; }
    .wfa-item .wfa-sel { color: #6fb0ec; font-size: 10.5px; word-break: break-all; }
    .wfa-item .wfa-note { color: #eef6ff; margin-top: 4px; }
    .wfa-item .wfa-del { float: right; cursor: pointer; color: #f15b4c; }
    .wfa-empty { color: #6b6b6e; padding: 6px 0; }
  `;
  document.head.appendChild(s);
}

/* ---------- floating button + panel ---------- */
let fab, panel;
function buildChrome() {
  fab = document.createElement('div');
  fab.className = 'wfa-fab';
  fab.innerHTML = '✎ Annotate <span class="wfa-badge">' + notes.length + '</span>';
  fab.title = 'Toggle annotate mode · click an element to leave a note for Claude';
  fab.addEventListener('click', toggle);
  document.body.appendChild(fab);

  panel = document.createElement('div');
  panel.className = 'wfa-panel';
  document.body.appendChild(panel);
  renderPanel();
}

function setBadge() {
  const b = fab.querySelector('.wfa-badge');
  if (b) b.textContent = notes.length;
}

function renderPanel() {
  panel.innerHTML =
    '<h4>Annotations (' + notes.length + ')' +
      '<span><button class="wfa-btn primary" id="wfaCopy" style="padding:5px 9px">Copy for Claude</button> ' +
      '<button class="wfa-btn" id="wfaClear" style="padding:5px 9px">Clear</button></span></h4>' +
    (notes.length
      ? notes.map((n) =>
          '<div class="wfa-item" data-id="' + n.id + '">' +
            '<span class="wfa-del" data-del="' + n.id + '" title="delete">✕</span>' +
            '<div class="wfa-sel">' + esc(n.view ? '[' + n.view + '] ' : '') + esc(n.selector) + '</div>' +
            '<div class="wfa-note">' + esc(n.note) + '</div>' +
          '</div>').join('')
      : '<div class="wfa-empty">No annotations yet. Turn on annotate mode and click an element.</div>');

  const copy = panel.querySelector('#wfaCopy');
  if (copy) copy.addEventListener('click', copyAll);
  const clear = panel.querySelector('#wfaClear');
  if (clear) clear.addEventListener('click', () => {
    if (!notes.length) return;
    notes = []; save(notes); setBadge(); renderPanel();
  });
  panel.querySelectorAll('[data-del]').forEach((b) =>
    b.addEventListener('click', () => {
      notes = notes.filter((n) => String(n.id) !== b.dataset.del);
      save(notes); setBadge(); renderPanel();
    }));
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

async function copyAll() {
  const payload = JSON.stringify(notes, null, 2);
  try {
    await navigator.clipboard.writeText(payload);
    flash('Copied ' + notes.length + ' annotation(s)');
  } catch {
    // fallback: show in a prompt for manual copy
    window.prompt('Copy annotations JSON:', payload);
  }
}

function flash(msg) {
  fab.innerHTML = '✓ ' + msg;
  setTimeout(() => { fab.innerHTML = '✎ Annotate <span class="wfa-badge">' + notes.length + '</span>'; }, 1400);
}

/* ---------- annotate mode ---------- */
let hovered = null;
function toggle() {
  active = !active;
  fab.classList.toggle('on', active);
  document.body.classList.toggle('wfa-active', active);
  panel.classList.toggle('open', active);
  if (active) {
    document.addEventListener('mouseover', onHover, true);
    document.addEventListener('click', onPick, true);
  } else {
    document.removeEventListener('mouseover', onHover, true);
    document.removeEventListener('click', onPick, true);
    clearHover();
  }
}

function isOurs(el) {
  return el.closest('.wfa-fab, .wfa-panel, .wfa-pop, #wfa-style');
}

function clearHover() {
  if (hovered) { hovered.classList.remove('wfa-hover-outline'); hovered = null; }
}

function onHover(e) {
  const el = e.target;
  if (isOurs(el)) { clearHover(); return; }
  if (hovered === el) return;
  clearHover();
  hovered = el;
  el.classList.add('wfa-hover-outline');
}

function onPick(e) {
  const el = e.target;
  if (isOurs(el)) return;          // let our own UI work normally
  e.preventDefault();
  e.stopPropagation();
  openPopover(el, e.clientX, e.clientY);
}

/* ---------- note popover ---------- */
let pop;
function openPopover(el, x, y) {
  closePopover();
  const selector = selectorFor(el);
  pop = document.createElement('div');
  pop.className = 'wfa-pop';
  pop.style.left = Math.min(x, window.innerWidth - 320) + 'px';
  pop.style.top = Math.min(y, window.innerHeight - 180) + 'px';
  pop.innerHTML =
    '<div class="wfa-target">' + esc(labelFor(el)) + '<br>' + esc(selector) + '</div>' +
    '<textarea placeholder="What should change here?"></textarea>' +
    '<div class="wfa-row">' +
      '<button class="wfa-btn primary" data-save>Save</button>' +
      '<button class="wfa-btn" data-cancel>Cancel</button>' +
    '</div>';
  document.body.appendChild(pop);
  const ta = pop.querySelector('textarea');
  ta.focus();
  pop.querySelector('[data-cancel]').addEventListener('click', closePopover);
  pop.querySelector('[data-save]').addEventListener('click', () => {
    const note = ta.value.trim();
    if (note) {
      notes.push({
        id: notes.length ? Math.max(...notes.map((n) => n.id)) + 1 : 1,
        ts: new Date().toISOString(),
        view: currentView(),
        selector,
        label: labelFor(el),
        note,
      });
      save(notes); setBadge(); renderPanel();
    }
    closePopover();
  });
  ta.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) pop.querySelector('[data-save]').click();
    if (ev.key === 'Escape') closePopover();
  });
}
function closePopover() {
  if (pop) { pop.remove(); pop = null; }
}

/* ---------- boot ---------- */
function boot() {
  injectStyles();
  buildChrome();
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
