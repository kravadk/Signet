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
