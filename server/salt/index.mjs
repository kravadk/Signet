/**
 * Signet — zkLogin salt service (backend P0, no-wallet onboarding).
 *
 * Returns a STABLE, per-user salt for zkLogin so the user's Sui address is
 * deterministic across logins, WITHOUT a database: salt = HMAC(SALT_SECRET,
 * iss|aud|sub), truncated to 128 bits. The OIDC JWT (Google id_token) is verified
 * (RS256 against the provider JWKS, exp + iss + aud checks) before a salt is issued,
 * so a salt can't be obtained for a forged identity.
 *
 * Stateless + deterministic: same Google account -> same salt -> same Sui address,
 * with no stored mapping to lose. Keep SALT_SECRET secret and stable — rotating it
 * changes everyone's address.
 *
 *   POST /salt  { jwt }  ->  { salt }   (salt is a decimal string < 2^128)
 *   GET  /health         ->  { ok: true }
 *
 * Run: SALT_SECRET=<long-random> GOOGLE_CLIENT_ID=<...>.apps.googleusercontent.com node index.mjs
 */
import { createServer } from 'node:http';
import { createPublicKey, createVerify, createHmac } from 'node:crypto';
import { installShutdown, log, fetchT } from './lib.mjs';

const PORT = Number(process.env.PORT || 8789);
const SALT_SECRET = process.env.SALT_SECRET || '';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || ''; // if set, aud must match
const JWKS_URL = process.env.JWKS_URL || 'https://www.googleapis.com/oauth2/v3/certs';
const ALLOWED_ISS = (process.env.ALLOWED_ISS || 'https://accounts.google.com,accounts.google.com').split(',');
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const MAX_BODY_BYTES = 16 * 1024;

if (!SALT_SECRET || SALT_SECRET.length < 16) { console.error('FATAL: SALT_SECRET missing or too short (>=16 chars).'); if (process.env.NODE_ENV !== 'test') process.exit(1); }

// JWKS cache (Google rotates keys; cache a few minutes).
let jwksCache = { at: 0, keys: [] };
async function getKeys() {
  if (Date.now() - jwksCache.at < 5 * 60_000 && jwksCache.keys.length) return jwksCache.keys;
  const res = await fetchT(JWKS_URL, {}, 8_000);
  if (!res.ok) throw new Error('JWKS fetch failed');
  const j = await res.json();
  jwksCache = { at: Date.now(), keys: j.keys || [] };
  return jwksCache.keys;
}

const b64url = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

async function verifyJwt(jwt) {
  const parts = String(jwt).split('.');
  if (parts.length !== 3) throw new Error('malformed jwt');
  const [h, p, s] = parts;
  const header = JSON.parse(b64url(h).toString('utf8'));
  const payload = JSON.parse(b64url(p).toString('utf8'));
  const keys = await getKeys();
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error('signing key not found');
  const key = createPublicKey({ key: jwk, format: 'jwk' });
  const v = createVerify('RSA-SHA256'); v.update(`${h}.${p}`); v.end();
  if (!v.verify(key, b64url(s))) throw new Error('bad signature');
  if (typeof payload.exp === 'number' && Date.now() / 1000 > payload.exp) throw new Error('token expired');
  if (!ALLOWED_ISS.includes(payload.iss)) throw new Error('bad issuer');
  if (GOOGLE_CLIENT_ID && payload.aud !== GOOGLE_CLIENT_ID) throw new Error('bad audience');
  if (!payload.sub) throw new Error('no subject');
  return payload;
}

/** Deterministic salt < 2^128 from the verified identity. */
function deriveSalt(payload) {
  const mac = createHmac('sha256', SALT_SECRET).update(`${payload.iss}|${payload.aud}|${payload.sub}`).digest();
  return BigInt('0x' + mac.subarray(0, 16).toString('hex')).toString();
}

function cors(res, origin) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN === '*' ? (origin || '*') : ALLOWED_ORIGIN);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
}
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY_BYTES) { reject(new Error('payload too large')); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  cors(res, req.headers.origin);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.method === 'GET' && req.url === '/health') {
    // Real readiness: the JWKS must be fetchable, else we can't verify any JWT.
    try { const keys = await getKeys(); return json(res, keys.length ? 200 : 503, { ok: keys.length > 0, jwks: JWKS_URL, keys: keys.length }); }
    catch (e) { return json(res, 503, { ok: false, jwks: JWKS_URL, error: String(e.message || e) }); }
  }
  if (req.method !== 'POST' || req.url !== '/salt') return json(res, 404, { error: 'not found' });
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'invalid JSON' }); }
  if (!body || typeof body.jwt !== 'string') return json(res, 400, { error: 'jwt required' });
  try {
    const payload = await verifyJwt(body.jwt);
    return json(res, 200, { salt: deriveSalt(payload) });
  } catch (e) {
    return json(res, 401, { error: 'jwt verification failed: ' + (e.message || e) });
  }
});

// Exported for unit tests (deterministic salt without network).
export { deriveSalt, verifyJwt };

if (process.env.NODE_ENV !== 'test') {
  server.listen(PORT, () => log('info', 'salt service up', { port: PORT, jwks: JWKS_URL }));
  installShutdown(server);
}
