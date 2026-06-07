// Signet — copy-light production hardening helpers (zero deps, Node 18+).
// An identical copy lives in each service dir so the images stay dependency-light.

export const log = (level, msg, extra = {}) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra }));

/** Strict CORS: echo origin when ALLOWED_ORIGIN='*', else only the exact match. */
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

/** Per-IP sliding-window rate limit (in-memory; env-tunable; degrade-safe — only
 *  rejects over the limit, and disables entirely when perMin<=0). Swap for Redis
 *  at horizontal scale. */
export function makeRateLimiter({ perMin = Number(process.env.RATE_LIMIT_PER_MIN || 30), prefix = 'rl' } = {}) {
  // Distributed when Upstash Redis REST env is set (limits shared across instances);
  // otherwise in-memory. Fail-open: any Redis/network error → fall back to memory, so a
  // rate-limiter outage never takes the service down. Returns an async predicate.
  const RURL = process.env.UPSTASH_REDIS_REST_URL || process.env.RATE_LIMIT_REDIS_URL || '';
  const RTOK = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.RATE_LIMIT_REDIS_TOKEN || '';
  const hits = new Map();
  setInterval(() => { const now = Date.now(); for (const [k, r] of hits) if (now > r.resetAt) hits.delete(k); }, 120_000).unref();
  const memOver = (ip) => {
    const now = Date.now(); const rec = hits.get(ip);
    if (!rec || now > rec.resetAt) { hits.set(ip, { count: 1, resetAt: now + 60_000 }); return false; }
    rec.count += 1; return rec.count > perMin;
  };
  async function redisOver(ip) {
    if (!RURL || !RTOK) return null;
    try {
      const key = `${prefix}:${ip}`;
      const r = await fetch(`${RURL}/pipeline`, {
        method: 'POST',
        headers: { authorization: `Bearer ${RTOK}`, 'content-type': 'application/json' },
        body: JSON.stringify([['INCR', key], ['EXPIRE', key, '60', 'NX']]),
        signal: AbortSignal.timeout(1500),
      });
      if (!r.ok) return null;
      const out = await r.json();
      const n = Number(Array.isArray(out) ? out[0]?.result : out?.result);
      return Number.isFinite(n) ? n > perMin : null;
    } catch { return null; }
  }
  return async (ip) => {
    if (!perMin || perMin <= 0) return false; // disabled
    const viaRedis = await redisOver(ip);
    return viaRedis != null ? viaRedis : memOver(ip);
  };
}

/** Client IP behind a proxy (first X-Forwarded-For hop), else the socket address. */
export const clientIp = (req) =>
  (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';

/** Prometheus-format counters, no deps. inc(name) to count, text() for /metrics. */
export function makeMetrics(service) {
  const c = Object.create(null);
  const net = process.env.FORGE_NETWORK || process.env.ACTIVE_NETWORK || 'testnet';
  return {
    inc: (name, n = 1) => { c[name] = (c[name] || 0) + n; },
    text: () => {
      const lines = [];
      for (const [k, v] of Object.entries(c)) lines.push(`signet_${k}{service="${service}",network="${net}"} ${v}`);
      lines.push(`signet_up{service="${service}",network="${net}"} 1`);
      return lines.join('\n') + '\n';
    },
  };
}

/** Env-gated error capture. Always logs (structured); additionally best-effort
 *  POSTs to ERROR_DSN/SENTRY_DSN when set (fire-and-forget, never throws, never
 *  blocks the request). No DSN → a pure no-op beyond the log. */
export function captureError(err, ctx = {}) {
  log('error', String(err?.message || err), ctx);
  const dsn = process.env.ERROR_TRACKING_DSN || process.env.ERROR_DSN || process.env.SENTRY_DSN;
  if (!dsn) return;
  try {
    const body = JSON.stringify({ msg: String(err?.message || err), stack: err?.stack || null, ...ctx, at: new Date().toISOString() });
    fetch(dsn, { method: 'POST', headers: { 'content-type': 'application/json' }, body }).catch(() => {});
  } catch { /* never let telemetry break the request */ }
}
