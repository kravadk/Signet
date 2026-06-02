/**
 * Agent keypair loading for the Signet MCP server.
 *
 * The MCP server signs as the *agent*, not the keystore owner. The agent's
 * private key is supplied via the FORGE_AGENT_KEY env var in bech32 form
 * (suiprivkey1...). Read-only tools work without it; write tools require it.
 *
 * The key is never logged or returned to the caller.
 */

import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Secp256k1Keypair } from "@mysten/sui/keypairs/secp256k1";
import type { Keypair } from "@mysten/sui/cryptography";

let cached: Keypair | null | undefined;

/**
 * Parse the agent keypair from FORGE_AGENT_KEY. Returns null if the env var is
 * absent (caller decides whether the action requires a signer). Throws only if
 * the value is present but malformed.
 */
export function parseAgentKey(): Keypair | null {
  if (cached !== undefined) return cached;

  const raw = process.env.FORGE_AGENT_KEY;
  if (!raw || raw.trim() === "") {
    cached = null;
    return null;
  }

  const { schema, secretKey } = decodeSuiPrivateKey(raw.trim());
  if (schema === "ED25519") {
    cached = Ed25519Keypair.fromSecretKey(secretKey);
  } else if (schema === "Secp256k1") {
    cached = Secp256k1Keypair.fromSecretKey(secretKey);
  } else {
    throw new Error(`Unsupported key schema in FORGE_AGENT_KEY: ${schema}`);
  }
  return cached;
}

/** Like parseAgentKey but throws a user-facing message when no key is set. */
export function requireAgentKey(): Keypair {
  const kp = parseAgentKey();
  if (!kp) {
    throw new Error(
      "This action signs an on-chain transaction but no agent signer is configured. " +
        "Set FORGE_AGENT_KEY (a suiprivkey1... bech32 key) to the agent identity " +
        "that holds the AgentCap.",
    );
  }
  return kp;
}
