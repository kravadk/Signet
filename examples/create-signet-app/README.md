# create-signet-app example

Minimal starter for building on Signet from an existing Sui dApp.

## Install

```bash
npm install @signet/cli @mysten/sui
```

## Use the typed SDK

```ts
import { makeContext, signetClients } from "@signet/cli/sdk";

const ctx = makeContext("testnet");
const signet = signetClients(ctx);

const repos = await signet.forge.listRepos();
const release = await signet.release.verify("0x...");

const payment = await signet.payment.create({
  recipient: ctx.address,
  label: "Starter invoice",
  amountMist: 100_000_000,
});
```

## Embed wallet state in a web app

```js
import { subscribeWallet } from "../../web/wallet-adapter.js";

subscribeWallet((wallet) => {
  document.body.toggleAttribute("data-wallet-mismatch", wallet.networkMismatch);
});
```

## Local development

```bash
npm run doctor:testnet
npm run doctor:localnet
npm --prefix ../.. run dev:all
```

The starter expects Signet's on-chain package ids from
`move/signet/deployments.json` and uses Sui/Walrus as the source of truth.

Profiles:

- `testnet` checks deployed package ids plus public Sui/Walrus endpoints.
- `localnet` checks a local fullnode at `SUI_LOCALNET_RPC` or `http://127.0.0.1:9000`.
- `all` is the root default for maintainers validating every configured network.
