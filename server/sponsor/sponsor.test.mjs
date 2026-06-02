// Unit tests for the sponsor allowlist (validateKind) — no key, no network. `node --test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Transaction } from '@mysten/sui/transactions';

const PKG = '0x77dcd2cf25f851770105282d48ea847e411c2043d6d894e8dee29eb16abcb33a';
process.env.NODE_ENV = 'test';
process.env.ALLOWED_PACKAGES = PKG;
const { validateKind } = await import('./index.mjs');

test('allowlisted value-free call (record_visit) is sponsorable', () => {
  const tx = new Transaction();
  tx.moveCall({ target: `${PKG}::playground::record_visit`, arguments: [tx.object('0x6')] });
  assert.doesNotThrow(() => validateKind(tx));
});

test('value-moving call (tip_app_v2) is rejected', () => {
  const tx = new Transaction();
  const [c] = tx.splitCoins(tx.gas, [tx.pure.u64(1)]);
  tx.moveCall({ target: `${PKG}::playground::tip_app_v2`, arguments: [tx.object('0x1'), tx.object('0x2'), c] });
  assert.throws(() => validateKind(tx));
});

test('call to a non-allowlisted package is rejected', () => {
  const tx = new Transaction();
  tx.moveCall({ target: `0xbad::playground::record_visit`, arguments: [tx.object('0x6')] });
  assert.throws(() => validateKind(tx));
});

test('non-playground module is rejected', () => {
  const tx = new Transaction();
  tx.moveCall({ target: `${PKG}::forge::create_repo`, arguments: [] });
  assert.throws(() => validateKind(tx));
});
