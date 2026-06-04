/* ============================================================
   dApp Kit-style wallet state facade for the static Signet SPA.

   The existing wallet-standard signing flow remains in wallet.js. This module
   gives the rest of the app a small stable surface similar to dApp Kit stores:
   get a snapshot, subscribe to changes, and publish explicit states.
   ============================================================ */

import { CFG, STATE } from './shared.js';

const listeners = new Set();

const walletState = {
  status: 'disconnected',
  address: null,
  account: null,
  walletName: null,
  network: CFG.network,
  chains: [],
  networkMismatch: false,
  balance: null,
  balanceLoading: false,
  balanceError: null,
  error: null,
  updatedAt: Date.now(),
};

function emit() {
  walletState.updatedAt = Date.now();
  const snapshot = getWalletSnapshot();
  for (const listener of listeners) {
    try { listener(snapshot); } catch {}
  }
  document.dispatchEvent(new CustomEvent('wf:wallet-adapter-changed', { detail: snapshot }));
}

export function getWalletSnapshot() {
  return {
    ...walletState,
    connected: walletState.status === 'connected',
    source: STATE.wallet?.zk ? 'zklogin' : 'wallet-standard',
  };
}

export function subscribeWallet(listener) {
  listeners.add(listener);
  listener(getWalletSnapshot());
  return () => listeners.delete(listener);
}

export function publishWalletConnected({ wallet, account }) {
  const chains = account?.chains || wallet?.chains || [];
  Object.assign(walletState, {
    status: 'connected',
    address: account?.address || null,
    account: account || null,
    walletName: wallet?.name || 'zkLogin',
    chains,
    networkMismatch: chains.length ? !chains.includes(`sui:${CFG.network}`) : false,
    error: null,
  });
  emit();
}

export function publishWalletDisconnected(reason = '') {
  Object.assign(walletState, {
    status: 'disconnected',
    address: null,
    account: null,
    walletName: null,
    chains: [],
    networkMismatch: false,
    balance: null,
    balanceLoading: false,
    balanceError: null,
    error: reason || null,
  });
  emit();
}

export function publishWalletAccountChanged({ wallet, account }) {
  const chains = account?.chains || wallet?.chains || [];
  Object.assign(walletState, {
    status: 'connected',
    address: account?.address || null,
    account: account || null,
    walletName: wallet?.name || walletState.walletName,
    chains,
    networkMismatch: chains.length ? !chains.includes(`sui:${CFG.network}`) : false,
    balance: null,
    balanceError: null,
    error: null,
  });
  emit();
}

export function publishWalletNetwork(chains = []) {
  Object.assign(walletState, {
    chains,
    networkMismatch: chains.length ? !chains.includes(`sui:${CFG.network}`) : false,
  });
  emit();
}

export function publishBalanceLoading() {
  walletState.balanceLoading = true;
  walletState.balanceError = null;
  emit();
}

export function publishBalanceLoaded(balance) {
  walletState.balance = balance;
  walletState.balanceLoading = false;
  walletState.balanceError = null;
  emit();
}

export function publishBalanceError(error) {
  walletState.balance = null;
  walletState.balanceLoading = false;
  walletState.balanceError = String(error?.message || error || 'balance unavailable');
  emit();
}

export function publishWalletError(error) {
  walletState.error = String(error?.message || error || 'wallet error');
  emit();
}
