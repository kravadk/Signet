import { test, expect } from '@playwright/test';

const MOCK_ADDR = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
const PAY_OPEN = '0x1000000000000000000000000000000000000000000000000000000000000001';
const PAY_PAID = '0x1000000000000000000000000000000000000000000000000000000000000002';
const PAY_CANCELLED = '0x1000000000000000000000000000000000000000000000000000000000000003';
const PAY_EXPIRED = '0x1000000000000000000000000000000000000000000000000000000000000004';

async function installMockWallet(page, { rejectSign = false, chain = 'sui:testnet' } = {}) {
  await page.addInitScript(({ rejectSign, chain, address }) => {
    const account = {
      address,
      publicKey: new Uint8Array(32),
      chains: [chain],
      features: ['sui:signAndExecuteTransaction', 'sui:signTransaction'],
    };
    const listeners = new Set();
    const wallet = {
      version: '1.0.0',
      name: 'Mock Sui Wallet',
      icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>',
      chains: ['sui:testnet', 'sui:mainnet'],
      accounts: [account],
      features: {
        'standard:connect': {
          version: '1.0.0',
          connect: async () => ({ accounts: [account] }),
        },
        'standard:disconnect': {
          version: '1.0.0',
          disconnect: async () => {
            wallet.accounts = [];
            for (const cb of listeners) cb({ accounts: [] });
          },
        },
        'standard:events': {
          version: '1.0.0',
          on: (_event, cb) => { listeners.add(cb); return () => listeners.delete(cb); },
        },
        'sui:signAndExecuteTransaction': {
          version: '1.0.0',
          signAndExecuteTransaction: async () => {
            if (rejectSign) throw new Error('User rejected signature');
            return {
              digest: 'MOCK_DIGEST',
              effects: { status: { status: 'success' } },
              objectChanges: [{
                type: 'created',
                objectType: '0xsignet::payment::PaymentRequest',
                objectId: '0xpaymentrequest000000000000000000000000000000000000000000000001',
              }],
            };
          },
        },
        'sui:signTransaction': {
          version: '1.0.0',
          signTransaction: async () => {
            if (rejectSign) throw new Error('User rejected signature');
            return { bytes: 'AA==', signature: 'MOCK_USER_SIG' };
          },
        },
      },
      __changeAccount(nextAddress) {
        const next = { ...account, address: nextAddress };
        wallet.accounts = [next];
        for (const cb of listeners) cb({ accounts: [next] });
      },
      __changeNetwork(nextChain) {
        account.chains = [nextChain];
        for (const cb of listeners) cb({ accounts: [account], chains: [nextChain] });
      },
    };
    Object.defineProperty(navigator, 'wallets', {
      configurable: true,
      value: { get: () => [wallet] },
    });
    window.__mockWallet = wallet;
    window.addEventListener('wallet-standard:app-ready', (event) => {
      event.detail.register(wallet);
    });
    window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: wallet }));
  }, { rejectSign, chain, address: MOCK_ADDR });
}

function mockPaymentObject(id, overrides = {}) {
  const fields = {
    creator: MOCK_ADDR,
    recipient: MOCK_ADDR,
    label: overrides.label || 'Mock invoice',
    amount: String(overrides.amount ?? 100000000),
    paid: Boolean(overrides.paid),
    cancelled: Boolean(overrides.cancelled),
    payer: { fields: { vec: overrides.payer ? [overrides.payer] : [] } },
    created_at_ms: String(Date.now() - 60000),
    expires_at_ms: { fields: { vec: overrides.expiresAt ? [String(overrides.expiresAt)] : [] } },
  };
  return {
    data: {
      objectId: id,
      version: '1',
      digest: 'MOCK_OBJECT_DIGEST',
      content: { dataType: 'moveObject', type: '0xsignet::payment::PaymentRequest', fields },
    },
  };
}

function seededPaymentEvents() {
  return [PAY_OPEN, PAY_PAID, PAY_CANCELLED, PAY_EXPIRED].map((id, eventSeq) => ({
    id: { txDigest: `MOCK_PAYMENT_TX_${eventSeq}`, eventSeq: String(eventSeq) },
    type: '0xsignet::payment::PaymentRequested',
    parsedJson: { request_id: id },
    timestampMs: String(Date.now() - eventSeq * 1000),
  }));
}

async function installMockRpc(page, { failRpc = false, seedPayments = false } = {}) {
  await page.route(/https:\/\/.*(fullnode|sui).*\/?$/i, async (route, request) => {
    if (request.method() !== 'POST') return route.continue();
    if (failRpc) {
      return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'mock rpc down' }) });
    }
    const body = request.postDataJSON();
    const id = body?.id ?? 1;
    const method = body?.method || '';
    let result = {};
    if (method === 'suix_queryEvents') {
      const filter = body?.params?.[0] || {};
      const type = filter.MoveEventType || '';
      result = seedPayments && type.includes('::payment::PaymentRequested')
        ? { data: seededPaymentEvents(), hasNextPage: false, nextCursor: null }
        : { data: [], hasNextPage: false, nextCursor: null };
    }
    else if (method === 'sui_multiGetObjects') {
      const ids = body?.params?.[0] || [];
      const map = new Map([
        [PAY_OPEN, mockPaymentObject(PAY_OPEN, { label: 'Open invoice' })],
        [PAY_PAID, mockPaymentObject(PAY_PAID, { label: 'Paid invoice', paid: true, payer: MOCK_ADDR })],
        [PAY_CANCELLED, mockPaymentObject(PAY_CANCELLED, { label: 'Cancelled invoice', cancelled: true })],
        [PAY_EXPIRED, mockPaymentObject(PAY_EXPIRED, { label: 'Expired invoice', expiresAt: Date.now() - 1000 })],
      ]);
      result = ids.map((id) => map.get(id) || { error: { code: 'notFound', object_id: id } });
    }
    else if (method === 'suix_getBalance') result = { totalBalance: '4200000000', coinType: '0x2::sui::SUI' };
    else if (method === 'suix_getOwnedObjects') result = { data: [], hasNextPage: false, nextCursor: null };
    else if (method === 'suix_resolveNameServiceNames') result = { data: [], hasNextPage: false, nextCursor: null };
    else if (method === 'sui_getTransactionBlock') result = {
      digest: 'MOCK_DIGEST',
      effects: { status: { status: 'success' } },
      objectChanges: [{
        type: 'created',
        objectType: '0xsignet::payment::PaymentRequest',
        objectId: '0xpaymentrequest000000000000000000000000000000000000000000000001',
      }],
    };
    else if (method === 'suix_getLatestSuiSystemState') result = { epoch: '42' };
    else if (method === 'sui_devInspectTransactionBlock') result = { results: [{ returnValues: [[[0,0,0,0,0,0,0,0], 'u64']] }] };
    else result = {};
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id, result }) });
  });
}

async function boot(page, opts = {}) {
  await page.addInitScript(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await installMockRpc(page, opts);
  if (opts.wallet !== false) await installMockWallet(page, opts);
  // App shell lives at /app ( / is the marketing landing after the reorg ).
  // Use the clean URL — `serve`'s cleanUrls 301-redirects /app.html to /app and
  // drops the query string, which would hide ?graphql=1 / ?grpc=1.
  await page.goto(opts.path || '/app');
  await expect(page.locator('#app')).toBeVisible();
}

test('anonymous user can traverse all core tabs and sees empty states instead of stale loaders', async ({ page }) => {
  await boot(page, { wallet: false });
  for (const nav of ['dashboard', 'repos', 'releases', 'packages', 'agents', 'issues', 'bounties', 'activity', 'verify']) {
    await page.locator(`[data-nav="${nav}"]`).click();
    await expect(page.locator(`#view-${nav}`)).toBeVisible();
  }
  await expect(page.locator('#view-verify .empty-state')).toBeVisible();
  await expect(page.locator('.loading-shimmer')).toHaveCount(0);
});

test('mock wallet connect, network/account changes and disconnect are visible', async ({ page }) => {
  await boot(page);
  await page.locator('#connectBtn').click();
  await expect(page.getByText(/Connected/)).toBeVisible();
  await page.evaluate(() => window.__mockWallet.__changeNetwork('sui:mainnet'));
  await expect(page.getByText(/Wallet network is mainnet/)).toBeVisible();
  await page.evaluate(() => window.__mockWallet.__changeAccount('0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd'));
  await expect(page.getByText(/Wallet account changed/)).toBeVisible();
  await page.locator('#connectBtn').click();
  await page.getByText('Disconnect').click();
  await expect(page.getByText('Disconnected')).toBeVisible();
});

test('rejected signature surfaces a toast and keeps the publish button usable', async ({ page }) => {
  await boot(page, { rejectSign: true });
  await page.locator('#connectBtn').click();
  await expect(page.getByText(/Connected/)).toBeVisible();
  await page.locator('#pgPostBounty').click();
  await page.locator('#pgBDesc').fill('Build a verified timer app');
  await page.locator('#pgBAmt').fill('0.1');
  await page.getByRole('button', { name: 'Sign & submit' }).click();
  await expect(page.getByText(/Signature rejected by user|Tx failed/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign & submit' })).toBeEnabled();
});

test('RPC outage shows explicit sync error with retry', async ({ page }) => {
  await boot(page, { wallet: false, failRpc: true });
  await page.locator('[data-nav="dashboard"]').click();
  await expect(page.locator('#view-dashboard .empty-state.err').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry' }).first()).toBeVisible();
});

test('GraphQL read mode attempts GraphQL and surfaces the active source', async ({ page }) => {
  await boot(page, { wallet: false, path: '/app?graphql=1' });
  await expect(page.locator('#netBadgeTxt')).toContainText(/GraphQL|degraded/i);
});

test('gRPC read mode attempts gRPC and surfaces the active source', async ({ page }) => {
  await boot(page, { wallet: false, path: '/app?grpc=1' });
  await expect(page.locator('#netBadgeTxt')).toContainText(/gRPC|degraded|JSON-RPC/i);
});

test('payment link create flow signs through the wallet and does not silently fail', async ({ page }) => {
  await boot(page);
  await page.locator('#connectBtn').click();
  await page.locator('[data-nav="payments"]').click();
  await expect(page.locator('#view-payments')).toBeVisible();
  await page.getByRole('button', { name: '+ New payment' }).click();
  await page.locator('#payRecipient').fill(MOCK_ADDR);
  await page.locator('#payLabel').fill('E2E invoice');
  await page.locator('#payAmount').fill('0.1');
  await page.getByRole('button', { name: 'Sign & create' }).click();
  await expect(page.getByText(/Payment request created|Could not read created object ids/)).toBeVisible();
});

test('payment history renders open paid cancelled expired states and QR/copy controls', async ({ page }) => {
  await boot(page, { seedPayments: true });
  await page.locator('#connectBtn').click();
  await page.locator('[data-nav="payments"]').click();
  await expect(page.getByText('Open invoice')).toBeVisible();
  await expect(page.getByText('Paid invoice')).toBeVisible();
  await expect(page.getByText('Cancelled invoice')).toBeVisible();
  await expect(page.getByText('Expired invoice')).toBeVisible();
  await expect(page.locator('#view-payments .pill.open')).toHaveCount(1);
  await expect(page.locator('#view-payments .pill.paid')).toHaveCount(1);
  await expect(page.locator('#view-payments .pill.cancelled')).toHaveCount(2);
  await expect(page.locator('#view-payments [data-copy-pay]').first()).toBeVisible();
});
