import type { ForgeContext } from "./lib/sui.js";
import {
  agentReputation,
  agentVouch,
  artifactUpload,
  bountyClaim,
  bountyList,
  bountyPost,
  bountySubmit,
  issueComment,
  issueCreate,
  issueList,
  prCreate,
  publishPlaygroundApp,
  releaseAttestation,
  releaseRead,
  repoList,
  repoReadManifest,
  reviewSubmit,
  verifyRelease,
  type FileInput,
} from "./lib/actions.js";
import { createdOfType } from "./lib/sui.js";
import { cancelPaymentRequest, createPaymentRequest, payPaymentRequest } from "./lib/sui.js";

export type ReadSource = "json-rpc" | "graphql" | "grpc" | "indexer-cache";

export interface ReverifyAnchor {
  network?: string;
  packageId?: string;
  objectIds?: string[];
  txDigest?: string;
  blobIds?: string[];
  treeHashes?: string[];
}

export interface SignetResult<T> {
  ok: boolean;
  data?: T;
  digest?: string;
  created?: string[];
  reverify?: ReverifyAnchor;
  error?: { message: string; raw?: unknown };
}

function networkOf(ctx?: ForgeContext) {
  return process.env.FORGE_NETWORK === "mainnet" ? "mainnet" : ctx?.deployment?.chainId || "testnet";
}

function txDigestOf(value: any): string | undefined {
  return value?.txDigest || value?.digest;
}

function objectIdsOf(value: any): string[] {
  return [
    value?.repoId,
    value?.prId,
    value?.releaseId,
    value?.issueId,
    value?.bountyId,
    value?.appId,
    value?.reviewId,
  ].filter(Boolean).map(String);
}

function blobIdsOf(value: any): string[] {
  return [
    value?.snapshotBlob,
    value?.headBlob,
    value?.reviewBlob,
    value?.bodyBlob,
    value?.manifestBlob,
    value?.archiveBlob,
    value?.blobId,
    value?.chain?.source?.blob,
    value?.chain?.artifact?.blob,
    value?.chain?.testReport?.blob,
  ].filter(Boolean).map(String);
}

export async function toSignetResult<T>(
  run: () => Promise<T>,
  opts: { ctx?: ForgeContext; created?: (value: T) => string[] } = {},
): Promise<SignetResult<T>> {
  try {
    const data = await run();
    const digest = txDigestOf(data);
    const created = opts.created ? opts.created(data) : objectIdsOf(data);
    return {
      ok: true,
      data,
      digest,
      created,
      reverify: {
        network: networkOf(opts.ctx),
        packageId: opts.ctx?.deployment?.packageId,
        objectIds: created,
        txDigest: digest,
        blobIds: blobIdsOf(data),
      },
    };
  } catch (e: any) {
    return { ok: false, error: { message: String(e?.message ?? e), raw: e } };
  }
}

export class ForgeClient {
  constructor(readonly ctx?: ForgeContext) {}

  listRepos() {
    return toSignetResult(() => repoList(), { ctx: this.ctx });
  }

  readManifest(repoId: string) {
    return toSignetResult(() => repoReadManifest({ repoId }), { ctx: this.ctx });
  }

  uploadArtifact(content: string) {
    return toSignetResult(() => artifactUpload({ content }), { ctx: this.ctx });
  }
}

export class ReleaseClient {
  constructor(readonly ctx?: ForgeContext) {}

  read(releaseId: string) {
    return toSignetResult(() => releaseRead({ releaseId }), { ctx: this.ctx });
  }

  verify(releaseId: string) {
    return toSignetResult(() => verifyRelease(releaseId), { ctx: this.ctx });
  }

  attestation(releaseId: string) {
    return toSignetResult(() => releaseAttestation({ releaseId }), { ctx: this.ctx });
  }
}

export class BountyClient {
  constructor(readonly ctx?: ForgeContext) {}

  list(repoId: string) {
    return toSignetResult(() => bountyList({ repoId }), { ctx: this.ctx });
  }

  post(args: { repoId: string; title: string; amountMist: number }) {
    if (!this.ctx) return Promise.resolve({ ok: false, error: { message: "ForgeContext required for bounty post" } });
    return toSignetResult(() => bountyPost({ ctx: this.ctx!, ...args }), { ctx: this.ctx });
  }

  claim(args: { bountyId: string; repoId: string }) {
    if (!this.ctx) return Promise.resolve({ ok: false, error: { message: "ForgeContext required for bounty claim" } });
    return toSignetResult(() => bountyClaim({ ctx: this.ctx!, ...args }), { ctx: this.ctx });
  }

  submit(args: { bountyId: string; proof: string }) {
    if (!this.ctx) return Promise.resolve({ ok: false, error: { message: "ForgeContext required for bounty submit" } });
    return toSignetResult(() => bountySubmit({ ctx: this.ctx!, ...args }), { ctx: this.ctx });
  }
}

export class PlaygroundClient {
  constructor(readonly ctx?: ForgeContext) {}

  publish(args: { name: string; prompt: string; category?: string; files: FileInput[]; parent?: string | null }) {
    if (!this.ctx) return Promise.resolve({ ok: false, error: { message: "ForgeContext required for app publish" } });
    return toSignetResult(() => publishPlaygroundApp({ ctx: this.ctx!, ...args }), { ctx: this.ctx });
  }
}

export class AgentClient {
  constructor(readonly ctx?: ForgeContext) {}

  reputation(args: { repoId: string; agent: string }) {
    return toSignetResult(() => agentReputation(args), { ctx: this.ctx });
  }

  vouch(args: { repoId: string; subject: string }) {
    if (!this.ctx) return Promise.resolve({ ok: false, error: { message: "ForgeContext required for vouch" } });
    return toSignetResult(() => agentVouch({ ctx: this.ctx!, ...args }), { ctx: this.ctx });
  }

  openPr(args: { repoId: string; agentCapId: string; title: string; files: FileInput[] }) {
    if (!this.ctx) return Promise.resolve({ ok: false, error: { message: "ForgeContext required for PR create" } });
    return toSignetResult(() => prCreate({ ctx: this.ctx!, ...args }), { ctx: this.ctx });
  }

  review(args: { repoId: string; prId: string; agentCapId: string; verdict: number; reportText: string }) {
    if (!this.ctx) return Promise.resolve({ ok: false, error: { message: "ForgeContext required for review" } });
    return toSignetResult(() => reviewSubmit({ ctx: this.ctx!, ...args }), { ctx: this.ctx });
  }
}

export class IssueClient {
  constructor(readonly ctx?: ForgeContext) {}

  list(repoId: string) {
    return toSignetResult(() => issueList({ repoId }), { ctx: this.ctx });
  }

  create(args: { repoId: string; title: string; body: string }) {
    if (!this.ctx) return Promise.resolve({ ok: false, error: { message: "ForgeContext required for issue create" } });
    return toSignetResult(() => issueCreate({ ctx: this.ctx!, ...args }), { ctx: this.ctx });
  }

  comment(args: { issueId: string; body: string }) {
    if (!this.ctx) return Promise.resolve({ ok: false, error: { message: "ForgeContext required for issue comment" } });
    return toSignetResult(() => issueComment({ ctx: this.ctx!, ...args }), { ctx: this.ctx });
  }
}

export class PaymentClient {
  constructor(readonly ctx?: ForgeContext) {}

  create(args: { recipient: string; label: string; amountMist: number; expiresAtMs?: number | null }) {
    if (!this.ctx) return Promise.resolve({ ok: false, error: { message: "ForgeContext required for payment request create" } });
    return toSignetResult(async () => {
      const res = await createPaymentRequest(this.ctx!, args);
      return {
        txDigest: res.digest,
        requestId: createdOfType(res, "::payment::PaymentRequest")[0],
      };
    }, { ctx: this.ctx });
  }

  pay(args: { requestId: string; amountMist: number }) {
    if (!this.ctx) return Promise.resolve({ ok: false, error: { message: "ForgeContext required for payment" } });
    return toSignetResult(async () => {
      const res = await payPaymentRequest(this.ctx!, args);
      return { txDigest: res.digest, requestId: args.requestId };
    }, { ctx: this.ctx });
  }

  cancel(args: { requestId: string }) {
    if (!this.ctx) return Promise.resolve({ ok: false, error: { message: "ForgeContext required for payment cancel" } });
    return toSignetResult(async () => {
      const res = await cancelPaymentRequest(this.ctx!, args);
      return { txDigest: res.digest, requestId: args.requestId };
    }, { ctx: this.ctx });
  }
}

export function signetClients(ctx?: ForgeContext) {
  return {
    forge: new ForgeClient(ctx),
    release: new ReleaseClient(ctx),
    bounty: new BountyClient(ctx),
    playground: new PlaygroundClient(ctx),
    agent: new AgentClient(ctx),
    issue: new IssueClient(ctx),
    payment: new PaymentClient(ctx),
  };
}

export { createdOfType };
