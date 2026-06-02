// WalrusForge — copy-light production hardening helpers (zero deps, Node 18+).
// An identical copy lives in each service dir so the images stay dependency-light.

export const log = (level, msg, extra = {}) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra }));

/** Exit early if any required env var is missing. */
export function requireEnv(names) {
  const miss = names.filter((n) => !process.env[n]);
  if (miss.length) { log('error', 'missing required env', { miss }); process.exit(1); }
}

/** fetch() with an abort timeout (ms). */
export function fetchT(url, opts = {}, ms = 10_000) {
  const c = new AbortController();
  const id = setTimeout(() => c.abort(), ms);
  return fetch(url, { ...opts, signal: c.signal }).finally(() => clearTimeout(id));
}

/** Strict CORS: echo origin when ALLOWED_ORIGIN='*', else only the exact match
 *  (omit the header on mismatch → the browser blocks the cross-origin call). */
export function strictCors(res, origin, allowed) {
  if (allowed === '*') res.setHeader('Access-Control-Allow-Origin', origin || '*');
  else if (origin && origin === allowed) res.setHeader('Access-Control-Allow-Origin', allowed);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
}

/** Graceful shutdown: stop accepting, drain in-flight, hard-cap at 10s. */
export function installShutdown(server, { onClose } = {}) {
  let closing = false;
  const stop = (sig) => {
    if (closing) return; closing = true;
    log('info', 'shutdown', { sig });
    const hard = setTimeout(() => process.exit(1), 10_000); hard.unref();
    server.close(() => Promise.resolve(onClose?.()).then(
      () => { clearTimeout(hard); process.exit(0); },
      () => process.exit(1),
    ));
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

/** Tiny TTL cache so readiness probes don't hammer upstreams on every /health. */
export function ttlCache(ms) {
  let at = 0, val;
  return async (fn) => {
    const now = Date.now();
    if (now - at < ms && val !== undefined) return val;
    val = await fn(); at = now; return val;
  };
}
