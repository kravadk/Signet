/* ============================================================
   WalrusForge — shared config, clients, state, helpers.
   Imported by app.js, data.js, wallet.js, ui.js so every module
   talks to the same SuiClient, CFG and STATE.
   ============================================================ */

import { SuiClient, getFullnodeUrl } from 'https://esm.sh/@mysten/sui@1.18.0/client';
import { formatAddress, MIST_PER_SUI, isValidSuiAddress, isValidSuiObjectId } from 'https://esm.sh/@mysten/sui@1.18.0/utils';

/* ---------- Config (per-network, mirrors move/walrusforge/deployments.json) ----------
   Network picked from ?network= query param or localStorage 'wf.network', else testnet.
   Mainnet ids are filled in after `sui client publish` on mainnet. */
const DEPLOYMENTS = {
  testnet: {
    // Original package — existing repos/PRs/releases events stay under this id.
    packageId: '0x07b63031a435ba7e38909e858c97e9bb6cad14ca5cb51dc9d1fdb9720f237de1',
    forgeRegistry: '0x526227556a1e1da65fe2612423e4b8223b8ad38c3d516d9bc62f975d00796a02',
    // Upgraded package (playground + builder-reputation + moderation + remix-reputation
    // + versioning/update_app + handles/NameRegistry + Treasury/tip_app_v2 + app-bounties
    // + paid-fork set_fork_price/pay_to_fork + private apps set_private/seal_approve_app_owner) — Playground WRITES/calls.
    playgroundPackageId: '0x1fac353343e74dbf2757d6ea475127fcafc6dadbcf3737b4116f365eb7fbb61e',
    // An event's type carries the package id of the UPGRADE that DEFINED its struct —
    // not the original module id. So AppPublished lives under the original pkg, but
    // BuilderScored/AppFlagged/NameClaimed/AppBounty*/AppForkPaid/AppPrivacySet live under later upgrade pkgs.
    // Event reads must query ALL historical playground packages and merge.
    playgroundEventPkg: '0x78ff7299034508b8581a9725d8c6d6bda86813fbdacc5bb8666c0789908b1fcd',
    playgroundEventPkgs: [
      '0x1fac353343e74dbf2757d6ea475127fcafc6dadbcf3737b4116f365eb7fbb61e', // v9 (private apps: AppPrivacySet)
      '0xb2054d83ea80eac464e9601e0c9a5e7a06920e0161ca4f313ec03c4d3c62a760', // v8 (paid-fork: ForkPriceSet/AppForkPaid)
      '0x77dcd2cf25f851770105282d48ea847e411c2043d6d894e8dee29eb16abcb33a', // v7 (app bounties)
      '0x8a94e39a04a0deae876520499f3fcb3e241444483a128faace90a2556dd0c6fe', // v6 (versioning/handles/treasury)
      '0x5b0435fd37e23babb10fed7b5447f5ace605672e1171adb2dc9ba95e041a5b29', // v5 (remix-reputation)
      '0x8f1a795e6005b5b559c6fa82f10fc93eb5840dc4741ac2147f1c71ee8912cb4c', // builder-board + moderation
      '0x78ff7299034508b8581a9725d8c6d6bda86813fbdacc5bb8666c0789908b1fcd', // original (AppPublished/Visited/Starred/Remixed/Tipped)
    ],
    starRegistry: '0xa20bdff43241fbb1629e26e23ee911f2685e1babc950af368411e56ffa1167e2',
    builderBoard: '0xec1eeaf5b9703e14ebb18e88cb3b4d830eb57345b6833e0da5dac0594c62fa2f',
    flagRegistry: '0x48068f761d6d05e74a069393852ff1c481481c5171c2068ccad060b95268a046',
    nameRegistry: '0xf802954a95dab72f878175aa2340ca7be25055210f44be5f51af15b0d8b62f10',
    treasury: '0x9062ed0b2d6506d9108632bead5a6a466320a85bf51359b00611c94fd89ad921',
    forkRegistry: '0xc774e8caffee5289079454422c2adb7ed425e58e1e657e8fcc0534971d753909',
    privacyRegistry: '0x1c33121003f42314aa424cebc63c41eab346744eef0c871f98c73d24f8ecd20f',
    appBounties: true, // package v7 (post/award/cancel_app_bounty) live on testnet
    paidFork: true, // package v8 (set_fork_price/pay_to_fork) live on testnet
    privateApps: true, // package v9 (set_private/seal_approve_app_owner) live on testnet
    walrusAggregator: 'https://aggregator.walrus-testnet.walrus.space',
    walrusPublisher: 'https://publisher.walrus-testnet.walrus.space',
  },
  mainnet: {
    packageId: '0x9db741d5dfea02b1aadedaff43e73bde3972adf82beadf7cc6da26f107bfbc54',
    forgeRegistry: '0xc33128b32c015cf010116499d87bebb9899aec410b790902bf6208b992fa2071',
    playgroundPackageId: '0x60e6933e4b92c4deb2f9afb37c143581d1bd589b2f2a32d76c9c2189a287b36a',
    // On mainnet the playground module first appeared at 0x6838f792, so events
    // are read under that original id (not the latest moderation upgrade).
    playgroundEventPkg: '0x6838f7929bd93439049fa910bc696a6f73ee2c7a44b3ab261d032de47877cb3f',
    playgroundEventPkgs: [
      '0x60e6933e4b92c4deb2f9afb37c143581d1bd589b2f2a32d76c9c2189a287b36a', // paid-fork + private apps (ForkPriceSet/AppForkPaid/AppPrivacySet)
      '0x15e366431d2a073bf872af4b973d800064406128ad092252034b606202d46a26', // v7
      '0xb030714baf9d34a8a44692514c4db96feb6a11af0d711f7693238e593fcf36f0', // v6
      '0x9c096734725154a7487e128d48982e7d3e64c6ba26c3e1c2168231dd553f59e8', // v5
      '0x6838f7929bd93439049fa910bc696a6f73ee2c7a44b3ab261d032de47877cb3f', // original
    ],
    starRegistry: '0xa5c1f4728e569ba746566a7b7b2ee2a0ac84e70899f834bc7421d154d4dd7882',
    builderBoard: '0x30554909424e02922b9e0631a03a2d9df2a16f81e42e78565ef61c9213fc846b',
    flagRegistry: '0x50150e7d1e96bd32429b816a76ebda5e5a73f1c351ff6befd4f162f0ae52c952',
    nameRegistry: '0xfd2c19e19676ab84edcfa522856080e1cb30558c900004a370220f8cbc2acf1f',
    treasury: '0x37be3e8a75745aa9e5982a117d59a6fc1ea5d090eeff2587e1d31d145a345f82',
    forkRegistry: '0x37f94756fc0fc31b1ade28feb64eb3b999889b1fed95bb6b88ea05d3d9aff6b7',
    privacyRegistry: '0xe86037660a532386e39d6fb787ae138312af8cd5d6ea046955ce30188ef19935',
    appBounties: true, // package v7 (post/award/cancel_app_bounty) live on mainnet
    paidFork: true, // paid-fork (set_fork_price/pay_to_fork) live on mainnet
    privateApps: true, // private apps (set_private/seal_approve_app_owner) live on mainnet
    walrusAggregator: 'https://aggregator.walrus-mainnet.walrus.space',
    walrusPublisher: 'https://publisher.walrus-mainnet.walrus.space',
  },
};

function pickNetwork() {
  try {
    const q = new URLSearchParams(location.search).get('network');
    if (q === 'mainnet' || q === 'testnet') { localStorage.setItem('wf.network', q); return q; }
    const saved = localStorage.getItem('wf.network');
    if (saved === 'mainnet' || saved === 'testnet') return saved;
  } catch {}
  return 'testnet';
}

/* Deploy-time config (config.js sets window.__WF_CONFIG before app.js) + ?query overrides.
   Precedence for service URLs: built-in defaults → __WF_CONFIG → ?query → localStorage (user wins). */
const WF = (typeof window !== 'undefined' && window.__WF_CONFIG) || {};
function queryOverrides() {
  try {
    const q = new URLSearchParams(location.search);
    const map = { sponsor: 'sponsorUrl', portal: 'portalUrl', proxy: 'llmProxyUrl', zkSalt: 'zkSaltUrl', zkProver: 'zkProverUrl', zkClient: 'zkGoogleClientId' };
    const out = {};
    for (const [k, v] of Object.entries(map)) { const val = q.get(k); if (val) out[v] = val; }
    return out;
  } catch { return {}; }
}
const QO = queryOverrides();

const NETWORK = pickNetwork();
export const CFG = {
  network: NETWORK,
  ...DEPLOYMENTS[NETWORK],
  llmProxyUrl: QO.llmProxyUrl || WF.llmProxyUrl || '',
};
/** Is the active network deployed (package id present)? */
export const CFG_READY = !!CFG.packageId;

/* ---------- User settings (persisted) ---------- */
const SETTINGS_KEY = 'wf.settings';
export const SETTINGS = Object.assign({
  explorer: 'suiscan',      // 'suiscan' | 'suivision'
  autoRefresh: false,
  refreshSeconds: 30,
  onlyMine: false,
  reduceMotion: false,
  sponsorUrl: '',           // hosted sponsor service /sponsor endpoint (gas-free actions)
  portalUrl: '',            // public portal origin — Share links use <portal>/app/<id> (link previews)
  zkGoogleClientId: '',     // zkLogin: Google OAuth client id
  zkSaltUrl: '',            // zkLogin: salt service /salt endpoint
  zkProverUrl: '',          // zkLogin: zk prover endpoint (self-hosted or hosted)
  zkRedirectUri: '',        // zkLogin: OAuth redirect (defaults to current page)
}, WF, QO, loadSettings());

function loadSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); } catch { return {}; }
}
export function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(SETTINGS)); } catch {}
}

/* ---------- Sui client ---------- */
export const sui = new SuiClient({ url: getFullnodeUrl(CFG.network) });

/** Reject if a read (RPC/fetch) doesn't settle within `ms`, so a hung/slow
    fullnode surfaces as an error instead of an indefinite spinner. Mirrors the
    server-side `fetchT` timeout. */
export function withTimeout(promise, ms = 12000, label = 'request') {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(label + ' timed out')), ms)),
  ]);
}

/* ---------- Explorer + Walrus links (network- and explorer-setting-aware) ---------- */
const NET = CFG.network; // 'testnet' | 'mainnet'
// Suiscan: mainnet path is /mainnet, testnet is /testnet. SuiVision: mainnet has no
// subdomain prefix, testnet uses testnet.suivision.xyz.
const svHost = NET === 'mainnet' ? 'https://suivision.xyz' : 'https://testnet.suivision.xyz';
export function explorerObject(id) {
  return SETTINGS.explorer === 'suivision' ? `${svHost}/object/${id}` : `https://suiscan.xyz/${NET}/object/${id}`;
}
export function explorerAddress(addr) {
  return SETTINGS.explorer === 'suivision' ? `${svHost}/account/${addr}` : `https://suiscan.xyz/${NET}/account/${addr}`;
}
export function explorerTx(d) {
  return SETTINGS.explorer === 'suivision' ? `${svHost}/txblock/${d}` : `https://suiscan.xyz/${NET}/tx/${d}`;
}
export const blobUrl = (id) => `${CFG.walrusAggregator}/v1/blobs/${id}`;
export const walruscanBlob = (id) => `https://walruscan.com/${NET}/blob/${id}`;

/* ---------- Formatting (now backed by @mysten/sui/utils) ---------- */
export function short(id, h = 6, t = 4) {
  if (!id) return '';
  if (isValidSuiAddress(id) || isValidSuiObjectId(id)) return formatAddress(id);
  return id.length <= h + t + 2 ? id : `${id.slice(0, h)}…${id.slice(-t)}`;
}
export { formatAddress, isValidSuiAddress, isValidSuiObjectId };
export const MIST = Number(MIST_PER_SUI);
export const suiAmount = (mist) => (Number(mist) / MIST).toLocaleString(undefined, { maximumFractionDigits: 4 });

/* ---------- Status label helpers ---------- */
export const PR_STATUS = ['open', 'merged', 'closed'];
export const prStatusLabel = (s) => PR_STATUS[s] ?? 'unknown';
export const ISSUE_STATUS = ['open', 'closed'];
export const issueStatusLabel = (s) => ISSUE_STATUS[s] ?? 'unknown';
export const BOUNTY_STATUS = ['open', 'claimed', 'paid', 'cancelled'];
export const bountyStatusLabel = (s) => BOUNTY_STATUS[s] ?? 'unknown';

/* ---------- DOM + object helpers ---------- */
export const $ = (id) => document.getElementById(id);
export const fields = (obj) => obj?.data?.content?.fields ?? {};
export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------- Shared, cached app state ---------- */
export const STATE = {
  loaded: false,
  repos: [], prs: [], releases: [], reps: [], issues: [], bounties: [],
  activity: { perMod: {}, total: 0, tsBuckets: new Map(), feed: [] },
  repoNameById: new Map(),
  agentCaps: new Map(),
  manifestCache: new Map(),
  archiveCache: new Map(),
  nameCache: new Map(),   // addr -> SuiNS name | null
  wallet: null,           // { address, account, wallet } when connected
  myCaps: { owner: new Map(), agent: new Map() }, // repoId -> capId
  lastUpdated: 0,
};

/* ---------- Scope bitflags (mirror of Move constants) ---------- */
export const SCOPE_OPEN_PR = 1;
export const SCOPE_REVIEW = 2;
export const SCOPE_RUN_CI = 4;
export const SCOPE_NAMES = [[1, 'open_pr'], [2, 'review'], [4, 'run_ci']];
export function scopeChips(scopes) {
  return SCOPE_NAMES.filter(([bit]) => (scopes & bit) === bit).map(([, n]) => n);
}

/* Trust tier from aggregate score (derived, display-only). */
export function scoreTier(score) {
  if (score >= 50) return { tier: 'trusted', cls: 'tier-trusted' };
  if (score >= 20) return { tier: 'verified', cls: 'tier-verified' };
  if (score >= 5) return { tier: 'contributor', cls: 'tier-contributor' };
  return { tier: 'new', cls: 'tier-new' };
}
