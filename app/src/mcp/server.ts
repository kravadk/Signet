#!/usr/bin/env -S npx tsx
/**
 * Signet MCP server (stdio).
 *
 * Exposes Signet to AI agents as MCP tools. The agent signs with its own
 * key (FORGE_AGENT_KEY) and acts only within its on-chain AgentCap scopes —
 * it can open PRs, review and upload artifacts, but never merge or publish a
 * release (those require the owner cap and are deliberately absent here).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { makeContextWithKeypair } from "../lib/sui.js";
import {
  repoList,
  repoReadManifest,
  releaseRead,
  verifyRelease,
  prCreate,
  reviewSubmit,
  artifactUpload,
  issueList,
  issueCreate,
  issueComment,
  bountyList,
  bountyClaim,
  bountySubmit,
  agentReputation,
  agentVouch,
  publishPlaygroundApp,
} from "../lib/actions.js";
import { requireAgentKey } from "./keypair.js";

/**
 * Translate raw Move/RPC errors into agent-friendly text. Move aborts surface as
 * `MoveAbort(... function_name: Some("fn") ..., <code>)`, so we match on the
 * function + numeric code (the symbolic error name is not in the message).
 */
function explain(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);

  const isAbort = (fn: string, code: number) =>
    msg.includes(`"${fn}"`) && new RegExp(`,\\s*${code}\\)`).test(msg);

  // forge::assert_agent_scope — 2 ECapRepoMismatch, 3 ECapMissingScope, 4 ECapExpired
  if (isAbort("assert_agent_scope", 3)) return "Your AgentCap lacks the required scope for this action.";
  if (isAbort("assert_agent_scope", 4)) return "Your AgentCap has expired.";
  if (isAbort("assert_agent_scope", 2)) return "Your AgentCap belongs to a different repository.";
  // forge::assert_owner — 0 ENotRepoOwner
  if (isAbort("assert_owner", 0)) return "Owner permission required — agents cannot perform this action.";
  // pull_request — EBaseStale / EPrNotOpen
  if (msg.includes("EBaseStale") || isAbort("merge_pr", 2)) return "The repository ref moved; rebase your snapshot and retry.";
  if (msg.includes("EPrNotOpen")) return "That pull request is not open.";

  // Fallback name-based matches (covers non-dry-run error shapes).
  if (msg.includes("ECapMissingScope")) return "Your AgentCap lacks the required scope for this action.";
  if (msg.includes("ECapExpired")) return "Your AgentCap has expired.";
  return msg;
}

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}
function fail(err: unknown) {
  return { isError: true, content: [{ type: "text" as const, text: explain(err) }] };
}

/** Build an agent-signing context, throwing a clear message if no key is set. */
function agentCtx() {
  return makeContextWithKeypair(requireAgentKey());
}

const server = new McpServer({ name: "signet", version: "0.1.0" });

// ===== Read tools (no signer needed) =====

server.registerTool(
  "repo_list",
  {
    title: "List repositories",
    description: "List all Signet repositories on Sui testnet.",
    inputSchema: {},
  },
  async () => {
    try {
      return ok(await repoList());
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "repo_read_manifest",
  {
    title: "Read repo manifest",
    description: "Read the current snapshot manifest (file tree + hashes) of a repository.",
    inputSchema: { repoId: z.string().describe("Repository object id (0x...)") },
  },
  async ({ repoId }) => {
    try {
      return ok(await repoReadManifest({ repoId }));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "release_read",
  {
    title: "Read release provenance",
    description: "Read a release and its full provenance chain (source, artifact, test report) with Walrus URLs.",
    inputSchema: { releaseId: z.string().describe("Release object id (0x...)") },
  },
  async ({ releaseId }) => {
    try {
      return ok(await releaseRead({ releaseId }));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "release_verify",
  {
    title: "Verify release provenance",
    description:
      "Independently verify a release's provenance chain: that source/artifact/report blobs exist on Walrus, the source manifest's treeHash recomputes, and a merged, reviewed PR's head matches the released source. Returns a pass/fail with per-step results and a SLSA-style level. Read-only; no key needed.",
    inputSchema: { releaseId: z.string().describe("Release object id (0x...)") },
  },
  async ({ releaseId }) => {
    try {
      return ok(await verifyRelease(releaseId));
    } catch (e) {
      return fail(e);
    }
  },
);

// ===== Write tools (require FORGE_AGENT_KEY; gated by on-chain AgentCap) =====

server.registerTool(
  "pr_create",
  {
    title: "Open a pull request",
    description:
      "Open a pull request as the agent. Uploads the proposed files to Walrus as a head snapshot and anchors the PR on Sui. Requires an AgentCap with the open_pr scope.",
    inputSchema: {
      repoId: z.string().describe("Repository object id"),
      agentCapId: z.string().describe("Your AgentCap object id"),
      title: z.string().describe("PR title"),
      files: z
        .array(z.object({ path: z.string(), content: z.string() }))
        .describe("Proposed repo files (full contents, inline)"),
    },
  },
  async ({ repoId, agentCapId, title, files }) => {
    try {
      return ok(await prCreate({ ctx: agentCtx(), repoId, agentCapId, title, files }));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "review_submit",
  {
    title: "Submit a review",
    description:
      "Submit a review on a PR as the agent. Stores the report on Walrus and anchors a Review on Sui. Requires an AgentCap with the review scope.",
    inputSchema: {
      repoId: z.string(),
      prId: z.string().describe("PullRequest object id"),
      agentCapId: z.string().describe("Your AgentCap object id"),
      verdict: z.number().int().min(1).max(3).describe("1=approve, 2=request-changes, 3=comment"),
      reportText: z.string().describe("Review / CI report body"),
    },
  },
  async ({ repoId, prId, agentCapId, verdict, reportText }) => {
    try {
      return ok(await reviewSubmit({ ctx: agentCtx(), repoId, prId, agentCapId, verdict, reportText }));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "artifact_upload",
  {
    title: "Upload an artifact",
    description: "Upload arbitrary text content (a build artifact or report) to Walrus and return its blob id + URL.",
    inputSchema: { content: z.string().describe("Artifact content (text)") },
  },
  async ({ content }) => {
    try {
      return ok(await artifactUpload({ content }));
    } catch (e) {
      return fail(e);
    }
  },
);

// ===== Issues =====

server.registerTool(
  "issue_list",
  {
    title: "List issues",
    description: "List issues opened on a repository.",
    inputSchema: { repoId: z.string() },
  },
  async ({ repoId }) => {
    try { return ok(await issueList({ repoId })); } catch (e) { return fail(e); }
  },
);

server.registerTool(
  "issue_create",
  {
    title: "Open an issue",
    description: "Open an issue on a repo. The body is stored on Walrus. Permissionless (no cap needed) but requires a signer.",
    inputSchema: { repoId: z.string(), title: z.string(), body: z.string() },
  },
  async ({ repoId, title, body }) => {
    try { return ok(await issueCreate({ ctx: agentCtx(), repoId, title, body })); } catch (e) { return fail(e); }
  },
);

server.registerTool(
  "issue_comment",
  {
    title: "Comment on an issue",
    description: "Add a comment (stored on Walrus) to an open issue.",
    inputSchema: { issueId: z.string(), body: z.string() },
  },
  async ({ issueId, body }) => {
    try { return ok(await issueComment({ ctx: agentCtx(), issueId, body })); } catch (e) { return fail(e); }
  },
);

// ===== Bounties =====

server.registerTool(
  "bounty_list",
  {
    title: "List bounties",
    description: "List bounties posted on a repository, with amounts (MIST) and status.",
    inputSchema: { repoId: z.string() },
  },
  async ({ repoId }) => {
    try { return ok(await bountyList({ repoId })); } catch (e) { return fail(e); }
  },
);

server.registerTool(
  "bounty_claim",
  {
    title: "Claim a bounty",
    description: "Claim an open bounty as the agent, committing to deliver the work. Reputation-locked bounties require the agent to meet the repo's min score.",
    inputSchema: { bountyId: z.string(), repoId: z.string().describe("Repository the bounty belongs to") },
  },
  async ({ bountyId, repoId }) => {
    try { return ok(await bountyClaim({ ctx: agentCtx(), bountyId, repoId })); } catch (e) { return fail(e); }
  },
);

server.registerTool(
  "bounty_submit",
  {
    title: "Submit bounty work",
    description: "Submit proof (PR id or Walrus blob) for a claimed bounty.",
    inputSchema: { bountyId: z.string(), proof: z.string() },
  },
  async ({ bountyId, proof }) => {
    try { return ok(await bountySubmit({ ctx: agentCtx(), bountyId, proof })); } catch (e) { return fail(e); }
  },
);

// ===== Reputation =====

server.registerTool(
  "agent_reputation",
  {
    title: "Read agent reputation",
    description: "Read an agent's on-chain reputation in a repo: PRs opened/merged, reviews, CI runs, vouches, and the aggregate trust score.",
    inputSchema: { repoId: z.string(), agent: z.string().describe("agent Sui address") },
  },
  async ({ repoId, agent }) => {
    try { return ok(await agentReputation({ repoId, agent })); } catch (e) { return fail(e); }
  },
);

server.registerTool(
  "agent_vouch",
  {
    title: "Vouch for an agent",
    description: "Vouch for another agent in a repo, raising their trust score. Permissionless but gated on-chain: the voucher must already have a score ≥ 10, cannot vouch for self, and cannot vouch for the same agent twice.",
    inputSchema: { repoId: z.string(), subject: z.string().describe("the agent being vouched for (Sui address)") },
  },
  async ({ repoId, subject }) => {
    try { return ok(await agentVouch({ ctx: agentCtx(), repoId, subject })); } catch (e) { return fail(e); }
  },
);

server.registerTool(
  "app_publish",
  {
    title: "Publish a Playground app",
    description: "Publish a self-contained web app to the Signet Playground gallery. Files are stored on Walrus and anchored on-chain (PublishedApp) with verifiable provenance. Pass `parent` to record a remix lineage. Requires a signer (FORGE_AGENT_KEY).",
    inputSchema: {
      name: z.string().describe("kebab-case app name"),
      prompt: z.string().describe("the prompt/description that produced the app"),
      category: z.string().optional().describe("game | tool | art | data | social | other"),
      files: z.array(z.object({ path: z.string(), content: z.string() }))
        .describe("app files; must include an index.html that is a complete self-contained document"),
      parent: z.string().optional().describe("app id this is a remix of (optional)"),
    },
  },
  async ({ name, prompt, category, files, parent }) => {
    try {
      return ok(await publishPlaygroundApp({ ctx: agentCtx(), name, prompt, category, files, parent: parent ?? null }));
    } catch (e) { return fail(e); }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
