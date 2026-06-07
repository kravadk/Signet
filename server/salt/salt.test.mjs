// Unit tests for the salt service — no network, no secret leakage. `node --test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.SALT_SECRET = 'unit-test-secret-key-1234567890';
const { deriveSalt } = await import('./index.mjs');

const base = { iss: 'https://accounts.google.com', aud: 'aud-1', sub: 'user-1' };

test('salt is deterministic for the same identity', () => {
  assert.equal(deriveSalt(base), deriveSalt({ ...base }));
});
test('salt is < 2^128', () => {
  assert.ok(BigInt(deriveSalt(base)) < (1n << 128n));
});
test('different sub yields a different salt', () => {
  assert.notEqual(deriveSalt(base), deriveSalt({ ...base, sub: 'user-2' }));
});
test('different aud yields a different salt', () => {
  assert.notEqual(deriveSalt(base), deriveSalt({ ...base, aud: 'aud-2' }));
});

// ---- distributed-capable rate limiter (degrade-safe) ----
const { makeRateLimiter } = await import('./lib.mjs');

test('rate limiter: in-memory allows under the cap, blocks over it', async () => {
  const limited = makeRateLimiter({ perMin: 3, prefix: 't' });
  assert.equal(await limited('1.1.1.1'), false);
  assert.equal(await limited('1.1.1.1'), false);
  assert.equal(await limited('1.1.1.1'), false);
  assert.equal(await limited('1.1.1.1'), true); // 4th > cap of 3
});

test('rate limiter: fails OPEN to in-memory when Redis is configured but errors', async () => {
  process.env.UPSTASH_REDIS_REST_URL = 'https://example.invalid';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'x';
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('redis down'); };
  try {
    const limited = makeRateLimiter({ perMin: 2, prefix: 't2' });
    assert.equal(await limited('2.2.2.2'), false);
    assert.equal(await limited('2.2.2.2'), false);
    assert.equal(await limited('2.2.2.2'), true); // fell open to memory, still enforces the cap
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
  }
});

test('rate limiter: disabled when perMin <= 0', async () => {
  const limited = makeRateLimiter({ perMin: 0 });
  for (let i = 0; i < 8; i++) assert.equal(await limited('3.3.3.3'), false);
});
