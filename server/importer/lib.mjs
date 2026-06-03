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
