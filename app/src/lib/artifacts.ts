export type ArtifactType = "model" | "dataset" | "eval" | "inference" | "ci" | "proof" | "source" | "artifact";

export interface MemoryArtifact {
  artifactType: ArtifactType;
  blobId: string;
  label: string;
  owner?: string | null;
  repoId?: string | null;
  releaseId?: string | null;
  prId?: string | null;
  txDigest?: string | null;
  riskBadge: "trusted" | "partial" | "failed";
}

export function classifyArtifact(label: string, fallback: ArtifactType = "artifact"): ArtifactType {
  const s = label.toLowerCase();
  if (s.includes("model") || s.includes("weights")) return "model";
  if (s.includes("dataset") || s.includes("data set")) return "dataset";
  if (s.includes("eval") || s.includes("benchmark")) return "eval";
  if (s.includes("inference") || s.includes("receipt")) return "inference";
  if (s.includes("proof") || s.includes("attestation")) return "proof";
  if (s.includes("ci") || s.includes("test") || s.includes("report")) return "ci";
  if (s.includes("source") || s.includes("snapshot")) return "source";
  return fallback;
}

export function artifactRecord(args: {
  blobId: string;
  label: string;
  artifactType?: ArtifactType;
  owner?: string | null;
  repoId?: string | null;
  releaseId?: string | null;
  prId?: string | null;
  txDigest?: string | null;
  trusted?: boolean;
}): MemoryArtifact {
  return {
    artifactType: args.artifactType ?? classifyArtifact(args.label),
    blobId: args.blobId,
    label: args.label,
    owner: args.owner ?? null,
    repoId: args.repoId ?? null,
    releaseId: args.releaseId ?? null,
    prId: args.prId ?? null,
    txDigest: args.txDigest ?? null,
    riskBadge: args.trusted ? "trusted" : "partial",
  };
}
