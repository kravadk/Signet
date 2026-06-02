/* ============================================================
   WalrusForge — zkLogin (sign in with Google → Sui address, no wallet).
   Pairs with server/salt (stable salt) + a zk prover (Mysten-hosted or self-
   hosted) + the sponsor service (gasless). Implements the official Sui zkLogin
   flow from @mysten/sui/zklogin.

   NOTE: requires a Google OAuth client id, a reachable prover, and the salt
   service — configured in Playground settings (SETTINGS.zk*). Until those are
   set, the "Sign in with Google" button stays hidden.
   ============================================================ */
import { Ed25519Keypair } from 'https://esm.sh/@mysten/sui@1.18.0/keypairs/ed25519';
import { toBase64, fromBase64 } from 'https://esm.sh/@mysten/sui@1.18.0/utils';
import {
  generateNonce, generateRandomness, getExtendedEphemeralPublicKey,
  jwtToAddress, genAddressSeed, getZkLoginSignature,
} from 'https://esm.sh/@mysten/sui@1.18.0/zklogin';
import { SETTINGS, sui, STATE } from './shared.js';
import { toast } from './ui.js';

const PENDING = 'wf.zk.pending';     // sessionStorage: ephemeral + randomness + maxEpoch across redirect
const SESSION = 'wf.zk.session';     // localStorage: the active zkLogin session

const decodeJwt = (jwt) => JSON.parse(atob(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));

/** Is zkLogin configured (client id + salt + prover)? */
export function zkConfigured() {
  return !!(SETTINGS.zkGoogleClientId && SETTINGS.zkSaltUrl && SETTINGS.zkProverUrl);
}

/** Active zkLogin session or null. */
export function zkSession() {
  try { return JSON.parse(localStorage.getItem(SESSION) || 'null'); } catch { return null; }
}

export function zkLogout() {
  localStorage.removeItem(SESSION);
  if (STATE.wallet?.zk) STATE.wallet = null;
  document.dispatchEvent(new CustomEvent('wf:wallet-changed'));
}

/** Step 1 — generate ephemeral key + nonce, redirect to Google. */
export async function beginZkLogin() {
  if (!zkConfigured()) { toast('Set Google client id + salt + prover URLs in settings', { kind: 'error' }); return; }
  const { epoch } = await sui.getLatestSuiSystemState();
  const maxEpoch = Number(epoch) + 2;
  const ephemeral = Ed25519Keypair.generate();
  const randomness = generateRandomness();
  const nonce = generateNonce(ephemeral.getPublicKey(), maxEpoch, randomness);
  sessionStorage.setItem(PENDING, JSON.stringify({ secret: ephemeral.getSecretKey(), maxEpoch, randomness }));
  const redirectUri = SETTINGS.zkRedirectUri || (location.origin + location.pathname);
  const params = new URLSearchParams({
    client_id: SETTINGS.zkGoogleClientId,
    redirect_uri: redirectUri,
    response_type: 'id_token',
    scope: 'openid',
    nonce,
  });
  location.href = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

/** Step 2 — on redirect back, finish login if an id_token is in the URL fragment. */
export async function completeZkLoginFromRedirect() {
  if (!location.hash || location.hash.indexOf('id_token=') === -1) return false;
  const frag = new URLSearchParams(location.hash.slice(1));
  const jwt = frag.get('id_token');
  history.replaceState(null, '', location.pathname + location.search); // strip token from URL
  if (!jwt) return false;
  const pending = JSON.parse(sessionStorage.getItem(PENDING) || 'null');
  if (!pending) { toast('zkLogin: missing ephemeral state', { kind: 'error' }); return false; }
  try {
    const { secret, maxEpoch, randomness } = pending;
    const ephemeral = Ed25519Keypair.fromSecretKey(secret);
    const saltRes = await fetch(SETTINGS.zkSaltUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jwt }) });
    if (!saltRes.ok) throw new Error('salt: ' + ((await saltRes.json().catch(() => ({}))).error || saltRes.status));
    const { salt } = await saltRes.json();
    const payload = decodeJwt(jwt);
    const address = jwtToAddress(jwt, BigInt(salt));
    // Google may send `aud` as an array; genAddressSeed needs the same scalar jwtToAddress used.
    const aud = Array.isArray(payload.aud) ? payload.aud[0] : payload.aud;
    const addressSeed = genAddressSeed(BigInt(salt), 'sub', payload.sub, aud).toString();
    const extendedEphemeralPublicKey = getExtendedEphemeralPublicKey(ephemeral.getPublicKey());
    const proofRes = await fetch(SETTINGS.zkProverUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jwt, extendedEphemeralPublicKey, maxEpoch, jwtRandomness: randomness, salt, keyClaimName: 'sub' }),
    });
    if (!proofRes.ok) throw new Error('prover: ' + ((await proofRes.json().catch(() => ({}))).error || proofRes.status));
    const proof = await proofRes.json();
    const session = { address, secret, maxEpoch, randomness, addressSeed, proof, sub: payload.sub };
    localStorage.setItem(SESSION, JSON.stringify(session));
    sessionStorage.removeItem(PENDING);
    activateSession(session);
    toast('Signed in with Google ✓ — no wallet needed', { kind: 'success' });
    return true;
  } catch (e) {
    toast('zkLogin failed: ' + (e.message || e), { kind: 'error' });
    return false;
  }
}

/** Make a zkLogin session look like a connected "wallet" for the rest of the app. */
function activateSession(s) {
  STATE.wallet = {
    address: s.address,
    account: { address: s.address },
    zk: true,
    wallet: { name: 'zkLogin (Google)' },
  };
  document.dispatchEvent(new CustomEvent('wf:wallet-changed'));
}

/** Restore an active session on page load (if not expired vs current epoch). */
export async function restoreZkLogin() {
  const s = zkSession();
  if (!s) return false;
  try {
    const { epoch } = await sui.getLatestSuiSystemState();
    if (Number(epoch) > s.maxEpoch) { zkLogout(); return false; } // proof expired
    activateSession(s);
    return true;
  } catch { return false; }
}

/** Execute a tx as the zkLogin user. Sponsor-aware: if a sponsor URL is set, the
 *  sponsor pays gas (true no-wallet-no-gas); otherwise the zk address pays. */
export async function zkSignAndExecute(tx, okMsg) {
  const s = zkSession();
  if (!s) { toast('Not signed in', { kind: 'error' }); return null; }
  const ephemeral = Ed25519Keypair.fromSecretKey(s.secret);
  try {
    let bytes;
    let sponsorSignature = null;
    if (SETTINGS.sponsorUrl) {
      const kind = await tx.build({ client: sui, onlyTransactionKind: true });
      const r = await fetch(SETTINGS.sponsorUrl, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sender: s.address, txKindBytes: toBase64(kind) }),
      });
      if (!r.ok) throw new Error('sponsor: ' + ((await r.json().catch(() => ({}))).error || r.status));
      const j = await r.json();
      bytes = fromBase64(j.txBytes);
      sponsorSignature = j.sponsorSignature;
    } else {
      tx.setSender(s.address);
      bytes = await tx.build({ client: sui });
    }
    const { signature: userSignature } = await ephemeral.signTransaction(bytes);
    const zkSig = getZkLoginSignature({ inputs: { ...s.proof, addressSeed: s.addressSeed }, maxEpoch: s.maxEpoch, userSignature });
    const sigs = sponsorSignature ? [zkSig, sponsorSignature] : [zkSig];
    const res = await sui.executeTransactionBlock({ transactionBlock: toBase64(bytes), signature: sigs, options: { showEffects: true } });
    await sui.waitForTransaction({ digest: res.digest });
    toast(okMsg + (sponsorSignature ? ' · gas sponsored' : ''), { kind: 'success', tx: res.digest });
    document.dispatchEvent(new CustomEvent('wf:tx-done'));
    return res;
  } catch (e) {
    toast('zkLogin tx failed: ' + (e.message || e), { kind: 'error' });
    return null;
  }
}
