/**
 * Sui client + PTB builders for WalrusForge.
 *
 * Loads the keypair from the local Sui CLI keystore (the same wallet the CLI
 * signs with — we never take a raw private key as input), connects to testnet,
 * and exposes one function per on-chain action. Each builds a programmable
 * transaction calling the deployed `walrusforge` package.
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
const DEPLOYMENTS_PATH = join(__dirname, "..", "..", "..", "move", "walrusforge", "deployments.json");

export interface Deployment {
  chainId: string;
  packageId: string;
  forgeRegistry: string;
  upgradeCap: string;
}

export function loadDeployment(network = "testnet"): Deployment {
  const all = JSON.parse(readFileSync(DEPLOYMENTS_PATH, "utf8"));
  const d = all[network];
  if (!d) throw new Error(`No deployment for network ${network} in ${DEPLOYMENTS_PATH}`);
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
  args: { repoId: string; title: string; amountMist: number },
) {
  const tx = new Transaction();
  const [payment] = tx.splitCoins(tx.gas, [tx.pure.u64(args.amountMist)]);
  tx.moveCall({
    target: `${ctx.deployment.packageId}::bounty::post_bounty`,
    arguments: [tx.object(args.repoId), tx.pure.string(args.title), payment],
  });
  return sign(ctx, tx);
}

export async function claimBounty(ctx: ForgeContext, args: { bountyId: string }) {
  const tx = new Transaction();
  tx.moveCall({
    target: `${ctx.deployment.packageId}::bounty::claim_bounty`,
    arguments: [tx.object(args.bountyId)],
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
