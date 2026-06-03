/* ============================================================
   Signet — wallet connect + write actions (browser dApp).
   Uses @mysten/wallet-standard for discovery/connect and
   @mysten/sui/transactions for PTBs. PTB builders mirror
   app/src/lib/sui.ts exactly. SuiNS reverse-lookup included.
   ============================================================ */

import { getWallets } from 'https://esm.sh/@mysten/wallet-standard@0.16.0';
import { Transaction } from 'https://esm.sh/@mysten/sui@1.18.0/transactions';
import { getFaucetHost, requestSuiFromFaucetV1 } from 'https://esm.sh/@mysten/sui@1.18.0/faucet';
import { toBase64, fromBase64 } from 'https://esm.sh/@mysten/sui@1.18.0/utils';
import {
  CFG, SETTINGS, sui, STATE, $, short, suiAmount, escapeHtml,
  explorerAddress, SCOPE_OPEN_PR, SCOPE_REVIEW, withTimeout,
} from './shared.js';
import { toast, copyText, openModal, closeModal } from './ui.js';
import { zkSignAndExecute, zkLogout } from './zklogin.js';

const LAST_WALLET = 'wf.wallet';

/* ---------- Discovery ---------- */
function suiWallets() {
  return getWallets().get().filter((w) =>
    w.chains?.some((c) => c.startsWith('sui:')) &&
    w.features['standard:connect'] && w.features['sui:signAndExecuteTransaction']);
}

/* ---------- Connect / disconnect ---------- */
export async function connectWallet(preferName) {
  const wallets = suiWallets();
  if (!wallets.length) {
    toast('No Sui wallet found — install Sui Wallet or Slush', { kind: 'error' });
    return;
  }
  let w = preferName ? wallets.find((x) => x.name === preferName) : null;
  if (!w && wallets.length === 1) w = wallets[0];
  if (!w) { return pickWallet(wallets); }
  await doConnect(w);
}

function pickWallet(wallets) {
  openModal({
    title: 'Connect a wallet',
    bodyHtml: '<div class="wallet-pick">' + wallets.map((w, i) =>
      `<button class="wm-item wallet-pick-btn" data-i="${i}">` +
      (w.icon ? `<img src="${w.icon}" width="22" height="22" style="border-radius:5px"/>` : '') +
      `<span>${escapeHtml(w.name)}</span></button>`).join('') + '</div>',
    onMount(body) {
      body.querySelectorAll('.wallet-pick-btn').forEach((b) =>
        b.addEventListener('click', () => { closeModal(); doConnect(wallets[Number(b.dataset.i)]); }));
    },
  });
}

async function doConnect(w) {
  try {
    const res = await w.features['standard:connect'].connect();
    const account = res.accounts[0];
    if (!account) throw new Error('no account');
    STATE.wallet = { address: account.address, account, wallet: w };
    localStorage.setItem(LAST_WALLET, w.name);
    toast(`Connected ${short(account.address)}`, { kind: 'success' });
    // Best-effort network-mismatch warning: if the account advertises chains and none
    // match the active network, txs will be rejected — tell the user how to fix it.
    const chains = account.chains || [];
    if (chains.length && !chains.includes(`sui:${CFG.network}`)) {
      toast(`This wallet is on ${chains.join(', ').replace(/sui:/g, '')} — Signet is on ${CFG.network}. Switch your wallet's network, or click the network badge to switch the app.`, { kind: 'info', timeout: 6000 });
    }
    await afterConnect();
  } catch (e) {
    toast('Connect failed: ' + (e?.message || e), { kind: 'error' });
  }
}

export function disconnectWallet() {
  menuOpen = false;
  if (STATE.wallet?.zk) {
    zkLogout(); // clears the zkLogin session in localStorage (else it restores on reload)
  } else {
    try { STATE.wallet?.wallet?.features?.['standard:disconnect']?.disconnect(); } catch {}
  }
  STATE.wallet = null;
  STATE.myCaps = { owner: new Map(), agent: new Map() };
  localStorage.removeItem(LAST_WALLET);
  renderConnect();
  document.dispatchEvent(new CustomEvent('wf:wallet-changed'));
  toast('Disconnected', { kind: 'info', timeout: 1500 });
}

async function afterConnect() {
  renderConnect();
  await Promise.all([loadBalance(), loadMyCaps(), resolveName(STATE.wallet.address)]);
  renderConnect();
  document.dispatchEvent(new CustomEvent('wf:wallet-changed'));
}

/* ---------- Balance ---------- */
async function loadBalance() {
  try {
    const b = await withTimeout(sui.getBalance({ owner: STATE.wallet.address }), 12000, 'balance');
    STATE.wallet.balance = b.totalBalance;
    STATE.wallet.balanceError = false;
  } catch {
    STATE.wallet.balance = null;
    STATE.wallet.balanceError = true; // distinguishes "failed to load" from "0" so the menu can offer retry
  }
}

/* ---------- Owned caps (RepoOwnerCap / AgentCap) ---------- */
export async function loadMyCaps() {
  STATE.myCaps = { owner: new Map(), agent: new Map() };
  if (!STATE.wallet) return;
  const owner = STATE.wallet.address;
  for (const [type, bucket] of [['RepoOwnerCap', 'owner'], ['AgentCap', 'agent']]) {
    try {
      let cursor = null;
      do {
        const res = await sui.getOwnedObjects({
          owner, cursor,
          filter: { StructType: `${CFG.packageId}::forge::${type}` },
          options: { showContent: true },
        });
        for (const o of res.data) {
          const f = o.data?.content?.fields ?? {};
          const repoId = f.repo_id;
          if (repoId) STATE.myCaps[bucket].set(repoId, { capId: o.data.objectId, scopes: Number(f.scopes ?? 0) });
        }
        cursor = res.hasNextPage ? res.nextCursor : null;
      } while (cursor);
    } catch (e) { console.warn('loadMyCaps', type, e); }
  }
}

export function ownerCapFor(repoId) { return STATE.myCaps.owner.get(repoId)?.capId || null; }
export function agentCapFor(repoId) { return STATE.myCaps.agent.get(repoId) || null; }

/* ---------- SuiNS reverse-lookup (native SuiClient, no extra SDK) ---------- */
export async function resolveName(addr) {
  if (!addr || STATE.nameCache.has(addr)) return STATE.nameCache.get(addr);
  let name = null;
  try {
    // Mysten testnet fullnodes resolve SuiNS natively — no extra SDK needed.
    const r = await sui.resolveNameServiceNames({ address: addr, limit: 1 });
    name = r?.data?.[0] || null;
  } catch {}
  STATE.nameCache.set(addr, name);
  return name;
}
/** Sync helper for renders: returns cached name or short(addr). */
export function nameOrShort(addr) {
  const n = STATE.nameCache.get(addr);
  return n || short(addr);
}

/* ---------- Connect button + wallet menu ---------- */
let menuOpen = false;
export function renderConnect() {
  const btn = $('connectBtn');
  const label = $('connectLabel');
  const menu = $('walletMenu');
  if (!btn) return;
  if (!STATE.wallet) {
    btn.classList.remove('connected');
    label.textContent = 'Connect';
    menu.classList.remove('show');
    return;
  }
  btn.classList.add('connected');
  const a = STATE.wallet.address;
  label.textContent = STATE.nameCache.get(a) || short(a);
}

function toggleMenu() {
  const menu = $('walletMenu');
  if (!STATE.wallet) return;
  menuOpen = !menuOpen;
  if (!menuOpen) { menu.classList.remove('show'); return; }
  const a = STATE.wallet.address;
  const bal = STATE.wallet.balanceError
    ? 'failed to load <button class="wm-retry" data-act="rebal">retry</button>'
    : (STATE.wallet.balance != null ? suiAmount(STATE.wallet.balance) + ' SUI' : '…');
  const ownerN = STATE.myCaps.owner.size, agentN = STATE.myCaps.agent.size;
  menu.innerHTML =
    `<div class="wm-row"><span class="k">Address</span><span class="v">${short(a)}</span></div>` +
    `<div class="wm-row"><span class="k">Balance</span><span class="v wm-bal">${bal}</span></div>` +
    `<div class="wm-row"><span class="k">Caps</span><span class="v">${ownerN} owner · ${agentN} agent</span></div>` +
    '<div class="wm-sep"></div>' +
    '<div class="wm-item" data-act="copy">Copy address</div>' +
    (CFG.network === 'testnet' ? '<div class="wm-item" data-act="faucet">Fund (testnet faucet)</div>' : '') +
    `<a class="wm-item" target="_blank" rel="noreferrer" href="${explorerAddress(a)}">View on explorer ↗</a>` +
    '<div class="wm-item" data-act="disconnect">Disconnect</div>';
  menu.classList.add('show');
  menu.querySelector('[data-act=copy]')?.addEventListener('click', () => { copyText(a, 'Address copied'); });
  menu.querySelector('[data-act=rebal]')?.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    await loadBalance(); renderConnect();
    menuOpen = false; toggleMenu(); // rebuild the menu with fresh balance + handlers
  });
  menu.querySelector('[data-act=faucet]')?.addEventListener('click', async () => {
    toast('Requesting testnet SUI…', { kind: 'info', timeout: 1500 });
    try { await requestSuiFromFaucetV1({ host: getFaucetHost('testnet'), recipient: a }); toast('Faucet sent — balance updates shortly', { kind: 'success' }); loadBalance().then(() => renderConnect()); }
    catch (e) { toast('Faucet: ' + String(e?.message || e).slice(0, 60), { kind: 'error' }); }
  });
  menu.querySelector('[data-act=disconnect]')?.addEventListener('click', () => { menuOpen = false; menu.classList.remove('show'); disconnectWallet(); });
}

/* ---------- Bootstrap wiring ---------- */
export function wireWallet() {
  $('connectBtn')?.addEventListener('click', () => {
    if (STATE.wallet) toggleMenu();
    else connectWallet();
  });
  document.addEventListener('click', (e) => {
    if (menuOpen && !e.target.closest('#walletMenu') && !e.target.closest('#connectBtn')) {
      menuOpen = false; const m = $('walletMenu'); if (m) m.classList.remove('show');
    }
  });
  // After any successful tx, the on-chain balance changed — refresh it so the wallet
  // chip/menu never shows a stale number (previously it only updated on reconnect).
  document.addEventListener('wf:tx-done', () => {
    if (!STATE.wallet) return;
    loadBalance().then(() => {
      renderConnect();
      const balEl = document.querySelector('#walletMenu .wm-bal');
      if (menuOpen && balEl) balEl.textContent = STATE.wallet.balance != null ? suiAmount(STATE.wallet.balance) + ' SUI' : '…';
    }).catch(() => {});
  });
  // auto-reconnect (wallets register asynchronously; retry briefly)
  const last = localStorage.getItem(LAST_WALLET);
  if (last) {
    let tries = 0;
    const iv = setInterval(() => {
      const w = suiWallets().find((x) => x.name === last);
      if (w) { clearInterval(iv); doConnect(w); }
      else if (++tries > 10) clearInterval(iv);
    }, 200);
  }
}

/* ============================================================
   Write actions — PTB builders mirror app/src/lib/sui.ts.
   Each: build Transaction → wallet sign+execute → wait → toast.
   ============================================================ */

export async function signAndRun(tx, okMsg) {
  if (!STATE.wallet) { toast('Connect a wallet first', { kind: 'error' }); return null; }
  // zkLogin users sign with their ephemeral key (sponsor-aware) instead of a wallet.
  if (STATE.wallet.zk) return zkSignAndExecute(tx, okMsg);
  const feat = STATE.wallet.wallet.features['sui:signAndExecuteTransaction'];
  try {
    const res = await feat.signAndExecuteTransaction({
      transaction: tx,
      account: STATE.wallet.account,
      chain: `sui:${CFG.network}`,
    });
    const digest = res.digest;
    // Authoritative result from the fullnode — a Move-aborted tx still lands on-chain
    // with status "failure", so we MUST check effects, not just that it executed.
    const conf = await sui.waitForTransaction({ digest, options: { showEffects: true } });
    if (conf.effects?.status?.status === 'failure') {
      throw new Error(conf.effects.status.error || 'transaction aborted on-chain');
    }
    toast(okMsg, { kind: 'success', tx: digest });
    document.dispatchEvent(new CustomEvent('wf:tx-done'));
    return res;
  } catch (e) {
    toast('Tx failed: ' + (e?.message || e), { kind: 'error' });
    return null;
  }
}

/* Sponsored execution: the wallet only SIGNS, a sponsor service pays the gas.
   Returns the tx result on success, or `undefined` if sponsoring is unavailable
   or fails (so the caller can fall back to user-paid signAndRun). Only used for
   value-free playground actions the sponsor allowlists. */
export async function signAndRunSponsored(tx, okMsg) {
  if (!STATE.wallet) { toast('Connect a wallet first', { kind: 'error' }); return undefined; }
  // zkLogin sessions have no wallet-standard features — they sign via zkSignAndExecute
  // (reached through signAndRun's zk branch). Bail so the caller falls back to it.
  if (STATE.wallet.zk) return undefined;
  const sponsorUrl = SETTINGS.sponsorUrl;
  const signFeat = STATE.wallet.wallet.features?.['sui:signTransaction'];
  if (!sponsorUrl || !signFeat) return undefined; // not configured → caller falls back
  try {
    const kind = await tx.build({ client: sui, onlyTransactionKind: true });
    const r = await fetch(sponsorUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sender: STATE.wallet.address, txKindBytes: toBase64(kind) }),
    });
    if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || ('sponsor ' + r.status)); }
    const { txBytes, sponsorSignature } = await r.json();
    // Wallet signs the sponsor-built bytes verbatim (reconstructed, gas already set).
    const reTx = Transaction.from(fromBase64(txBytes));
    const signed = await signFeat.signTransaction({ transaction: reTx, account: STATE.wallet.account, chain: `sui:${CFG.network}` });
    const res = await sui.executeTransactionBlock({
      transactionBlock: txBytes,
      signature: [signed.signature, sponsorSignature],
      options: { showEffects: true },
    });
    // Executed but aborted on-chain → surface the error and DO NOT fall back to
    // user-paid (it would just abort again). Return null so the caller skips fallback.
    if (res.effects?.status?.status === 'failure') {
      toast('Tx failed: ' + (res.effects.status.error || 'aborted on-chain'), { kind: 'error', tx: res.digest });
      return null;
    }
    await sui.waitForTransaction({ digest: res.digest });
    toast(okMsg + ' · gas sponsored', { kind: 'success', tx: res.digest });
    document.dispatchEvent(new CustomEvent('wf:tx-done'));
    return res;
  } catch (e) {
    toast('Sponsored tx unavailable (' + (e?.message || e) + ') — using your wallet', { kind: 'info', timeout: 2500 });
    return undefined; // fall back to user-paid
  }
}

/* Like signAndRun but returns created object ids of a given type suffix.
   Wallets don't always return objectChanges, so we re-fetch the tx by digest. */
export async function signAndRunCreated(tx, okMsg, typeSuffix) {
  const res = await signAndRun(tx, okMsg);
  if (!res) return null;
  try {
    const full = await sui.getTransactionBlock({ digest: res.digest, options: { showObjectChanges: true } });
    const created = (full.objectChanges ?? [])
      .filter((c) => c.type === 'created' && String(c.objectType).includes(typeSuffix))
      .map((c) => c.objectId);
    return { digest: res.digest, created };
  } catch {
    return { digest: res.digest, created: [] };
  }
}

/* Upload bytes/text to Walrus publisher (no wallet needed). */
export async function walrusPut(data) {
  const body = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const res = await fetch(`${CFG.walrusPublisher}/v1/blobs?epochs=5`, {
    method: 'PUT', body, headers: { 'content-type': 'application/octet-stream' },
  });
  if (!res.ok) throw new Error(`Walrus store ${res.status}`);
  const j = await res.json();
  return j.newlyCreated?.blobObject?.blobId || j.alreadyCertified?.blobId;
}

export const pkgCall = (tx, fn, args) => tx.moveCall({ target: `${CFG.packageId}::${fn}`, arguments: args });

/* ----- permissionless ----- */
export async function actOpenIssue(repoId) {
  formModal('Open an issue', [
    { id: 'title', label: 'Title', type: 'text' },
    { id: 'body', label: 'Body', type: 'textarea' },
  ], async (v, setBusy) => {
    setBusy(true);
    try {
      const blob = await walrusPut(v.body || '');
      const tx = new Transaction();
      pkgCall(tx, 'issue::open_issue', [tx.object(repoId), tx.pure.string(v.title), tx.pure.string(blob)]);
      const r = await signAndRun(tx, 'Issue opened'); if (r) closeModal();
    } catch (e) { toast('Failed: ' + e.message, { kind: 'error' }); } finally { setBusy(false); }
  });
}

export async function actPostBounty(repoId) {
  formModal('Post a bounty', [
    { id: 'title', label: 'Title', type: 'text' },
    { id: 'amount', label: 'Amount (SUI)', type: 'number' },
  ], async (v, setBusy) => {
    setBusy(true);
    try {
      const mist = Math.round(Number(v.amount) * 1e9);
      const tx = new Transaction();
      const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(mist)]);
      pkgCall(tx, 'bounty::post_bounty', [tx.object(repoId), tx.pure.string(v.title), coin]);
      const r = await signAndRun(tx, 'Bounty posted'); if (r) closeModal();
    } catch (e) { toast('Failed: ' + e.message, { kind: 'error' }); } finally { setBusy(false); }
  });
}

/* ----- owner-only ----- */
export async function actGrantAgent(repoId, ownerCapId) {
  formModal('Grant AgentCap', [
    { id: 'recipient', label: 'Agent address (0x…)', type: 'text' },
    { id: 'label', label: 'Label', type: 'text' },
  ], async (v, setBusy) => {
    setBusy(true);
    try {
      const tx = new Transaction();
      pkgCall(tx, 'forge::grant_agent_cap', [
        tx.object(repoId), tx.object(ownerCapId), tx.pure.address(v.recipient),
        tx.pure.u8(SCOPE_OPEN_PR | SCOPE_REVIEW), tx.pure.u64(0), tx.pure.string(v.label || 'agent'),
      ]);
      const r = await signAndRun(tx, 'AgentCap granted'); if (r) closeModal();
    } catch (e) { toast('Failed: ' + e.message, { kind: 'error' }); } finally { setBusy(false); }
  });
}

export async function actMergePr(repoId, prId, ownerCapId, reputationId) {
  const tx = new Transaction();
  pkgCall(tx, 'pull_request::merge_pr', [tx.object(repoId), tx.object(reputationId), tx.object(prId), tx.object(ownerCapId)]);
  await signAndRun(tx, 'PR merged');
}

/** Find the shared RepoReputation ledger for a repo (created in the RepoCreated tx). */
async function findLedger(repoId) {
  const ev = await sui.queryEvents({
    query: { MoveEventType: `${CFG.packageId}::forge::RepoCreated` },
    limit: 100, order: 'descending',
  });
  const e = ev.data.find((x) => x.parsedJson?.repo_id === repoId);
  if (!e) return null;
  const tx = await sui.getTransactionBlock({ digest: e.id.txDigest, options: { showObjectChanges: true } });
  const ch = (tx.objectChanges || []).find((o) =>
    o.type === 'created' && String(o.objectType).endsWith('::reputation::RepoReputation'));
  return ch ? ch.objectId : null;
}

/** Vouch for another agent (raises their trust score). */
export async function actVouch(repoId, subject) {
  if (!STATE.wallet) { toast('Connect a wallet first', { kind: 'error' }); return; }
  toast('Finding reputation ledger…', { kind: 'info', timeout: 1200 });
  const ledger = await findLedger(repoId);
  if (!ledger) { toast('Reputation ledger not found', { kind: 'error' }); return; }
  const tx = new Transaction();
  pkgCall(tx, 'reputation::vouch', [tx.object(ledger), tx.pure.address(subject)]);
  await signAndRun(tx, 'Vouched for ' + short(subject));
}

/** Owner sets the minimum approvals required before merge. */
export async function actSetApprovals(repoId, ownerCapId) {
  formModal('Set minimum approvals', [
    { id: 'n', label: 'Minimum APPROVE reviews (0 disables)', type: 'number' },
  ], async (v, setBusy) => {
    setBusy(true);
    try {
      const tx = new Transaction();
      pkgCall(tx, 'forge::set_min_approvals', [tx.object(repoId), tx.object(ownerCapId), tx.pure.u8(Number(v.n) || 0)]);
      const r = await signAndRun(tx, 'Min approvals set'); if (r) closeModal();
    } catch (e) { toast('Failed: ' + e.message, { kind: 'error' }); } finally { setBusy(false); }
  });
}

/* ---------- generic form modal ---------- */
function formModal(title, fields, onSubmit) {
  const body = fields.map((f) =>
    f.type === 'textarea'
      ? `<label>${f.label}</label><textarea id="fm-${f.id}"></textarea>`
      : `<label>${f.label}</label><input type="${f.type}" id="fm-${f.id}">`).join('') +
    '<div class="modal-actions"><button class="btn-ghost" id="fm-cancel">Cancel</button>' +
    '<button class="btn-primary" id="fm-submit">Sign &amp; submit</button></div>';
  openModal({ title, bodyHtml: body, onMount(m) {
    m.querySelector('#fm-cancel').addEventListener('click', closeModal);
    const submit = m.querySelector('#fm-submit');
    submit.addEventListener('click', () => {
      const v = {}; fields.forEach((f) => { v[f.id] = m.querySelector(`#fm-${f.id}`).value; });
      onSubmit(v, (busy) => { submit.disabled = busy; submit.textContent = busy ? 'Signing…' : 'Sign & submit'; });
    });
  } });
}
