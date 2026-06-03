// Unit tests for the sponsor allowlist (validateKind) — no key, no network. `node --test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Transaction } from '@mysten/sui/transactions';

const PKG = '0x77dcd2cf25f851770105282d48ea847e411c2043d6d894e8dee29eb16abcb33a';
process.env.NODE_ENV = 'test';
process.env.ALLOWED_PACKAGES = PKG;
process.env.SPONSOR_WRITE_MODE = 'allowlist';
process.env.ALLOWED_SENDERS = '0x123';
const { validateKind, inspectKind, enforceQuotas } = await import('./index.mjs');

test('allowlisted value-free call (record_visit) is sponsorable', () => {
  const tx = new Transaction();
  tx.moveCall({ target: `${PKG}::playground::record_visit`, arguments: [tx.object('0x6')] });
  assert.doesNotThrow(() => validateKind(tx));
});

test('inspectKind returns function names for quota accounting', () => {
  const tx = new Transaction();
  tx.moveCall({ target: `${PKG}::playground::record_visit`, arguments: [tx.object('0x6')] });
  assert.deepEqual(inspectKind(tx).map((c) => c.function), ['record_visit']);
});

test('allowlist mode gates sponsored publish/update/remix writes', async () => {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG}::playground::publish_app_v2`,
    arguments: [tx.pure.string('name'), tx.pure.string('prompt'), tx.pure.string('cat'), tx.pure.string('m'), tx.pure.string('a'), tx.pure.string('h'), tx.object('0x6')],
  });
  const calls = inspectKind(tx);
  await assert.rejects(() => enforceQuotas({ ip: 'test-ip-a', sender: '0x456', calls }), /allowlist/);
  await assert.doesNotReject(() => enforceQuotas({ ip: 'test-ip-b', sender: '0x123', calls }));
});

test('ip minute rate limit is enforced before signing', async () => {
  const tx = new Transaction();
  tx.moveCall({ target: `${PKG}::playground::record_visit`, arguments: [tx.object('0x6')] });
  const calls = inspectKind(tx);
  for (let i = 0; i < 15; i++) {
    await assert.doesNotReject(() => enforceQuotas({ ip: 'ip-minute-test', sender: `0x${(1000 + i).toString(16)}`, calls }));
  }
  await assert.rejects(() => enforceQuotas({ ip: 'ip-minute-test', sender: '0x9999', calls }), /ip per minute/);
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
