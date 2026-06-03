/* ============================================================
   Seal — owner-only client-side encryption for PRIVATE Playground apps.

   A private app's Walrus archive is encrypted in the browser with Mysten Seal
   under an identity NAMESPACED to the app's on-chain object id. Seal key servers
   release decryption shares only when the on-chain policy `seal_approve_app_owner`
   approves — and that policy aborts unless the requester is the app's builder. So
   only the builder can ever decrypt, enforced on-chain (not by this client).

   Identity = the app's 32-byte object id. The Move policy `id_in_app` checks the
   decryption identity is prefixed by `object::id_bytes(app)`, so encrypting under
   the app id is exactly what the policy authorizes.

   This whole module is best-effort and isolated: every entry point throws a clear
   error on any failure, and callers keep the public (unencrypted) path untouched.
   The on-chain guarantee is live + tested; this is the client that rides on it.
   ============================================================ */
import { CFG, sui, STATE } from './shared.js';
import { Transaction } from 'https://esm.sh/@mysten/sui@1.18.0/transactions';
import { fromHex } from 'https://esm.sh/@mysten/sui@1.18.0/utils';

// Pinned to track the app's @mysten/sui@1.18; `external` shares that one copy so
// Seal and the app agree on Transaction/types instead of bundling a second sui.
const SEAL_SPECIFIER = 'https://esm.sh/@mysten/seal@0.4.5?external=@mysten/sui';

let _mod = null;
async function seal() {
  if (!_mod) _mod = await import(SEAL_SPECIFIER);
  return _mod;
}

/** Build a SealClient against the network's allowlisted key servers. */
async function client() {
  const { SealClient, getAllowlistedKeyServers } = await seal();
  const ids = getAllowlistedKeyServers(CFG.network);
  if (!ids || !ids.length) throw new Error('no Seal key servers for ' + CFG.network);
  // Tolerate both the older `serverObjectIds` and newer `serverConfigs` shapes.
  try {
    return new SealClient({ suiClient: sui, serverConfigs: ids.map((objectId) => ({ objectId, weight: 1 })), verifyKeyServers: false });
  } catch {
    return new SealClient({ suiClient: sui, serverObjectIds: ids, verifyKeyServers: false });
  }
}

// At least 2-of-N when there are enough servers, else 1 (so single-server testnet still works).
function threshold(n) { return Math.min(2, Math.max(1, n)); }

const hex = (id) => (id.startsWith('0x') ? id.slice(2) : id);

/** Encrypt bytes for a private app. `appId` is the app's on-chain object id.
    Returns the Seal-encrypted Uint8Array to store on Walrus. */
export async function sealEncrypt(bytes, appId) {
  const c = await client();
  const { getAllowlistedKeyServers } = await seal();
  const n = (getAllowlistedKeyServers(CFG.network) || []).length;
  const { encryptedObject } = await c.encrypt({
    threshold: threshold(n),
    packageId: CFG.playgroundPackageId,
    id: hex(appId),
    data: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
  });
  return encryptedObject;
}

/** Decrypt a private app's archive. Only succeeds for the app's builder — the
    on-chain `seal_approve_app_owner` policy gates the key release. Requires a
    connected wallet that can sign a personal message (the Seal session key). */
export async function sealDecrypt(encBytes, appId) {
  if (!STATE.wallet) throw new Error('connect the builder wallet to decrypt');
  const { SessionKey } = await seal();
  const c = await client();
  const address = STATE.wallet.address;

  // 1) Session key — a short-lived, wallet-signed grant scoped to this package.
  const sk = new SessionKey({ address, packageId: CFG.playgroundPackageId, ttlMin: 10, suiClient: sui });
  const signFeat = STATE.wallet.wallet?.features?.['sui:signPersonalMessage'];
  if (!signFeat) throw new Error('wallet cannot sign personal messages (needed for Seal)');
  const msg = sk.getPersonalMessage();
  const { signature } = await signFeat.signPersonalMessage({ message: msg, account: STATE.wallet.account });
  await sk.setPersonalMessageSignature(signature);

  // 2) Approval transaction — the policy call the key servers evaluate.
  const tx = new Transaction();
  tx.moveCall({
    target: `${CFG.playgroundPackageId}::playground::seal_approve_app_owner`,
    arguments: [tx.pure.vector('u8', Array.from(fromHex(hex(appId)))), tx.object(appId)],
  });
  const txBytes = await tx.build({ client: sui, onlyTransactionKind: true });

  // 3) Decrypt — key servers return shares only if the policy approves the sender.
  return await c.decrypt({ data: encBytes instanceof Uint8Array ? encBytes : new Uint8Array(encBytes), sessionKey: sk, txBytes });
}
