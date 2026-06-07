/**
 * Signet — sponsored-transaction service (backend P0, onboarding accelerator).
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
const WALLET_RATE_LIMIT_PER_MIN = Number(process.env.WALLET_RATE_LIMIT_PER_MIN || 20);
const IP_DAILY_LIMIT = Number(process.env.IP_DAILY_LIMIT || 250);
const WALLET_DAILY_LIMIT = Number(process.env.WALLET_DAILY_LIMIT || 100);
const DAILY_BUDGET_MIST = Number(process.env.DAILY_BUDGET_MIST || 1_000_000_000); // 1 SUI/day issued gas budget
const FUNCTION_DAILY_LIMITS = parseFunctionLimits(process.env.FUNCTION_DAILY_LIMITS || 'publish_app=25,publish_app_v2=25,publish_remix_v3=25,update_app=50,*=500');
const SPONSOR_WRITE_MODE = (process.env.SPONSOR_WRITE_MODE || 'open').toLowerCase(); // open | allowlist | stake
const ALLOWED_SENDERS = new Set((process.env.ALLOWED_SENDERS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
const STAKE_MIN_MIST = Number(process.env.STAKE_MIN_MIST || 0);
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
const WRITE_FUNCTIONS = new Set(['publish_app', 'publish_app_v2', 'publish_remix_v3', 'update_app']);

const IS_TEST = process.env.NODE_ENV === 'test';
const priv = process.env.SPONSOR_PRIVATE_KEY || '';
if (!IS_TEST) {
  if (!priv) { log('error', 'SPONSOR_PRIVATE_KEY not set'); process.exit(1); }
  if (priv.includes('...') || !priv.startsWith('suiprivkey1')) {
    log('error', 'SPONSOR_PRIVATE_KEY must be a real Sui private key exported by `sui keytool export`; do not use placeholders like suiprivkey1...');
    process.exit(1);
  }
  if (!ALLOWED_PACKAGES.length) { log('error', 'ALLOWED_PACKAGES not set'); process.exit(1); }
}
// In test mode the keypair/RPC may be absent — validateKind (the pure allowlist check) is still testable.
let sponsor = null;
if (priv) {
  try {
    sponsor = Ed25519Keypair.fromSecretKey(decodeSuiPrivateKey(priv).secretKey);
  } catch (e) {
    log('error', 'SPONSOR_PRIVATE_KEY is not a valid exported Sui private key', {
      hint: 'Paste the full suiprivkey1... value from `sui keytool export --key-identity <address>` with no spaces, quotes, ellipsis, or trailing punctuation.',
      error: String(e?.message || e),
    });
    if (!IS_TEST) process.exit(1);
  }
}
const SPONSOR_ADDR = sponsor ? sponsor.getPublicKey().toSuiAddress() : '0x0';
const client = new SuiClient({ url: getFullnodeUrl(NETWORK) });

const hits = new Map();
const walletHits = new Map();
const daily = new Map();
const metrics = {
  accepted: 0,
  rejected: 0,
  rateLimitHits: 0,
  spendEstimatedMist: 0,
  rejectedByReason: new Map(),
};

function parseFunctionLimits(s) {
  const out = new Map();
  for (const part of String(s).split(',')) {
    const [k, v] = part.split('=').map((x) => x?.trim());
    if (k && Number(v) >= 0) out.set(k, Number(v));
  }
  if (!out.has('*')) out.set('*', 500);
  return out;
}
function today() { return new Date().toISOString().slice(0, 10); }
function dailyKey(scope, id) { return `${today()}:${scope}:${id}`; }
function getDaily(scope, id) { return daily.get(dailyKey(scope, id)) || 0; }
function incDaily(scope, id) {
  const k = dailyKey(scope, id);
  const v = (daily.get(k) || 0) + 1;
  daily.set(k, v);
  return v;
}
function noteReject(reason) {
  metrics.rejected += 1;
  metrics.rejectedByReason.set(reason, (metrics.rejectedByReason.get(reason) || 0) + 1);
}
// Optional distributed backend (Upstash Redis REST) so per-minute limits hold across
// instances. Unset → in-memory. Fail-open: any error → fall back to the local map.
const R_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.RATE_LIMIT_REDIS_URL || '';
const R_TOK = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.RATE_LIMIT_REDIS_TOKEN || '';
async function redisOver(key, perMin) {
  if (!R_URL || !R_TOK) return null;
  try {
    const r = await fetch(`${R_URL}/pipeline`, {
      method: 'POST', headers: { authorization: `Bearer ${R_TOK}`, 'content-type': 'application/json' },
      body: JSON.stringify([['INCR', key], ['EXPIRE', key, '60', 'NX']]), signal: AbortSignal.timeout(1500),
    });
    if (!r.ok) return null;
    const out = await r.json(); const n = Number(Array.isArray(out) ? out[0]?.result : out?.result);
    return Number.isFinite(n) ? n > perMin : null;
  } catch { return null; }
}
async function rateLimited(ip) {
  const viaRedis = await redisOver(`sp:ip:${ip}`, RATE_LIMIT_PER_MIN);
  if (viaRedis != null) return viaRedis;
  const now = Date.now(); const r = hits.get(ip);
  if (!r || now > r.resetAt) { hits.set(ip, { count: 1, resetAt: now + 60_000 }); return false; }
  r.count += 1; return r.count > RATE_LIMIT_PER_MIN;
}
async function walletRateLimited(sender) {
  const viaRedis = await redisOver(`sp:w:${sender}`, WALLET_RATE_LIMIT_PER_MIN);
  if (viaRedis != null) return viaRedis;
  const now = Date.now(); const r = walletHits.get(sender);
  if (!r || now > r.resetAt) { walletHits.set(sender, { count: 1, resetAt: now + 60_000 }); return false; }
  r.count += 1; return r.count > WALLET_RATE_LIMIT_PER_MIN;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, r] of hits) if (now > r.resetAt) hits.delete(ip);
  for (const [sender, r] of walletHits) if (now > r.resetAt) walletHits.delete(sender);
}, 120_000).unref();

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
  inspectKind(tx);
}

function inspectKind(tx) {
  const data = tx.getData();
  const cmds = data.commands || [];
  const calls = [];
  for (const c of cmds) {
    const mc = c.MoveCall || (c.$kind === 'MoveCall' ? c.MoveCall : null) || (c.kind === 'MoveCall' ? c : null);
    if (!mc) {
      if (c.$kind && c.$kind !== 'MoveCall') throw new Error(`command ${c.$kind} not sponsorable`);
      throw new Error('non-MoveCall command not sponsorable');
    }
    const pkg = (mc.package || '').toLowerCase();
    if (!ALLOWED_PACKAGES.map((p) => p.toLowerCase()).includes(pkg)) throw new Error('package not allowlisted');
    if (mc.module !== 'playground') throw new Error('module not allowlisted');
    if (!SPONSORABLE.has(mc.function)) throw new Error(`function ${mc.function} not sponsorable`);
    calls.push({ package: pkg, module: mc.module, function: mc.function });
  }
  if (!calls.length) throw new Error('no MoveCall to sponsor');
  return calls;
}

async function enforceQuotas({ ip, sender, calls }) {
  if (await rateLimited(ip)) throw new Error('rate limit: ip per minute');
  if (await walletRateLimited(sender)) throw new Error('rate limit: wallet per minute');
  if (getDaily('ip', ip) >= IP_DAILY_LIMIT) throw new Error('quota: ip daily');
  if (getDaily('wallet', sender) >= WALLET_DAILY_LIMIT) throw new Error('quota: wallet daily');
  if (metrics.spendEstimatedMist + GAS_BUDGET > DAILY_BUDGET_MIST) throw new Error('quota: daily sponsor budget');
  for (const c of calls) {
    const lim = FUNCTION_DAILY_LIMITS.get(c.function) ?? FUNCTION_DAILY_LIMITS.get('*') ?? 0;
    if (getDaily('fn', c.function) >= lim) throw new Error(`quota: function ${c.function}`);
  }
  const writeCall = calls.some((c) => WRITE_FUNCTIONS.has(c.function));
  if (writeCall && SPONSOR_WRITE_MODE === 'allowlist' && !ALLOWED_SENDERS.has(sender.toLowerCase())) {
    throw new Error('write sponsorship requires allowlist');
  }
  if (writeCall && SPONSOR_WRITE_MODE === 'stake') {
    const bal = await client.getBalance({ owner: sender }).then((b) => Number(b.totalBalance || 0));
    if (bal < STAKE_MIN_MIST) throw new Error('write sponsorship requires stake/balance');
  }
}

function commitQuota({ ip, sender, calls }) {
  incDaily('ip', ip);
  incDaily('wallet', sender);
  for (const c of calls) incDaily('fn', c.function);
  metrics.accepted += 1;
  metrics.spendEstimatedMist += GAS_BUDGET;
}

async function sponsorDashboard() {
  let gasCoins = 0; let balanceMist = 0;
  try {
    const [coins, bal] = await Promise.all([
      client.getCoins({ owner: SPONSOR_ADDR, limit: 5 }),
      client.getBalance({ owner: SPONSOR_ADDR }),
    ]);
    gasCoins = coins.data.length;
    balanceMist = Number(bal.totalBalance || 0);
  } catch {}
  return {
    ok: !!sponsor && gasCoins > 0,
    sponsor: SPONSOR_ADDR,
    network: NETWORK,
    gasCoins,
    balanceMist,
    gasBudgetIssuedMist: metrics.spendEstimatedMist,
    spendEstimatedMist: metrics.spendEstimatedMist,
    dailyBudgetMist: DAILY_BUDGET_MIST,
    remainingBudgetMist: Math.max(0, DAILY_BUDGET_MIST - metrics.spendEstimatedMist),
    accepted: metrics.accepted,
    rejected: metrics.rejected,
    rateLimitHits: metrics.rateLimitHits,
    rejectedByReason: Object.fromEntries(metrics.rejectedByReason),
    quotas: {
      rateLimitPerMin: RATE_LIMIT_PER_MIN,
      walletRateLimitPerMin: WALLET_RATE_LIMIT_PER_MIN,
      ipDailyLimit: IP_DAILY_LIMIT,
      walletDailyLimit: WALLET_DAILY_LIMIT,
      functionDailyLimits: Object.fromEntries(FUNCTION_DAILY_LIMITS),
      writeMode: SPONSOR_WRITE_MODE,
      stakeMinMist: STAKE_MIN_MIST,
    },
  };
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
  if (req.method === 'GET' && req.url === '/dashboard') {
    return json(res, 200, await sponsorDashboard());
  }
  if (req.method !== 'POST' || req.url !== '/sponsor') return json(res, 404, { error: 'not found' });

  const ip = clientIp(req);

  let body;
  try { body = JSON.parse(await readBody(req)); }
  catch (e) { return json(res, 400, { error: e.message === 'payload too large' ? 'payload too large' : 'invalid JSON' }); }

  const { sender, txKindBytes } = body || {};
  if (typeof sender !== 'string' || !/^0x[0-9a-fA-F]{1,64}$/.test(sender)) return json(res, 400, { error: 'invalid sender' });
  if (typeof txKindBytes !== 'string') return json(res, 400, { error: 'txKindBytes required (base64)' });

  let tx;
  try { tx = Transaction.fromKind(fromBase64(txKindBytes)); }
  catch { return json(res, 400, { error: 'cannot parse transaction kind' }); }

  let calls;
  try {
    calls = inspectKind(tx);
  } catch (e) {
    noteReject('not_sponsorable');
    return json(res, 403, { error: 'not sponsorable: ' + (e.message || e) });
  }

  try {
    await enforceQuotas({ ip, sender, calls });
  } catch (e) {
    const msg = String(e.message || e);
    if (msg.startsWith('rate limit')) metrics.rateLimitHits += 1;
    noteReject(msg);
    return json(res, msg.startsWith('rate limit') || msg.startsWith('quota') ? 429 : 403, { error: msg });
  }

  try {
    tx.setSender(sender);
    tx.setGasOwner(SPONSOR_ADDR);
    tx.setGasBudget(GAS_BUDGET);
    const coins = await client.getCoins({ owner: SPONSOR_ADDR, limit: 5 });
    if (!coins.data.length) return json(res, 503, { error: 'sponsor has no gas coins' });
    tx.setGasPayment(coins.data.map((c) => ({ objectId: c.coinObjectId, version: c.version, digest: c.digest })));
    const bytes = await tx.build({ client });
    const { signature } = await sponsor.signTransaction(bytes);
    commitQuota({ ip, sender, calls });
    return json(res, 200, { txBytes: toBase64(bytes), sponsorSignature: signature });
  } catch (e) {
    return json(res, 500, { error: 'sponsor build failed: ' + (e.message || e) });
  }
});

if (process.env.NODE_ENV !== 'test') {
  server.listen(PORT, () => log('info', 'sponsor up', { port: PORT, network: NETWORK, sponsor: SPONSOR_ADDR, gasBudget: GAS_BUDGET }));
  installShutdown(server);
}
export { validateKind, inspectKind, enforceQuotas, sponsorDashboard, server };
