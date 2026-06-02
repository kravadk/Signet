/* ============================================================
   WalrusForge — UI primitives: toasts, copy, modal.
   Pure DOM, no chain access. Imported by app.js and wallet.js.
   ============================================================ */

import { explorerTx } from './shared.js';

/* ---------- Toast center ---------- */
function toastHost() {
  let host = document.getElementById('toastHost');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toastHost';
    host.className = 'toast-host';
    document.body.appendChild(host);
  }
  return host;
}

const ICONS = {
  success: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5 5 9-10"/></svg>',
  error: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
  info: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8h.01M11 12h1v4h1"/><circle cx="12" cy="12" r="9"/></svg>',
};

/**
 * Show a toast. opts: { kind:'success'|'error'|'info', tx, action:{label,onClick}, timeout }
 */
export function toast(message, opts = {}) {
  const kind = opts.kind || 'info';
  const host = toastHost();
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  let actionHtml = '';
  if (opts.tx) actionHtml = `<a class="toast-link" target="_blank" rel="noreferrer" href="${explorerTx(opts.tx)}">view tx ↗</a>`;
  el.innerHTML =
    `<span class="toast-ico">${ICONS[kind] || ICONS.info}</span>` +
    `<span class="toast-msg"></span>` +
    actionHtml +
    `<button class="toast-x" aria-label="dismiss">×</button>`;
  // message may contain untrusted text (error bodies, on-chain/LLM strings) — set as text, never HTML.
  el.querySelector('.toast-msg').textContent = String(message);
  host.appendChild(el);

  const dismiss = () => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 240);
  };

  if (opts.action) {
    const retryBtn = document.createElement('button');
    retryBtn.className = 'toast-retry';
    retryBtn.textContent = opts.action.label;
    retryBtn.addEventListener('click', () => { dismiss(); opts.action.onClick(); });
    el.insertBefore(retryBtn, el.querySelector('.toast-x'));
  }

  el.querySelector('.toast-x').addEventListener('click', dismiss);
  requestAnimationFrame(() => el.classList.add('shown'));
  const ms = opts.timeout ?? (kind === 'error' ? 6000 : 3200);
  if (ms > 0) setTimeout(dismiss, ms);
  return dismiss;
}

/* ---------- Copy helpers ---------- */
export function copyText(text, label = 'Copied') {
  try {
    if (navigator.clipboard?.writeText) {
      return navigator.clipboard.writeText(text)
        .then(() => toast(`${label} ✓`, { kind: 'success', timeout: 1600 }))
        .catch(() => toast('Copy failed', { kind: 'error' }));
    }
    // Fallback for insecure (http) contexts / older browsers where clipboard API is absent.
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.focus(); ta.select();
    const ok = document.execCommand('copy'); ta.remove();
    toast(ok ? `${label} ✓` : 'Copy failed', { kind: ok ? 'success' : 'error', timeout: 1600 });
  } catch { toast('Copy failed', { kind: 'error' }); }
  return Promise.resolve();
}

/** Inline copy button HTML — pairs with the global click delegate below. */
export function copyBtn(value, title = 'Copy') {
  return `<button class="copy-btn" data-tip="${title}" data-copy="${value}" onclick="event.stopPropagation()">` +
    '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' +
    '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg></button>';
}

/* Global delegate: any [data-copy] copies its value. */
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-copy]');
  if (btn) { e.preventDefault(); copyText(btn.dataset.copy, 'Copied'); }
});

/* Backwards-compat: command panels still call window.__wfCopy(el) reading data-cmd. */
window.__wfCopy = (el) => copyText(el.dataset.cmd, 'Command copied');

/* ---------- Modal primitive ---------- */
let modalEl;
/**
 * Open a modal. opts: { title, bodyHtml, onMount(modalBody), wide }
 * Returns a close() function.
 */
export function openModal({ title, bodyHtml = '', onMount, wide = false }) {
  closeModal();
  modalEl = document.createElement('div');
  modalEl.className = 'modal-overlay';
  modalEl.innerHTML =
    `<div class="modal ${wide ? 'modal-wide' : ''}" role="dialog" aria-modal="true">` +
      `<div class="modal-head"><h3>${title}</h3>` +
      `<button class="modal-x" aria-label="close">×</button></div>` +
      `<div class="modal-body">${bodyHtml}</div>` +
    `</div>`;
  document.body.appendChild(modalEl);
  modalEl.querySelector('.modal-x').addEventListener('click', closeModal);
  modalEl.addEventListener('click', (e) => { if (e.target === modalEl) closeModal(); });
  requestAnimationFrame(() => modalEl.classList.add('shown'));
  if (onMount) onMount(modalEl.querySelector('.modal-body'));
  return closeModal;
}

export function closeModal() {
  if (!modalEl) return;
  const el = modalEl; modalEl = null;
  el.classList.add('leaving');
  setTimeout(() => el.remove(), 200);
}

/* Esc closes modal. */
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeModal();
});

/* ---------- Custom tooltip (replaces native title for key controls) ---------- */
let tipEl;
function ensureTip() {
  if (!tipEl) { tipEl = document.createElement('div'); tipEl.className = 'wf-tip'; document.body.appendChild(tipEl); }
  return tipEl;
}
document.addEventListener('mouseover', (e) => {
  const t = e.target.closest('[data-tip]');
  if (!t) return;
  const tip = ensureTip();
  tip.textContent = t.dataset.tip;
  const r = t.getBoundingClientRect();
  tip.style.left = Math.round(r.left + r.width / 2 - tip.offsetWidth / 2) + 'px';
  tip.style.top = Math.round(r.top - tip.offsetHeight - 8) + 'px';
  requestAnimationFrame(() => tip.classList.add('show'));
});
document.addEventListener('mouseout', (e) => {
  if (e.target.closest('[data-tip]') && tipEl) tipEl.classList.remove('show');
});

/* ---------- Skeleton placeholders (shimmer while loading) ---------- */
export function skeletonCards(n = 4) {
  let h = '';
  for (let i = 0; i < n; i++) {
    h += '<div class="skeleton-card">' +
      '<div class="skel-row"><span class="skel-dot loading-shimmer"></span>' +
      '<span class="skel-line loading-shimmer" style="width:46%"></span></div>' +
      '<div class="skel-line loading-shimmer" style="width:72%;margin-top:14px"></div>' +
      '<div class="skel-line loading-shimmer" style="width:38%;margin-top:10px"></div>' +
      '<div class="skel-line loading-shimmer" style="width:60%;margin-top:10px"></div>' +
    '</div>';
  }
  return h;
}
export function skeletonRows(n = 5) {
  let h = '';
  for (let i = 0; i < n; i++) {
    h += '<tr class="skel-tr">' +
      '<td><span class="skel-line loading-shimmer" style="width:80px"></span></td>' +
      '<td><span class="skel-line loading-shimmer" style="width:60%"></span></td>' +
      '<td><span class="skel-line loading-shimmer" style="width:70px"></span></td>' +
      '<td><span class="skel-line loading-shimmer" style="width:30px"></span></td>' +
      '<td><span class="skel-line loading-shimmer" style="width:64px"></span></td></tr>';
  }
  return h;
}
export function skeletonList(n = 4) {
  let h = '';
  for (let i = 0; i < n; i++) {
    h += '<div class="skeleton-card" style="display:flex;gap:14px;align-items:center">' +
      '<span class="skel-dot loading-shimmer" style="width:46px;height:46px;border-radius:12px"></span>' +
      '<div style="flex:1"><div class="skel-line loading-shimmer" style="width:50%"></div>' +
      '<div class="skel-line loading-shimmer" style="width:30%;margin-top:8px"></div></div></div>';
  }
  return h;
}

/* ---------- Relative time ("12s ago") ---------- */
export function relativeTime(ts) {
  if (!ts) return '—';
  const diff = Math.max(0, Date.now() - ts);
  const s = Math.floor(diff / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
