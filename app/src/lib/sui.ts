/**
 * Sui client + PTB builders for Signet.
 *
 * Loads the keypair from the local Sui CLI keystore (the same wallet the CLI
 * signs with — we never take a raw private key as input), connects to testnet,
 * and exposes one function per on-chain action. Each builds a programmable
 * transaction calling the deployed `signet` package.
 */

import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Secp256k1Keypair } from "@mysten/sui/keypairs/secp256k1";
import type { Keypair } from "@mysten/sui/cryptography";

// Resolve deployments.json relative to the move package (sibling of app/).
const __dirname = dirname(fileURLToPath(import.meta.url));
const DEPLOYMENTS_PATH = join(__dirname, "..", "..", "..", "move", "signet", "deployments.json");

export interface Deployment {
  chainId: string;
  packageId: string;
  forgeRegistry: string;
  upgradeCap: string;
  /** Upgraded package that contains the `playground` module (optional). */
  playgroundPackageId?: string;
  /** Shared StarRegistry object for the playground module (optional). */
  starRegistry?: string;
  /** Shared BuilderBoard object for the playground module (optional). */
  builderBoard?: string;
}

export function loadDeployment(network = "testnet"): Deployment {
  const all = JSON.parse(readFileSync(DEPLOYMENTS_PATH, "utf8"));
  const d = all[network];
  if (!d) throw new Error(`No deployment for network ${network} in ${DEPLOYMENTS_PATH}`);
  if (!d.packageId) {
    throw new Error(
      `Deployment for ${network} is not published yet (empty packageId). ` +
        `Publish the package on ${network} and fill move/signet/deployments.json.`,
    );
  }
  return d;
}

function keypairFromEntry(entry: string): Keypair {
  const raw = Buffer.from(entry, "base64");
  const flag = raw[0];
  const secret = raw.subarray(1);
  if (flag === 0x00) return Ed25519Keypair.fromSecretKey(secret);
  if (flag === 0x01) return Secp256k1Keypair.fromSecretKey(secret);
  throw new Error(`Unsupported key scheme flag: ${flag}`);
}

/** Read the CLI's active address from client.yaml, if present. */
function readActiveAddress(): string | null {
  try {
    const yaml = readFileSync(
      join(homedir(), ".sui", "sui_config", "client.yaml"),
      "utf8",
    );
    const m = yaml.match(/active_address:\s*"?(0x[0-9a-fA-F]+)"?/);
    return m ? m[1].toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * Load the keypair that matches the Sui CLI's active address. The keystore
 * stores each key as base64 of (flag-byte || 32-byte secret); flag 0x00 =
 * Ed25519, 0x01 = Secp256k1. We derive each address and pick the active one,
 * so the CLI signs with the same (funded) wallet as `sui client`.
 */
export function loadKeypairFromKeystore(): Keypair {
  const keystorePath = join(homedir(), ".sui", "sui_config", "sui.keystore");
  const keys: string[] = JSON.parse(readFileSync(keystorePath, "utf8"));
  if (keys.length === 0) throw new Error("Sui keystore is empty");

  const active = readActiveAddress();
  if (active) {
    for (const entry of keys) {
      const kp = keypairFromEntry(entry);
      if (kp.getPublicKey().toSuiAddress().toLowerCase() === active) return kp;
    }
  }
  // Fallback: first key.
  return keypairFromEntry(keys[0]);
}

export interface ForgeContext {
  client: SuiClient;
  keypair: Keypair;
  address: string;
  deployment: Deployment;
}

export function makeContext(network = "testnet"): ForgeContext {
  return makeContextWithKeypair(loadKeypairFromKeystore(), network);
}

/**
 * Build a context around a caller-supplied keypair. Used by the MCP server,
 * which signs as the *agent* (key from FORGE_AGENT_KEY), not the keystore owner.
 */
export function makeContextWithKeypair(keypair: Keypair, network = "testnet"): ForgeContext {
  return {
    client: new SuiClient({ url: getFullnodeUrl(network as "testnet") }),
    keypair,
    address: keypair.getPublicKey().toSuiAddress(),
    deployment: loadDeployment(network),
  };
}

async function sign(ctx: ForgeContext, tx: Transaction) {
  const res = await ctx.client.signAndExecuteTransaction({
    signer: ctx.keypair,
    transaction: tx,
    options: { showObjectChanges: true, showEvents: true, showEffects: true },
  });
  await ctx.client.waitForTransaction({ digest: res.digest });
  if (res.effects?.status.status !== "success") {
    throw new Error(`Tx failed: ${JSON.stringify(res.effects?.status)}`);
  }
  return res;
}

/** Pull created object ids of a given short type name from a tx result. */
export function createdOfType(res: any, shortType: string): string[] {
  return (res.objectChanges ?? [])
    .filter((o: any) => o.type === "created" && String(o.objectType).endsWith(shortType))
    .map((o: any) => o.objectId);
}

// ===== PTB builders =====

export async function createRepo(
  ctx: ForgeContext,
  args: { name: string; defaultBranch: string; initialSnapshot: string },
) {
  const tx = new Transaction();
  tx.moveCall({
    target: `${ctx.deployment.packageId}::forge::create_repo`,
    arguments: [
      tx.object(ctx.deployment.forgeRegistry),
      tx.pure.string(args.name),
      tx.pure.string(args.defaultBranch),
      tx.pure.string(args.initialSnapshot),
    ],
  });
  return sign(ctx, tx);
}

export async function grantAgentCap(
  ctx: ForgeContext,
  args: {
    repoId: string;
    ownerCapId: string;
    recipient: string;
    scopes: number;
    expiresAtEpoch: number;
    label: string;
  },
) {
  const tx = new Transaction();
  tx.moveCall({
    target: `${ctx.deployment.packageId}::forge::grant_agent_cap`,
    arguments: [
      tx.object(args.repoId),
      tx.object(args.ownerCapId),
      tx.pure.address(args.recipient),
      tx.pure.u8(args.scopes),
      tx.pure.u64(args.expiresAtEpoch),
      tx.pure.string(args.label),
    ],
  });
  return sign(ctx, tx);
}

export async function openPrAsAgent(
  ctx: ForgeContext,
  args: {
    repoId: string;
    reputationId: string;
    agentCapId: string;
    headSnapshot: string;
    diffManifest: string;
    title: string;
  },
) {
  const tx = new Transaction();
  tx.moveCall({
    target: `${ctx.deployment.packageId}::pull_request::open_pr_as_agent`,
    arguments: [
      tx.object(args.repoId),
      tx.object(args.reputationId),
      tx.object(args.agentCapId),
      tx.pure.string(args.headSnapshot),
      tx.pure.string(args.diffManifest),
      tx.pure.string(args.title),
    ],
  });
  return sign(ctx, tx);
}

export async function submitReviewAsAgent(
  ctx: ForgeContext,
  args: {
    repoId: string;
    reputationId: string;
    prId: string;
    agentCapId: string;
    verdict: number;
    reportBlob: string;
  },
) {
  const tx = new Transaction();
  tx.moveCall({
    target: `${ctx.deployment.packageId}::pull_request::submit_review_as_agent`,
    arguments: [
      tx.object(args.repoId),
      tx.object(args.reputationId),
      tx.object(args.prId),
      tx.object(args.agentCapId),
      tx.pure.u8(args.verdict),
      tx.pure.string(args.reportBlob),
    ],
  });
  return sign(ctx, tx);
}

export async function mergePr(
  ctx: ForgeContext,
  args: { repoId: string; reputationId: string; prId: string; ownerCapId: string },
) {
  const tx = new Transaction();
  tx.moveCall({
    target: `${ctx.deployment.packageId}::pull_request::merge_pr`,
    arguments: [
      tx.object(args.repoId),
      tx.object(args.reputationId),
      tx.object(args.prId),
      tx.object(args.ownerCapId),
    ],
  });
  return sign(ctx, tx);
}

export async function revokeAgentCap(
  ctx: ForgeContext,
  args: { repoId: string; ownerCapId: string; agentCapId: string },
) {
  const tx = new Transaction();
  tx.moveCall({
    target: `${ctx.deployment.packageId}::forge::revoke_agent_cap`,
    arguments: [
      tx.object(args.repoId),
      tx.object(args.ownerCapId),
      tx.pure.id(args.agentCapId),
    ],
  });
  return sign(ctx, tx);
}

export async function publishRelease(
  ctx: ForgeContext,
  args: {
    repoId: string;
    ownerCapId: string;
    version: string;
    sourceSnapshot: string;
    buildArtifact: string;
    testReport: string;
  },
) {
  const tx = new Transaction();
  tx.moveCall({
    target: `${ctx.deployment.packageId}::release::publish_release`,
    arguments: [
      tx.object(args.repoId),
      tx.object(args.ownerCapId),
      tx.pure.string(args.version),
      tx.pure.string(args.sourceSnapshot),
      tx.pure.string(args.buildArtifact),
      tx.pure.string(args.testReport),
    ],
  });
  return sign(ctx, tx);
}

// ===== Issues =====

export async function openIssue(
  ctx: ForgeContext,
  args: { repoId: string; title: string; bodyBlob: string },
) {
  const tx = new Transaction();
  tx.moveCall({
    target: `${ctx.deployment.packageId}::issue::open_issue`,
    arguments: [tx.object(args.repoId), tx.pure.string(args.title), tx.pure.string(args.bodyBlob)],
  });
  return sign(ctx, tx);
}

export async function commentIssue(
  ctx: ForgeContext,
  args: { issueId: string; bodyBlob: string },
) {
  const tx = new Transaction();
  tx.moveCall({
    target: `${ctx.deployment.packageId}::issue::comment_issue`,
    arguments: [tx.object(args.issueId), tx.pure.string(args.bodyBlob)],
  });
  return sign(ctx, tx);
}

// ===== Bounties =====

/** Post a bounty: split `amountMist` off gas into a fresh coin, then escrow it. */
export async function postBounty(
  ctx: ForgeContext,
  args: { repoId: string; title: string; amountMist: number; minScore?: number },
) {
  const tx = new Transaction();
  const [payment] = tx.splitCoins(tx.gas, [tx.pure.u64(args.amountMist)]);
  tx.moveCall({
    target: `${ctx.deployment.packageId}::bounty::post_bounty`,
    arguments: [
      tx.object(args.repoId),
      tx.pure.string(args.title),
      payment,
      tx.pure.u64(args.minScore ?? 0),
    ],
  });
  return sign(ctx, tx);
}

export async function claimBounty(ctx: ForgeContext, args: { bountyId: string; reputationId: string }) {
  const tx = new Transaction();
  tx.moveCall({
    target: `${ctx.deployment.packageId}::bounty::claim_bounty`,
    arguments: [tx.object(args.bountyId), tx.object(args.reputationId)],
  });
  return sign(ctx, tx);
}

/** Vouch for another agent (raises their reputation score). Permissionless,
 *  gated on-chain by the voucher's own score. */
export async function vouch(
  ctx: ForgeContext,
  args: { reputationId: string; subject: string },
) {
  const tx = new Transaction();
  tx.moveCall({
    target: `${ctx.deployment.packageId}::reputation::vouch`,
    arguments: [tx.object(args.reputationId), tx.pure.address(args.subject)],
  });
  return sign(ctx, tx);
}

/** Owner sets the minimum APPROVE reviews required before a PR can merge. */
export async function setMinApprovals(
  ctx: ForgeContext,
  args: { repoId: string; ownerCapId: string; n: number },
) {
  const tx = new Transaction();
  tx.moveCall({
    target: `${ctx.deployment.packageId}::forge::set_min_approvals`,
    arguments: [tx.object(args.repoId), tx.object(args.ownerCapId), tx.pure.u8(args.n)],
  });
  return sign(ctx, tx);
}

export async function submitBounty(
  ctx: ForgeContext,
  args: { bountyId: string; proof: string },
) {
  const tx = new Transaction();
  tx.moveCall({
    target: `${ctx.deployment.packageId}::bounty::submit_bounty`,
    arguments: [tx.object(args.bountyId), tx.pure.string(args.proof)],
  });
  return sign(ctx, tx);
}

/** Publish a Playground app on-chain (agents/CLI parity with the web).
   Requires the upgraded package id (deployment.playgroundPackageId). */
export async function publishApp(
  ctx: ForgeContext,
  args: {
    name: string; prompt: string; manifestBlob: string; archiveBlob: string;
    treeHash: string; category: string; parent?: string | null;
  },
) {
  const pkg = ctx.deployment.playgroundPackageId;
  if (!pkg) throw new Error("playgroundPackageId not set in deployment");
  const builderBoard = ctx.deployment.builderBoard;
  if (!builderBoard) throw new Error("builderBoard not set in deployment");
  const tx = new Transaction();
  const head = [
    tx.pure.string(args.name),
    tx.pure.string(args.prompt.slice(0, 300)),
    tx.pure.string(args.manifestBlob),
    tx.pure.string(args.archiveBlob),
    tx.pure.string(args.treeHash),
    tx.pure.string(args.category),
  ];
  if (args.parent) {
    // Remix: pass the parent app by reference so the contract credits the parent
    // builder's on-chain reputation (remixes_received) and records lineage.
    tx.moveCall({
      target: `${pkg}::playground::publish_remix_v3`,
      arguments: [...head, tx.object(args.parent), tx.object(builderBoard), tx.object("0x6")],
    });
  } else {
    const parentNone = tx.moveCall({ target: "0x1::option::none", typeArguments: ["0x2::object::ID"], arguments: [] });
    tx.moveCall({
      target: `${pkg}::playground::publish_app_v2`,
      arguments: [...head, parentNone, tx.object(builderBoard), tx.object("0x6")],
    });
  }
  return sign(ctx, tx);
}

export async function approveBounty(ctx: ForgeContext, args: { bountyId: string }) {
  const tx = new Transaction();
  tx.moveCall({
    target: `${ctx.deployment.packageId}::bounty::approve_bounty`,
    arguments: [tx.object(args.bountyId)],
  });
  return sign(ctx, tx);
}

// ===== Scope bitflags (mirror of the Move constants) =====

export const SCOPE_OPEN_PR = 1;
export const SCOPE_REVIEW = 2;
export const SCOPE_RUN_CI = 4;
