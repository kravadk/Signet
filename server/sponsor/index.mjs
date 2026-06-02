/**
 * WalrusForge — sponsored-transaction service (backend P0, onboarding accelerator).
 *
 * Lets a first-time user run gas-only Playground actions (record a visit, star,
 * flag, claim a handle, publish/update an app) WITHOUT holding any SUI — the
 * sponsor pays the gas. It is NOT a source of truth: it only co-signs gas for an
 * allowlisted set of playground calls. If it's down, the user can still act with
 * their own gas (normal wallet flow).
 *
 * Flow (standard Sui sponsored tx):
 *   client builds `onlyTransactionKind` bytes  ->  POST /sponsor { sender, txKindBytes }
 *   server validates the calls, sets sender + sponsor gas, signs
 *      ->  { txBytes, sponsorSignature }
 *   client wallet signs txBytes, then executes with [userSig, sponsorSignature].
 *
 * Security: sponsor co-signs ONLY allowlisted, value-free playground functions on
 * an allowlisted package; per-IP rate limit; request-size cap; CORS pinned.
 * Value-moving calls (tip/bounty/withdraw) are intentionally NOT sponsorable.
 *
 * Run:  SPONSOR_PRIVATE_KEY=suiprivkey1... SUI_NETWORK=testnet \
 *       ALLOWED_PACKAGES=0x77dcd2cf... node index.mjs        (Node 18+)
 */
import { createServer } from 'node:http';
import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { fromBase64, toBase64 } from '@mysten/sui/utils';
import { installShutdown, log, ttlCache } from './lib.mjs';

const PORT = Number(process.env.PORT || 8788);
const NETWORK = process.env.SUI_NETWORK === 'mainnet' ? 'mainnet' : 'testnet';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const RATE_LIMIT_PER_MIN = Number(process.env.RATE_LIMIT_PER_MIN || 15);
const GAS_BUDGET = Number(process.env.GAS_BUDGET || 20_000_000); // 0.02 SUI cap per sponsored tx
const MAX_BODY_BYTES = 256 * 1024;
const ALLOWED_PACKAGES = (process.env.ALLOWED_PACKAGES || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

// Gas-only, value-free playground calls the sponsor is willing to pay for.
// NOTE: tip_app*, *_app_bounty, withdraw_treasury are deliberately excluded.
const SPONSORABLE = new Set([
  'record_visit', 'star', 'star_v2', 'flag_app', 'set_hidden',
  'claim_name', 'release_name', 'publish_app', 'publish_app_v2', 'publish_remix_v3', 'update_app',
]);

const IS_TEST = process.env.NODE_ENV === 'test';
const priv = process.env.SPONSOR_PRIVATE_KEY || '';
if (!IS_TEST) {
  if (!priv) { log('error', 'SPONSOR_PRIVATE_KEY not set'); process.exit(1); }
  if (!ALLOWED_PACKAGES.length) { log('error', 'ALLOWED_PACKAGES not set'); process.exit(1); }
}
// In test mode the keypair/RPC may be absent — validateKind (the pure allowlist check) is still testable.
const sponsor = priv ? Ed25519Keypair.fromSecretKey(decodeSuiPrivateKey(priv).secretKey) : null;
const SPONSOR_ADDR = sponsor ? sponsor.getPublicKey().toSuiAddress() : '0x0';
const client = new SuiClient({ url: getFullnodeUrl(NETWORK) });

const hits = new Map();
function rateLimited(ip) {
  const now = Date.now(); const r = hits.get(ip);
  if (!r || now > r.resetAt) { hits.set(ip, { count: 1, resetAt: now + 60_000 }); return false; }
  r.count += 1; return r.count > RATE_LIMIT_PER_MIN;
}
setInterval(() => { const now = Date.now(); for (const [ip, r] of hits) if (now > r.resetAt) hits.delete(ip); }, 120_000).unref();

function cors(res, origin) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN === '*' ? (origin || '*') : ALLOWED_ORIGIN);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
}
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
const clientIp = (req) => (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY_BYTES) { reject(new Error('payload too large')); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Inspect the transaction kind: every MoveCall must hit an allowed package +
 *  module 'playground' + an allowlisted, value-free function. Anything else
 *  (a different package/module/function, or a TransferObjects/Publish, etc.) is
 *  rejected so the sponsor can't be tricked into paying for arbitrary work. */
function validateKind(tx) {
  const data = tx.getData();
  const cmds = data.commands || [];
  let moveCalls = 0;
  for (const c of cmds) {
    const mc = c.MoveCall || (c.$kind === 'MoveCall' ? c.MoveCall : null) || (c.kind === 'MoveCall' ? c : null);
    if (!mc) {
      if (c.$kind && c.$kind !== 'MoveCall') throw new Error(`command ${c.$kind} not sponsorable`);
      throw new Error('non-MoveCall command not sponsorable');
    }
    moveCalls += 1;
    const pkg = (mc.package || '').toLowerCase();
    if (!ALLOWED_PACKAGES.map((p) => p.toLowerCase()).includes(pkg)) throw new Error('package not allowlisted');
    if (mc.module !== 'playground') throw new Error('module not allowlisted');
    if (!SPONSORABLE.has(mc.function)) throw new Error(`function ${mc.function} not sponsorable`);
  }
  if (!moveCalls) throw new Error('no MoveCall to sponsor');
}

const gasReady = ttlCache(30_000); // cache the coin-count probe so /health doesn't hammer RPC
const server = createServer(async (req, res) => {
  cors(res, req.headers.origin);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.method === 'GET' && req.url === '/health') {
    // Real readiness: the sponsor must have gas coins (and RPC must answer), else it can't sponsor.
    try {
      const n = await gasReady(() => client.getCoins({ owner: SPONSOR_ADDR, limit: 5 }).then((c) => c.data.length));
      return json(res, n > 0 ? 200 : 503, { ok: n > 0, sponsor: SPONSOR_ADDR, network: NETWORK, gasCoins: n });
    } catch (e) {
      return json(res, 503, { ok: false, sponsor: SPONSOR_ADDR, network: NETWORK, error: String(e.message || e) });
    }
  }
  if (req.method !== 'POST' || req.url !== '/sponsor') return json(res, 404, { error: 'not found' });

  const ip = clientIp(req);
  if (rateLimited(ip)) return json(res, 429, { error: 'rate limit — slow down a moment' });

  let body;
  try { body = JSON.parse(await readBody(req)); }
  catch (e) { return json(res, 400, { error: e.message === 'payload too large' ? 'payload too large' : 'invalid JSON' }); }

  const { sender, txKindBytes } = body || {};
  if (typeof sender !== 'string' || !/^0x[0-9a-fA-F]{1,64}$/.test(sender)) return json(res, 400, { error: 'invalid sender' });
  if (typeof txKindBytes !== 'string') return json(res, 400, { error: 'txKindBytes required (base64)' });

  let tx;
  try { tx = Transaction.fromKind(fromBase64(txKindBytes)); }
  catch { return json(res, 400, { error: 'cannot parse transaction kind' }); }

  try { validateKind(tx); }
  catch (e) { return json(res, 403, { error: 'not sponsorable: ' + (e.message || e) }); }

  try {
    tx.setSender(sender);
    tx.setGasOwner(SPONSOR_ADDR);
    tx.setGasBudget(GAS_BUDGET);
    const coins = await client.getCoins({ owner: SPONSOR_ADDR, limit: 5 });
    if (!coins.data.length) return json(res, 503, { error: 'sponsor has no gas coins' });
    tx.setGasPayment(coins.data.map((c) => ({ objectId: c.coinObjectId, version: c.version, digest: c.digest })));
    const bytes = await tx.build({ client });
    const { signature } = await sponsor.signTransaction(bytes);
    return json(res, 200, { txBytes: toBase64(bytes), sponsorSignature: signature });
  } catch (e) {
    return json(res, 500, { error: 'sponsor build failed: ' + (e.message || e) });
  }
});

if (process.env.NODE_ENV !== 'test') {
  server.listen(PORT, () => log('info', 'sponsor up', { port: PORT, network: NETWORK, sponsor: SPONSOR_ADDR, gasBudget: GAS_BUDGET }));
  installShutdown(server);
}
export { validateKind, server };
