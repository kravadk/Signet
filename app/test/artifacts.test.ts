import test from "node:test";
import assert from "node:assert/strict";

import { artifactRecord, classifyArtifact } from "../src/lib/artifacts.js";

test("classifyArtifact maps common AI/provenance labels", () => {
  assert.equal(classifyArtifact("model weights v1"), "model");
  assert.equal(classifyArtifact("dataset manifest"), "dataset");
  assert.equal(classifyArtifact("eval report"), "eval");
  assert.equal(classifyArtifact("inference receipt"), "inference");
  assert.equal(classifyArtifact("CI test report"), "ci");
  assert.equal(classifyArtifact("SLSA attestation proof"), "proof");
});

test("artifactRecord creates stable memory vault shape", () => {
  const rec = artifactRecord({ blobId: "blob", label: "eval report", releaseId: "0xrel", trusted: true });
  assert.equal(rec.artifactType, "eval");
  assert.equal(rec.releaseId, "0xrel");
  assert.equal(rec.riskBadge, "trusted");
});
