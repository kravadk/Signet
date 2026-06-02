/**
 * Signet indexer + REST API.
 *
 * Polls the deployed package's Move events from Sui testnet, materialises them
 * into a local SQLite database, and serves a small REST API the web UI (and any
 * client) can read quickly — instead of every page doing live RPC event scans.
 *
 * This is the off-chain read backbone: the chain stays the source of truth, the
 * indexer is a rebuildable cache + queryable surface (repos, PRs, issues,
 * bounties, releases, reputation, and a unified activity feed).
 */

import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import { DatabaseSync } from "node:sqlite";
import express from "express";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const NET: "testnet" | "mainnet" = process.env.SUI_NETWORK === "mainnet" ? "mainnet" : "testnet";
const deployment = JSON.parse(
  readFileSync(join(__dirname, "..", "..", "move", "signet", "deployments.json"), "utf8"),
)[NET];
const PACKAGE: string = deployment.packageId;

const client = new SuiClient({ url: getFullnodeUrl(NET) });
let ready = false; // becomes true after the first successful poll
const db = new DatabaseSync(join(__dirname, "..", "forge.db"));
db.exec("PRAGMA journal_mode = WAL;");

// ===== Schema =====

db.exec(`
CREATE TABLE IF NOT EXISTS repos (
  id TEXT PRIMARY KEY, name TEXT, owner TEXT, branch TEXT,
  snapshot TEXT, ref_version INTEGER DEFAULT 0, latest_release TEXT
);
CREATE TABLE IF NOT EXISTS prs (
  id TEXT PRIMARY KEY, repo_id TEXT, author TEXT, title TEXT,
  base TEXT, head TEXT, status INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS issues (
  id TEXT PRIMARY KEY, repo_id TEXT, author TEXT, title TEXT, status INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS bounties (
  id TEXT PRIMARY KEY, repo_id TEXT, funder TEXT, title TEXT,
  amount INTEGER, status INTEGER DEFAULT 0, claimant TEXT
);
CREATE TABLE IF NOT EXISTS releases (
  id TEXT PRIMARY KEY, repo_id TEXT, version TEXT,
  source TEXT, artifact TEXT, report TEXT, published_by TEXT
);
CREATE TABLE IF NOT EXISTS reputation (
  repo_id TEXT, agent TEXT, prs_opened INTEGER, prs_merged INTEGER,
  reviews INTEGER, ci_runs INTEGER, PRIMARY KEY (repo_id, agent)
);
CREATE TABLE IF NOT EXISTS activity (
  tx TEXT, seq TEXT, type TEXT, repo_id TEXT, json TEXT,
  PRIMARY KEY (tx, seq)
);
`);

// ===== Upserts =====

const up = {
  repo: db.prepare(
    `INSERT INTO repos (id,name,owner,branch,snapshot,ref_version,latest_release)
     VALUES (@id,@name,@owner,@branch,@snapshot,@ref_version,@latest_release)
     ON CONFLICT(id) DO UPDATE SET snapshot=@snapshot, ref_version=@ref_version, latest_release=@latest_release`,
  ),
  pr: db.prepare(
    `INSERT INTO prs (id,repo_id,author,title,base,head,status)
     VALUES (@id,@repo_id,@author,@title,@base,@head,@status)
     ON CONFLICT(id) DO UPDATE SET status=@status`,
  ),
  issue: db.prepare(
    `INSERT INTO issues (id,repo_id,author,title,status) VALUES (@id,@repo_id,@author,@title,@status)
     ON CONFLICT(id) DO UPDATE SET status=@status`,
  ),
  bounty: db.prepare(
    `INSERT INTO bounties (id,repo_id,funder,title,amount,status,claimant)
     VALUES (@id,@repo_id,@funder,@title,@amount,@status,@claimant)
     ON CONFLICT(id) DO UPDATE SET status=@status, claimant=@claimant`,
  ),
  release: db.prepare(
    `INSERT OR REPLACE INTO releases (id,repo_id,version,source,artifact,report,published_by)
     VALUES (@id,@repo_id,@version,@source,@artifact,@report,@published_by)`,
  ),
  reputation: db.prepare(
    `INSERT OR REPLACE INTO reputation (repo_id,agent,prs_opened,prs_merged,reviews,ci_runs)
     VALUES (@repo_id,@agent,@prs_opened,@prs_merged,@reviews,@ci_runs)`,
  ),
  activity: db.prepare(
    `INSERT OR IGNORE INTO activity (tx,seq,type,repo_id,json) VALUES (@tx,@seq,@type,@repo_id,@json)`,
  ),
  setRepoStatus: db.prepare(`UPDATE repos SET snapshot=@snapshot, ref_version=@ref_version WHERE id=@id`),
  setLatestRelease: db.prepare(`UPDATE repos SET latest_release=@rel WHERE id=@id`),
};

// ===== Event handling =====

function applyEvent(type: string, p: any, tx: string, seq: string) {
  const short = type.split("::").slice(-1)[0];
  const repoId = p?.repo_id ?? "";
  switch (short) {
    case "RepoCreated":
      up.repo.run({
        id: p.repo_id, name: p.name, owner: p.owner, branch: "main",
        snapshot: p.snapshot, ref_version: 0, latest_release: null,
      });
      break;
    case "RefUpdated":
      up.setRepoStatus.run({ id: p.repo_id, snapshot: p.new_snapshot, ref_version: Number(p.ref_version) });
      break;
    case "PrOpened":
      up.pr.run({
        id: p.pr_id, repo_id: p.repo_id, author: p.author, title: "",
        base: p.base_snapshot, head: p.head_snapshot, status: 0,
      });
      break;
    case "PrMerged":
      db.prepare(`UPDATE prs SET status=1 WHERE id=?`).run(p.pr_id);
      break;
    case "PrClosed":
      db.prepare(`UPDATE prs SET status=2 WHERE id=?`).run(p.pr_id);
      break;
    case "IssueOpened":
      up.issue.run({ id: p.issue_id, repo_id: p.repo_id, author: p.author, title: p.title, status: 0 });
      break;
    case "IssueClosed":
      db.prepare(`UPDATE issues SET status=1 WHERE id=?`).run(p.issue_id);
      break;
    case "BountyPosted":
      up.bounty.run({
        id: p.bounty_id, repo_id: p.repo_id, funder: p.funder, title: p.title,
        amount: Number(p.amount), status: 0, claimant: null,
      });
      break;
    case "BountyClaimed":
      db.prepare(`UPDATE bounties SET status=1, claimant=? WHERE id=?`).run(p.claimant, p.bounty_id);
      break;
    case "BountyPaid":
      db.prepare(`UPDATE bounties SET status=2 WHERE id=?`).run(p.bounty_id);
      break;
    case "BountyCancelled":
      db.prepare(`UPDATE bounties SET status=3 WHERE id=?`).run(p.bounty_id);
      break;
    case "ReleasePublished":
      up.release.run({
        id: p.release_id, repo_id: p.repo_id, version: p.version, source: p.source_snapshot,
        artifact: p.build_artifact, report: p.test_report, published_by: p.published_by,
      });
      up.setLatestRelease.run({ id: p.repo_id, rel: p.release_id });
      break;
    case "ReputationUpdated":
      up.reputation.run({
        repo_id: p.repo_id, agent: p.agent, prs_opened: Number(p.prs_opened),
        prs_merged: Number(p.prs_merged), reviews: Number(p.reviews), ci_runs: Number(p.ci_runs),
      });
      break;
  }
  up.activity.run({ tx, seq, type: short, repo_id: repoId, json: JSON.stringify(p) });
}

// ===== Poller =====

const MODULES = ["forge", "pull_request", "issue", "bounty", "release", "reputation"];

async function pollOnce() {
  for (const mod of MODULES) {
    try {
      const res = await client.queryEvents({
        query: { MoveModule: { package: PACKAGE, module: mod } },
        limit: 200,
        order: "ascending",
      });
      db.exec("BEGIN");
      try {
        for (const e of res.data) {
          applyEvent(e.type, e.parsedJson, e.id.txDigest, String(e.id.eventSeq));
        }
        db.exec("COMMIT");
      } catch (txErr) {
        db.exec("ROLLBACK");
        throw txErr;
      }
    } catch (err: any) {
      console.error(`poll ${mod} failed:`, err.message ?? err);
    }
  }
}

// ===== REST API =====

const app = express();
// This API is a REBUILDABLE CACHE, never the source of truth. Every row carries its
// on-chain object id (`id`) plus Walrus blob ids (snapshot / source / artifact / report),
// so any client can re-verify each value against Sui RPC + Walrus and never has to trust
// the indexer. The header advertises that contract on every response.
app.use((_req, res, next) => {
  res.setHeader("X-Signet-Source", "indexer-cache; reverify against Sui RPC + Walrus");
  next();
});
app.get("/api/health", (_req, res) =>
  res.status(ready ? 200 : 503).json({
    ok: ready, package: PACKAGE, network: NET,
    source: "indexer-cache",
    reverify: "rebuildable cache — verify object ids on Sui RPC + blob ids on Walrus (chain is source of truth)",
  }));
app.get("/api/repos", (_req, res) => res.json(db.prepare(`SELECT * FROM repos`).all()));
app.get("/api/repos/:id", (req, res) => {
  const repo = db.prepare(`SELECT * FROM repos WHERE id=?`).get(req.params.id);
  if (!repo) return res.status(404).json({ error: "not found" });
  res.json(repo);
});
app.get("/api/repos/:id/prs", (req, res) =>
  res.json(db.prepare(`SELECT * FROM prs WHERE repo_id=?`).all(req.params.id)),
);
app.get("/api/repos/:id/issues", (req, res) =>
  res.json(db.prepare(`SELECT * FROM issues WHERE repo_id=?`).all(req.params.id)),
);
app.get("/api/repos/:id/bounties", (req, res) =>
  res.json(db.prepare(`SELECT * FROM bounties WHERE repo_id=?`).all(req.params.id)),
);
app.get("/api/repos/:id/releases", (req, res) =>
  res.json(db.prepare(`SELECT * FROM releases WHERE repo_id=?`).all(req.params.id)),
);
app.get("/api/repos/:id/reputation", (req, res) =>
  res.json(db.prepare(`SELECT * FROM reputation WHERE repo_id=? ORDER BY prs_merged DESC`).all(req.params.id)),
);
app.get("/api/repos/:id/activity", (req, res) =>
  res.json(db.prepare(`SELECT * FROM activity WHERE repo_id=? ORDER BY rowid DESC LIMIT 100`).all(req.params.id)),
);
app.get("/api/releases/:id", (req, res) => {
  const r = db.prepare(`SELECT * FROM releases WHERE id=?`).get(req.params.id);
  if (!r) return res.status(404).json({ error: "not found" });
  res.json(r);
});
app.get("/api/activity", (_req, res) =>
  res.json(db.prepare(`SELECT * FROM activity ORDER BY rowid DESC LIMIT 100`).all()),
);

const PORT = Number(process.env.PORT ?? 4318);

async function main() {
  console.log(JSON.stringify({ level: "info", msg: "indexer starting", network: NET, package: PACKAGE }));
  await pollOnce();
  ready = true; // /api/health flips to 200 only after the first poll completes
  console.log(JSON.stringify({ level: "info", msg: "initial index complete" }));
  const timer = setInterval(() => void pollOnce(), 10_000);
  const server = app.listen(PORT, () => console.log(JSON.stringify({ level: "info", msg: "indexer API up", port: PORT })));
  const stop = (sig: string) => {
    console.log(JSON.stringify({ level: "info", msg: "shutdown", sig }));
    clearInterval(timer);
    server.close(() => { try { db.close(); } catch {} process.exit(0); });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
}

main().catch((e) => {
  console.error(JSON.stringify({ level: "error", msg: "fatal", error: String(e?.message ?? e) }));
  process.exit(1);
});
