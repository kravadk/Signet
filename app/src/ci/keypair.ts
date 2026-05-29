/**
 * CI agent keypair for the WalrusForge CI worker.
 *
 * The CI worker signs reviews as its own dedicated agent identity, supplied via
 * FORGE_CI_KEY (bech32 suiprivkey1...). Separate from FORGE_AGENT_KEY so the CI
 * runner and a coding agent are distinct on-chain identities — exactly as a real
 * pipeline would have a dedicated CI bot. The key is never logged.
 */

import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Secp256k1Keypair } from "@mysten/sui/keypairs/secp256k1";
import type { Keypair } from "@mysten/sui/cryptography";

export function requireCiKey(): Keypair {
  const raw = process.env.FORGE_CI_KEY;
  if (!raw || raw.trim() === "") {
    throw new Error(
      "FORGE_CI_KEY is not set. Provide the CI agent's suiprivkey1... key " +
        "(the identity that holds an AgentCap with the review scope).",
    );
  }
  const { schema, secretKey } = decodeSuiPrivateKey(raw.trim());
  if (schema === "ED25519") return Ed25519Keypair.fromSecretKey(secretKey);
  if (schema === "Secp256k1") return Secp256k1Keypair.fromSecretKey(secretKey);
  throw new Error(`Unsupported key schema in FORGE_CI_KEY: ${schema}`);
}
