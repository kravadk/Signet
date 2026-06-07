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
import { createHmac, randomUUID } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const NET: "testnet" | "mainnet" = process.env.SUI_NETWORK === "mainnet" ? "mainnet" : "testnet";
const deployment = JSON.parse(
  readFileSync(join(__dirname, "..", "..", "move", "signet", "deployments.json"), "utf8"),
)[NET];
const PACKAGE: string = deployment.packageId;
const WRITE_PACKAGE: string = deployment.latestPackageId ?? PACKAGE;
const PLAYGROUND_PACKAGE: string = deployment.playgroundPackageId ?? PACKAGE;
const PLAYGROUND_EVENT_PKGS: string[] = deployment.playgroundEventPkgs?.length
  ? deployment.playgroundEventPkgs
  : [deployment.playgroundEventPkg ?? PLAYGROUND_PACKAGE];

const client = new SuiClient({ url: getFullnodeUrl(NET) });
let ready = false; // becomes true after the first successful poll
let lastPollOkAt = 0;
let lastPollError = "";
let pollCount = 0;
let pollErrorCount = 0;
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
CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY, pr_id TEXT, repo_id TEXT, reviewer TEXT,
  verdict INTEGER, report_blob TEXT
);
CREATE TABLE IF NOT EXISTS issues (
  id TEXT PRIMARY KEY, repo_id TEXT, author TEXT, title TEXT, status INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS bounties (
  id TEXT PRIMARY KEY, repo_id TEXT, funder TEXT, title TEXT,
  amount INTEGER, status INTEGER DEFAULT 0, claimant TEXT,
  min_score INTEGER DEFAULT 0, proof TEXT, paid INTEGER DEFAULT 0, fee INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS releases (
  id TEXT PRIMARY KEY, repo_id TEXT, version TEXT,
  source TEXT, artifact TEXT, report TEXT, published_by TEXT
);
CREATE TABLE IF NOT EXISTS release_links (
  release_id TEXT PRIMARY KEY, repo_id TEXT, merged_pr_id TEXT, link_id TEXT
);
CREATE TABLE IF NOT EXISTS reputation (
  repo_id TEXT, agent TEXT, prs_opened INTEGER, prs_merged INTEGER,
  reviews INTEGER, ci_runs INTEGER, PRIMARY KEY (repo_id, agent)
);
CREATE TABLE IF NOT EXISTS activity (
  tx TEXT, seq TEXT, type TEXT, repo_id TEXT, json TEXT,
  PRIMARY KEY (tx, seq)
);
CREATE TABLE IF NOT EXISTS apps (
  id TEXT PRIMARY KEY, builder TEXT, name TEXT, parent TEXT,
  manifest_blob TEXT, archive_blob TEXT, tree_hash TEXT,
  created_at INTEGER DEFAULT 0, visits INTEGER DEFAULT 0,
  stars INTEGER DEFAULT 0, tips INTEGER DEFAULT 0,
  private INTEGER DEFAULT 0, hidden INTEGER DEFAULT 0, flags INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS app_bounties (
  id TEXT PRIMARY KEY, poster TEXT, reward INTEGER, status INTEGER DEFAULT 0,
  fulfilled_app TEXT, winner TEXT, paid INTEGER DEFAULT 0, fee INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS payment_requests (
  id TEXT PRIMARY KEY, creator TEXT, recipient TEXT, label TEXT,
  amount INTEGER, status INTEGER DEFAULT 0, payer TEXT,
  created_at INTEGER DEFAULT 0, expires_at INTEGER
);
CREATE TABLE IF NOT EXISTS cursors (
  module TEXT PRIMARY KEY,
  tx TEXT NOT NULL,
  seq TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS webhook_subscriptions (
  id TEXT PRIMARY KEY, event_type TEXT NOT NULL, target_url TEXT NOT NULL,
  secret TEXT, active INTEGER DEFAULT 1, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id TEXT PRIMARY KEY, subscription_id TEXT NOT NULL, event_type TEXT NOT NULL,
  object_id TEXT, tx TEXT, seq TEXT, status INTEGER, error TEXT, delivered_at INTEGER NOT NULL
);
`);

function addColumn(table: string, definition: string) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`); } catch {}
}
addColumn("bounties", "min_score INTEGER DEFAULT 0");
addColumn("bounties", "proof TEXT");
addColumn("bounties", "paid INTEGER DEFAULT 0");
addColumn("bounties", "fee INTEGER DEFAULT 0");
addColumn("prs", "approvals INTEGER DEFAULT 0");

// ===== Upserts =====

const up = {
  repo: db.prepare(
    `INSERT INTO repos (id,name,owner,branch,snapshot,ref_version,latest_release)
     VALUES (@id,@name,@owner,@branch,@snapshot,@ref_version,@latest_release)
     ON CONFLICT(id) DO UPDATE SET snapshot=@snapshot, ref_version=@ref_version, latest_release=@latest_release`,
  ),
  pr: db.prepare(
    `INSERT INTO prs (id,repo_id,author,title,base,head,status,approvals)
     VALUES (@id,@repo_id,@author,@title,@base,@head,@status,@approvals)
     ON CONFLICT(id) DO UPDATE SET status=@status, approvals=@approvals`,
  ),
  review: db.prepare(
    `INSERT OR REPLACE INTO reviews (id,pr_id,repo_id,reviewer,verdict,report_blob)
     VALUES (@id,@pr_id,@repo_id,@reviewer,@verdict,@report_blob)`,
  ),
  issue: db.prepare(
    `INSERT INTO issues (id,repo_id,author,title,status) VALUES (@id,@repo_id,@author,@title,@status)
     ON CONFLICT(id) DO UPDATE SET status=@status`,
  ),
  bounty: db.prepare(
    `INSERT INTO bounties (id,repo_id,funder,title,amount,status,claimant,min_score,proof,paid,fee)
     VALUES (@id,@repo_id,@funder,@title,@amount,@status,@claimant,@min_score,@proof,@paid,@fee)
     ON CONFLICT(id) DO UPDATE SET status=@status, claimant=@claimant, min_score=@min_score`,
  ),
  release: db.prepare(
    `INSERT OR REPLACE INTO releases (id,repo_id,version,source,artifact,report,published_by)
     VALUES (@id,@repo_id,@version,@source,@artifact,@report,@published_by)`,
  ),
  releaseLink: db.prepare(
    `INSERT OR REPLACE INTO release_links (release_id,repo_id,merged_pr_id,link_id)
     VALUES (@release_id,@repo_id,@merged_pr_id,@link_id)`,
  ),
  reputation: db.prepare(
    `INSERT OR REPLACE INTO reputation (repo_id,agent,prs_opened,prs_merged,reviews,ci_runs)
     VALUES (@repo_id,@agent,@prs_opened,@prs_merged,@reviews,@ci_runs)`,
  ),
  activity: db.prepare(
    `INSERT OR IGNORE INTO activity (tx,seq,type,repo_id,json) VALUES (@tx,@seq,@type,@repo_id,@json)`,
  ),
  app: db.prepare(
    `INSERT INTO apps (id,builder,name,parent,manifest_blob,created_at)
     VALUES (@id,@builder,@name,@parent,@manifest_blob,@created_at)
     ON CONFLICT(id) DO UPDATE SET name=@name, manifest_blob=@manifest_blob`,
  ),
  appBounty: db.prepare(
    `INSERT INTO app_bounties (id,poster,reward,status,created_at)
     VALUES (@id,@poster,@reward,@status,@created_at)
     ON CONFLICT(id) DO UPDATE SET status=@status`,
  ),
  paymentRequest: db.prepare(
    `INSERT INTO payment_requests (id,creator,recipient,label,amount,status,payer,created_at,expires_at)
     VALUES (@id,@creator,@recipient,@label,@amount,@status,@payer,@created_at,@expires_at)
     ON CONFLICT(id) DO UPDATE SET status=@status, payer=@payer`,
  ),
  webhookSub: db.prepare(
    `INSERT INTO webhook_subscriptions (id,event_type,target_url,secret,active,created_at)
     VALUES (@id,@event_type,@target_url,@secret,1,@created_at)`,
  ),
  webhookDelivery: db.prepare(
    `INSERT INTO webhook_deliveries (id,subscription_id,event_type,object_id,tx,seq,status,error,delivered_at)
     VALUES (@id,@subscription_id,@event_type,@object_id,@tx,@seq,@status,@error,@delivered_at)`,
  ),
  cursor: db.prepare(
    `INSERT INTO cursors (module,tx,seq,updated_at)
     VALUES (@module,@tx,@seq,@updated_at)
     ON CONFLICT(module) DO UPDATE SET tx=@tx, seq=@seq, updated_at=@updated_at`,
  ),
  setRepoStatus: db.prepare(`UPDATE repos SET snapshot=@snapshot, ref_version=@ref_version WHERE id=@id`),
  setLatestRelease: db.prepare(`UPDATE repos SET latest_release=@rel WHERE id=@id`),
};

// ===== Event handling =====

type WebhookJob = { eventType: string; payload: any };
const webhookQueue: WebhookJob[] = [];
const startedAt = Date.now();
const requestMetrics = new Map<string, { count: number; totalMs: number; errors: number }>();

function log(level: "info" | "warn" | "error", msg: string, extra: Record<string, any> = {}) {
  console[level === "error" ? "error" : "log"](JSON.stringify({ level, msg, ts: new Date().toISOString(), ...extra }));
}

const ERROR_DSN = process.env.ERROR_TRACKING_DSN || "";
async function trackError(error: unknown, context: Record<string, any> = {}) {
  const payload = { error: String((error as any)?.message ?? error), context, ts: new Date().toISOString() };
  if (!ERROR_DSN) { log("error", "tracked error", payload); return; }
  try {
    await fetch(ERROR_DSN, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  } catch (e: any) {
    log("warn", "error tracking delivery failed", { error: String(e?.message ?? e) });
  }
}

function eventName(short: string): string | null {
  switch (short) {
    case "ReleasePublished": return "release.published";
    case "BountyClaimed": return "bounty.claimed";
    case "BountyPaid": return "bounty.paid";
    case "AppPublished": return "app.published";
    case "ReviewSubmitted": return "agent.reviewed";
    case "PaymentPaid": return "payment.paid";
    default: return null;
  }
}

function eventObjectId(short: string, p: any): string {
  return p.release_id ?? p.bounty_id ?? p.request_id ?? p.app_id ?? p.review_id ?? p.pr_id ?? p.repo_id ?? "";
}

function eventBlobIds(short: string, p: any): string[] {
  const ids = [
    p.source_snapshot,
    p.build_artifact,
    p.test_report,
    p.manifest_blob,
    p.report_blob,
    p.proof && String(p.proof).startsWith("0x") ? p.proof : null,
  ].filter(Boolean);
  return [...new Set(ids.map(String))];
}

function optionId(v: any): string | null {
  if (!v) return null;
  if (typeof v === "string") return v;
  const x = v?.vec?.[0] ?? v?.fields?.vec?.[0] ?? v?.Some ?? null;
  return x ? String(x) : null;
}

function reverifyAnchor(kind: string, row: any = {}) {
  return {
    network: NET,
    packageId: kind === "app" ? PLAYGROUND_PACKAGE : kind === "payment" ? WRITE_PACKAGE : PACKAGE,
    objectId: row.id ?? row.objectId ?? row.release_id ?? row.bounty_id ?? row.request_id ?? row.app_id ?? row.review_id ?? null,
    txDigest: row.txDigest ?? row.tx ?? null,
    eventSeq: row.eventSeq ?? row.seq ?? null,
    blobIds: [
      row.snapshot,
      row.source,
      row.artifact,
      row.report,
      row.manifest_blob,
      row.manifestBlob,
      row.archive_blob,
      row.archiveBlob,
      row.report_blob,
      row.reportBlob,
      row.proof && String(row.proof).startsWith("0x") ? row.proof : null,
    ].filter(Boolean),
    treeHashes: [row.tree_hash, row.treeHash].filter(Boolean),
    note: "Gateway data is an indexer cache; re-check object ids on Sui RPC and blob/tree hashes on Walrus.",
  };
}

function enqueueWebhook(short: string, p: any, tx: string, seq: string) {
  const eventType = eventName(short);
  if (!eventType) return;
  const objectId = eventObjectId(short, p);
  webhookQueue.push({
    eventType,
    payload: {
      event: eventType,
      network: NET,
      packageId: short === "AppPublished" ? PLAYGROUND_PACKAGE : short.startsWith("Payment") ? WRITE_PACKAGE : PACKAGE,
      objectId,
      txDigest: tx,
      eventSeq: seq,
      walrus: { blobIds: eventBlobIds(short, p), treeHashes: [p.tree_hash].filter(Boolean) },
      data: p,
      reverify: reverifyAnchor(short === "AppPublished" ? "app" : "event", {
        objectId, txDigest: tx, eventSeq: seq, ...p,
      }),
    },
  });
}

function applyEvent(type: string, p: any, tx: string, seq: string) {
  const short = type.split("::").slice(-1)[0];
  let repoId = p?.repo_id ?? "";
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
        base: p.base_snapshot, head: p.head_snapshot, status: 0, approvals: 0,
      });
      break;
    case "ReviewSubmitted": {
      const pr = db.prepare(`SELECT repo_id FROM prs WHERE id=?`).get(p.pr_id) as { repo_id: string } | undefined;
      repoId = pr?.repo_id ?? "";
      up.review.run({
        id: p.review_id, pr_id: p.pr_id, repo_id: repoId, reviewer: p.reviewer,
        verdict: Number(p.verdict), report_blob: p.report_blob,
      });
      if (Number(p.verdict) === 1) db.prepare(`UPDATE prs SET approvals=COALESCE(approvals,0)+1 WHERE id=?`).run(p.pr_id);
      break;
    }
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
        min_score: Number(p.min_score ?? 0), proof: null, paid: 0, fee: 0,
      });
      break;
    case "BountyClaimed":
      db.prepare(`UPDATE bounties SET status=1, claimant=? WHERE id=?`).run(p.claimant, p.bounty_id);
      break;
    case "BountySubmitted":
      db.prepare(`UPDATE bounties SET proof=? WHERE id=?`).run(p.proof, p.bounty_id);
      break;
    case "BountyPaid":
      db.prepare(`UPDATE bounties SET status=2, claimant=COALESCE(claimant,?), paid=?, fee=? WHERE id=?`)
        .run(p.claimant, Number(p.paid ?? 0), Number(p.fee ?? 0), p.bounty_id);
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
    case "ReleaseLinked":
      up.releaseLink.run({
        release_id: p.release_id, repo_id: p.repo_id, merged_pr_id: p.merged_pr_id, link_id: p.link_id,
      });
      break;
    case "ReputationUpdated":
      up.reputation.run({
        repo_id: p.repo_id, agent: p.agent, prs_opened: Number(p.prs_opened),
        prs_merged: Number(p.prs_merged), reviews: Number(p.reviews), ci_runs: Number(p.ci_runs),
      });
      break;
    case "AppPublished":
      up.app.run({
        id: p.app_id, builder: p.builder, name: p.name, parent: optionId(p.parent),
        manifest_blob: p.manifest_blob, created_at: Number(p.created_at_ms ?? 0),
      });
      break;
    case "AppVisited":
      db.prepare(`UPDATE apps SET visits=? WHERE id=?`).run(Number(p.visits ?? 0), p.app_id);
      break;
    case "AppStarred":
      db.prepare(`UPDATE apps SET stars=? WHERE id=?`).run(Number(p.stars ?? 0), p.app_id);
      break;
    case "AppTipped":
      db.prepare(`UPDATE apps SET tips=COALESCE(tips,0)+? WHERE id=?`).run(Number(p.amount ?? 0), p.app_id);
      break;
    case "AppFlagged":
      db.prepare(`UPDATE apps SET flags=? WHERE id=?`).run(Number(p.flags ?? 0), p.app_id);
      break;
    case "AppHidden":
      db.prepare(`UPDATE apps SET hidden=? WHERE id=?`).run(p.hidden ? 1 : 0, p.app_id);
      break;
    case "AppUpdated":
      db.prepare(`UPDATE apps SET tree_hash=? WHERE id=?`).run(p.tree_hash, p.app_id);
      break;
    case "AppPrivacySet":
      db.prepare(`UPDATE apps SET private=? WHERE id=?`).run(p.private ? 1 : 0, p.app_id);
      break;
    case "AppBountyPosted":
      up.appBounty.run({
        id: p.bounty_id, poster: p.poster, reward: Number(p.reward ?? 0),
        status: 0, created_at: Number(p.created_at_ms ?? 0),
      });
      break;
    case "AppBountyAwarded":
      db.prepare(`UPDATE app_bounties SET status=2, fulfilled_app=?, winner=?, paid=?, fee=? WHERE id=?`)
        .run(p.app_id, p.winner, Number(p.amount ?? 0), Number(p.fee ?? 0), p.bounty_id);
      break;
    case "AppBountyCancelled":
      db.prepare(`UPDATE app_bounties SET status=3 WHERE id=?`).run(p.bounty_id);
      break;
    case "PaymentRequested":
      up.paymentRequest.run({
        id: p.request_id, creator: p.creator, recipient: p.recipient, label: p.label,
        amount: Number(p.amount ?? 0), status: 0, payer: null,
        created_at: Number(p.created_at_ms ?? 0), expires_at: optionId(p.expires_at_ms),
      });
      break;
    case "PaymentPaid":
      db.prepare(`UPDATE payment_requests SET status=1, payer=? WHERE id=?`).run(p.payer, p.request_id);
      break;
    case "PaymentCancelled":
      db.prepare(`UPDATE payment_requests SET status=2 WHERE id=?`).run(p.request_id);
      break;
  }
  const info = up.activity.run({ tx, seq, type: short, repo_id: repoId, json: JSON.stringify(p) }) as any;
  if ((info?.changes ?? 0) > 0) enqueueWebhook(short, p, tx, seq);
}

// ===== Poller =====

const MODULES = ["forge", "pull_request", "issue", "bounty", "release", "reputation"];
const EVENT_SOURCES = [
  ...MODULES.map((module) => ({ key: module, packageId: PACKAGE, module })),
  { key: "payment", packageId: WRITE_PACKAGE, module: "payment" },
  ...PLAYGROUND_EVENT_PKGS.map((packageId) => ({ key: `playground:${packageId}`, packageId, module: "playground" })),
];

async function pollOnce() {
  let ok = true;
  for (const src of EVENT_SOURCES) {
    try {
      const saved = db.prepare(`SELECT tx, seq FROM cursors WHERE module=?`).get(src.key) as { tx: string; seq: string } | undefined;
      let cursor: any = saved ? { txDigest: saved.tx, eventSeq: saved.seq } : null;

      do {
        const res = await client.queryEvents({
          query: { MoveModule: { package: src.packageId, module: src.module } },
          cursor,
          limit: 200,
          order: "ascending",
        });
        if (!res.data.length) break;

        let last = res.data[res.data.length - 1].id;
        db.exec("BEGIN");
        try {
          for (const e of res.data) {
            applyEvent(e.type, e.parsedJson, e.id.txDigest, String(e.id.eventSeq));
          }
          up.cursor.run({
            module: src.key,
            tx: last.txDigest,
            seq: String(last.eventSeq),
            updated_at: Date.now(),
          });
          db.exec("COMMIT");
        } catch (txErr) {
          db.exec("ROLLBACK");
          throw txErr;
        }
        cursor = res.nextCursor;
        if (!res.hasNextPage) break;
      } while (cursor);
    } catch (err: any) {
      ok = false;
      lastPollError = String(err?.message ?? err);
      pollErrorCount += 1;
      await trackError(err, { component: "indexer", source: src.key });
    }
  }
  await flushWebhookQueue();
  pollCount += 1;
  if (ok) { lastPollOkAt = Date.now(); lastPollError = ""; }
}

async function flushWebhookQueue() {
  while (webhookQueue.length) {
    const job = webhookQueue.shift()!;
    const subs = db.prepare(
      `SELECT * FROM webhook_subscriptions WHERE active=1 AND (event_type=? OR event_type='*')`,
    ).all(job.eventType) as any[];
    if (!subs.length) continue;
    const body = JSON.stringify(job.payload);
    await Promise.all(subs.map(async (sub) => {
      let status = 0; let error = "";
      try {
        const headers: Record<string, string> = {
          "content-type": "application/json",
          "x-signet-event": job.eventType,
          "x-signet-network": NET,
        };
        if (sub.secret) {
          headers["x-signet-signature"] = "sha256=" + createHmac("sha256", sub.secret).update(body).digest("hex");
        }
        const res = await fetch(sub.target_url, { method: "POST", headers, body });
        status = res.status;
        if (!res.ok) error = `HTTP ${res.status}`;
      } catch (e: any) {
        error = String(e?.message ?? e);
      }
      up.webhookDelivery.run({
        id: randomUUID(), subscription_id: sub.id, event_type: job.eventType,
        object_id: job.payload.objectId, tx: job.payload.txDigest, seq: job.payload.eventSeq,
        status, error, delivered_at: Date.now(),
      });
    }));
  }
}

// ===== REST API =====

const app = express();
app.disable("x-powered-by");

const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000);
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX ?? 600);
const rateHits = new Map<string, { count: number; resetAt: number }>();

function clientIp(req: express.Request) {
  return String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() || req.socket.remoteAddress || "unknown";
}

app.use((req, res, next) => {
  const start = Date.now();
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  if (process.env.CSP_REPORT_ONLY !== "0") {
    res.setHeader(
      "Content-Security-Policy-Report-Only",
      "default-src 'none'; connect-src 'self' https:; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' https://esm.sh; frame-ancestors 'none'; base-uri 'self'; report-uri /csp-report",
    );
  }
  res.on("finish", () => {
    const route = req.route?.path ? String(req.route.path) : req.path;
    const key = `${req.method} ${route}`;
    const m = requestMetrics.get(key) ?? { count: 0, totalMs: 0, errors: 0 };
    m.count += 1;
    m.totalMs += Date.now() - start;
    if (res.statusCode >= 500) m.errors += 1;
    requestMetrics.set(key, m);
    log(res.statusCode >= 500 ? "error" : "info", "http request", {
      method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - start,
    });
  });
  next();
});

// Optional distributed backend (Upstash Redis REST) so the limit holds across instances.
// Unset → in-memory. Fail-open: any error → null → fall back to the local map.
const RL_REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.RATE_LIMIT_REDIS_URL || "";
const RL_REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.RATE_LIMIT_REDIS_TOKEN || "";
async function rlRedisOver(ip: string, max: number, windowSec: number): Promise<boolean | null> {
  if (!RL_REDIS_URL || !RL_REDIS_TOKEN) return null;
  try {
    const key = `gw:${ip}`;
    const r = await fetch(`${RL_REDIS_URL}/pipeline`, {
      method: "POST",
      headers: { authorization: `Bearer ${RL_REDIS_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify([["INCR", key], ["EXPIRE", key, String(windowSec), "NX"]]),
      signal: AbortSignal.timeout(1500),
    });
    if (!r.ok) return null;
    const out: any = await r.json();
    const n = Number(Array.isArray(out) ? out[0]?.result : out?.result);
    return Number.isFinite(n) ? n > max : null;
  } catch { return null; }
}

app.use(async (req, res, next) => {
  if (RATE_LIMIT_MAX <= 0 || req.path === "/metrics" || req.path === "/health" || req.path === "/api/health") return next();
  const ip = clientIp(req);
  const windowSec = Math.max(1, Math.ceil(RATE_LIMIT_WINDOW_MS / 1000));
  const overRedis = await rlRedisOver(ip, RATE_LIMIT_MAX, windowSec);
  if (overRedis !== null) {
    if (overRedis) { res.setHeader("Retry-After", String(windowSec)); return res.status(429).json({ error: "rate_limited" }); }
    return next();
  }
  const now = Date.now();
  const hit = rateHits.get(ip);
  if (!hit || now > hit.resetAt) {
    rateHits.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return next();
  }
  hit.count += 1;
  if (hit.count > RATE_LIMIT_MAX) {
    res.setHeader("Retry-After", String(Math.ceil((hit.resetAt - now) / 1000)));
    return res.status(429).json({ error: "rate_limited", retryAfterMs: Math.max(0, hit.resetAt - now) });
  }
  next();
});

app.post("/csp-report", express.json({ type: ["application/csp-report", "application/reports+json", "application/json"], limit: "32kb" }), (req, res) => {
  log("warn", "csp report", { body: req.body });
  res.status(204).end();
});

app.use(express.json({ limit: "64kb" }));
// This API is a REBUILDABLE CACHE, never the source of truth. Every row carries its
// on-chain object id (`id`) plus Walrus blob ids (snapshot / source / artifact / report),
// so any client can re-verify each value against Sui RPC + Walrus and never has to trust
// the indexer. The header advertises that contract on every response.
app.use((_req, res, next) => {
  res.setHeader("X-Signet-Source", "indexer-cache; reverify against Sui RPC + Walrus");
  next();
});

function cursorSnapshot() {
  return db.prepare(`SELECT module, tx, seq, updated_at FROM cursors ORDER BY module`).all() as any[];
}

function cacheMeta() {
  return {
    cacheAgeMs: lastPollOkAt ? Date.now() - lastPollOkAt : null,
    cursor: cursorSnapshot(),
    partial: Boolean(lastPollError),
  };
}

function gateway(res: express.Response, data: any, reverify: any = {}, status = 200) {
  return res.status(status).json({ source: "indexer-cache", ...cacheMeta(), data, reverify });
}

function missing(res: express.Response) {
  return gateway(res, null, { network: NET, packageId: PACKAGE, note: "No cached row; re-scan Sui events or wait for indexer backfill." }, 404);
}

function releaseWithLink(id: string) {
  return db.prepare(
    `SELECT releases.*, release_links.merged_pr_id
     FROM releases LEFT JOIN release_links ON release_links.release_id = releases.id
     WHERE releases.id=?`,
  ).get(id) as any | undefined;
}

async function hydrateApps(rows: any[]) {
  if (!rows.length) return [];
  const byId = new Map(rows.map((r) => [r.id, { ...r }]));
  for (let i = 0; i < rows.length; i += 50) {
    const ids = rows.slice(i, i + 50).map((r) => r.id);
    const objs = await client.multiGetObjects({ ids, options: { showContent: true } }).catch(() => []);
    for (const o of objs as any[]) {
      const id = o?.data?.objectId;
      const f = o?.data?.content?.fields;
      if (!id || !f || !byId.has(id)) continue;
      Object.assign(byId.get(id), {
        builder: f.builder ?? byId.get(id).builder,
        name: f.name ?? byId.get(id).name,
        prompt: f.prompt ?? "",
        category: f.category ?? "",
        manifest_blob: f.manifest_blob ?? byId.get(id).manifest_blob,
        archive_blob: f.archive_blob ?? byId.get(id).archive_blob,
        tree_hash: f.tree_hash ?? byId.get(id).tree_hash,
        visits: Number(f.visits ?? byId.get(id).visits ?? 0),
        stars: Number(f.stars ?? byId.get(id).stars ?? 0),
        tips: Number(f.tips_total ?? byId.get(id).tips ?? 0),
      });
    }
  }
  return [...byId.values()].map((a) => ({
    ...a,
    reverify: reverifyAnchor("app", a),
  }));
}

function verifyCachedRelease(releaseId: string) {
  const release = releaseWithLink(releaseId);
  if (!release) return null;
  let pr: any | undefined;
  let linkMode = "fallback";
  if (release.merged_pr_id) {
    linkMode = "direct";
    pr = db.prepare(`SELECT * FROM prs WHERE id=?`).get(release.merged_pr_id) as any | undefined;
  }
  if (!pr) {
    pr = db.prepare(`SELECT * FROM prs WHERE head=? AND status=1 LIMIT 1`).get(release.source) as any | undefined;
  }
  const reviews = pr ? db.prepare(`SELECT * FROM reviews WHERE pr_id=?`).all(pr.id) as any[] : [];
  const chainOk = !!pr && pr.status === 1 && pr.head === release.source;
  const reviewedOk = reviews.length > 0;
  const anchors = reverifyAnchor("release", release);
  return {
    releaseId,
    version: release.version,
    pass: Boolean(release.source && release.artifact && release.report && chainOk && reviewedOk),
    level: chainOk && reviewedOk ? 3 : release.source && release.artifact && release.report ? 1 : 0,
    linkMode,
    release,
    pr: pr ?? null,
    reviews,
    steps: [
      { label: "Release cached", ok: true, detail: release.id },
      { label: "Walrus anchors present", ok: Boolean(release.source && release.artifact && release.report), detail: anchors.blobIds.join(", ") },
      { label: "Merged PR matches source", ok: chainOk, detail: pr ? `${pr.id} -> ${pr.head}` : "no merged PR in cache" },
      { label: "Review/CI report attached", ok: reviewedOk, detail: `${reviews.length} review(s)` },
    ],
    reverify: anchors,
  };
}

app.get(["/verify", "/api/verify"], (req, res) => {
  const releaseId = String(req.query.release ?? req.query.releaseId ?? "");
  if (!releaseId) return gateway(res, null, { network: NET, packageId: PACKAGE, note: "Pass ?release=<release object id>." }, 400);
  const result = verifyCachedRelease(releaseId);
  if (!result) return missing(res);
  return gateway(res, result, result.reverify);
});

app.post(["/verify", "/api/verify"], (req, res) => {
  const releaseId = String(req.body?.releaseId ?? req.body?.release ?? "");
  if (!releaseId) return gateway(res, null, { network: NET, packageId: PACKAGE, note: "Body requires releaseId." }, 400);
  const result = verifyCachedRelease(releaseId);
  if (!result) return missing(res);
  return gateway(res, result, result.reverify);
});

app.get(["/schema", "/api/schema"], (_req, res) => {
  const tables = [
    "repos", "prs", "reviews", "issues", "bounties", "releases", "release_links",
    "reputation", "activity", "apps", "app_bounties", "payment_requests", "cursors",
    "webhook_subscriptions", "webhook_deliveries",
  ];
  const data = {
    network: NET,
    packageId: PACKAGE,
    playgroundPackageId: PLAYGROUND_PACKAGE,
    eventSources: EVENT_SOURCES,
    tables: Object.fromEntries(tables.map((table) => [
      table,
      db.prepare(`PRAGMA table_info(${table})`).all(),
    ])),
  };
  return gateway(res, data, { network: NET, packageId: PACKAGE });
});

app.get(["/sync-report", "/api/sync-report"], (_req, res) => {
  const cursors = cursorSnapshot();
  const rows = {
    repos: (db.prepare(`SELECT COUNT(*) n FROM repos`).get() as any).n,
    prs: (db.prepare(`SELECT COUNT(*) n FROM prs`).get() as any).n,
    releases: (db.prepare(`SELECT COUNT(*) n FROM releases`).get() as any).n,
    apps: (db.prepare(`SELECT COUNT(*) n FROM apps`).get() as any).n,
    payments: (db.prepare(`SELECT COUNT(*) n FROM payment_requests`).get() as any).n,
    activity: (db.prepare(`SELECT COUNT(*) n FROM activity`).get() as any).n,
    webhookDeliveries: (db.prepare(`SELECT COUNT(*) n FROM webhook_deliveries`).get() as any).n,
  };
  const data = {
    ...healthPayload(),
    pollCount,
    pollErrorCount,
    cacheAgeMs: lastPollOkAt ? Date.now() - lastPollOkAt : null,
    partial: Boolean(lastPollError),
    eventSources: EVENT_SOURCES.map((s) => {
      const cursor = cursors.find((c) => c.module === s.key) ?? null;
      return {
        ...s,
        cursor,
        cursorAgeMs: cursor?.updated_at ? Date.now() - Number(cursor.updated_at) : null,
        lag: cursor ? "tracked" : "not-started",
      };
    }),
    rows,
  };
  return gateway(res, data, { network: NET, packageId: PACKAGE, cursor: cursors });
});

app.get(["/apps", "/api/apps"], async (_req, res) => {
  const rows = db.prepare(`SELECT * FROM apps ORDER BY created_at DESC LIMIT 500`).all() as any[];
  const data = await hydrateApps(rows);
  return gateway(res, data, { network: NET, packageId: PLAYGROUND_PACKAGE, objectIds: data.map((a: any) => a.id), blobIds: data.flatMap((a: any) => a.reverify.blobIds) });
});

app.get(["/apps/:id", "/api/apps/:id"], async (req, res) => {
  const id = String(req.params.id);
  const row = db.prepare(`SELECT * FROM apps WHERE id=?`).get(id) as any | undefined;
  if (!row) return missing(res);
  const data = (await hydrateApps([row]))[0];
  return gateway(res, data, data.reverify);
});

app.get(["/agents", "/api/agents"], (_req, res) => {
  const rows = db.prepare(
    `SELECT agent, SUM(prs_opened) prs_opened, SUM(prs_merged) prs_merged,
            SUM(reviews) reviews, SUM(ci_runs) ci_runs
     FROM reputation GROUP BY agent ORDER BY SUM(prs_merged) DESC, SUM(reviews) DESC`,
  ).all() as any[];
  const data = rows.map((r) => ({
    agent: r.agent,
    prsOpened: Number(r.prs_opened ?? 0),
    prsMerged: Number(r.prs_merged ?? 0),
    reviews: Number(r.reviews ?? 0),
    ciRuns: Number(r.ci_runs ?? 0),
    score: Number(r.prs_merged ?? 0) * 10 + Number(r.reviews ?? 0) * 3 + Number(r.ci_runs ?? 0) * 2,
    reviewReports: (db.prepare(`SELECT id, pr_id, verdict, report_blob FROM reviews WHERE reviewer=? ORDER BY rowid DESC LIMIT 20`).all(r.agent) as any[])
      .map((x) => ({ ...x, reverify: reverifyAnchor("review", { id: x.id, report_blob: x.report_blob }) })),
  }));
  return gateway(res, data, { network: NET, packageId: PACKAGE, objectIds: data.map((a) => a.agent) });
});

app.get(["/packages", "/api/packages"], (_req, res) => {
  const releases = db.prepare(`SELECT * FROM releases ORDER BY rowid DESC LIMIT 20`).all() as any[];
  const linked = db.prepare(`SELECT COUNT(*) n FROM release_links`).get() as any;
  const riskBadge = releases.length && Number(linked?.n ?? 0) > 0 ? "trusted" : releases.length ? "partial" : "failed";
  const data = [{
    network: NET,
    packageId: PACKAGE,
    playgroundPackageId: PLAYGROUND_PACKAGE,
    mvrName: deployment.mvrName ?? "@signet/forge",
    mvrStatus: deployment.mvrStatus ?? "raw package id active",
    publishTx: deployment.publishTx ?? null,
    toolchainVersion: deployment.toolchainVersion ?? null,
    dependencies: ["MoveStdlib", "Sui framework", "Walrus blobs"],
    maintainer: deployment.maintainer ?? null,
    riskBadge,
    verifiedReleases: releases.length,
    releases: releases.map((r) => ({ ...r, reverify: reverifyAnchor("release", r) })),
  }];
  return gateway(res, data, { network: NET, packageId: PACKAGE, txDigest: deployment.publishTx ?? null });
});

function classifyArtifact(label: string) {
  const s = label.toLowerCase();
  if (s.includes("model") || s.includes("weights")) return "model";
  if (s.includes("dataset")) return "dataset";
  if (s.includes("eval") || s.includes("benchmark")) return "eval";
  if (s.includes("inference") || s.includes("receipt")) return "inference";
  if (s.includes("ci") || s.includes("test") || s.includes("report")) return "ci";
  if (s.includes("proof") || s.includes("attestation")) return "proof";
  if (s.includes("source") || s.includes("snapshot")) return "source";
  return "artifact";
}

app.get(["/artifacts", "/api/artifacts"], (_req, res) => {
  const releases = db.prepare(`SELECT * FROM releases ORDER BY rowid DESC LIMIT 200`).all() as any[];
  const reviews = db.prepare(`SELECT * FROM reviews ORDER BY rowid DESC LIMIT 200`).all() as any[];
  const bounties = db.prepare(`SELECT * FROM bounties WHERE proof IS NOT NULL ORDER BY rowid DESC LIMIT 200`).all() as any[];
  const data = [
    ...releases.flatMap((r) => [
      { artifactType: "source", blobId: r.source, label: "source snapshot", releaseId: r.id, repoId: r.repo_id, riskBadge: "trusted" },
      { artifactType: "artifact", blobId: r.artifact, label: "build artifact", releaseId: r.id, repoId: r.repo_id, riskBadge: "trusted" },
      { artifactType: classifyArtifact("test report"), blobId: r.report, label: "test report", releaseId: r.id, repoId: r.repo_id, riskBadge: "trusted" },
    ]),
    ...reviews.map((r) => ({
      artifactType: classifyArtifact("review report"),
      blobId: r.report_blob,
      label: "review report",
      prId: r.pr_id,
      repoId: r.repo_id,
      owner: r.reviewer,
      riskBadge: "partial",
    })),
    ...bounties.map((b) => ({
      artifactType: classifyArtifact(String(b.proof)),
      blobId: b.proof,
      label: "bounty proof",
      repoId: b.repo_id,
      owner: b.claimant,
      riskBadge: b.status === 2 ? "trusted" : "partial",
    })),
  ].filter((a) => a.blobId);
  return gateway(res, data.map((a) => ({ ...a, reverify: reverifyAnchor("artifact", { id: a.blobId, ...a }) })), {
    network: NET,
    packageId: PACKAGE,
    blobIds: data.map((a) => a.blobId),
  });
});

app.get(["/bounties", "/api/bounties"], (_req, res) => {
  const repo = db.prepare(`SELECT * FROM bounties ORDER BY rowid DESC LIMIT 500`).all() as any[];
  const appBounties = db.prepare(`SELECT * FROM app_bounties ORDER BY rowid DESC LIMIT 500`).all() as any[];
  const data = {
    repo: repo.map((b) => ({ ...b, reverify: reverifyAnchor("bounty", b) })),
    app: appBounties.map((b) => ({ ...b, reverify: reverifyAnchor("app_bounty", b) })),
  };
  return gateway(res, data, { network: NET, packageId: PACKAGE, objectIds: [...repo, ...appBounties].map((b) => b.id) });
});

app.get(["/payments", "/api/payments"], (_req, res) => {
  const rows = db.prepare(`SELECT * FROM payment_requests ORDER BY created_at DESC LIMIT 500`).all() as any[];
  const data = rows.map((p) => ({ ...p, reverify: reverifyAnchor("payment", p) }));
  return gateway(res, data, { network: NET, packageId: PACKAGE, objectIds: rows.map((p) => p.id) });
});

app.get(["/payments/:id", "/api/payments/:id"], (req, res) => {
  const row = db.prepare(`SELECT * FROM payment_requests WHERE id=?`).get(String(req.params.id)) as any | undefined;
  if (!row) return missing(res);
  return gateway(res, { ...row, reverify: reverifyAnchor("payment", row) }, reverifyAnchor("payment", row));
});

app.post(["/payments", "/api/payments"], (req, res) => {
  const recipient = String(req.body?.recipient ?? "");
  const label = String(req.body?.label ?? "Signet payment");
  const amountMist = Number(req.body?.amountMist ?? 0);
  if (!recipient || !amountMist || amountMist <= 0) {
    return gateway(res, null, { note: "Body requires recipient and positive amountMist." }, 400);
  }
  return gateway(res, {
    tx: {
      packageId: deployment.latestPackageId ?? PACKAGE,
      target: `${deployment.latestPackageId ?? PACKAGE}::payment::create_request`,
      arguments: { recipient, label, amountMist, expiresAtMs: req.body?.expiresAtMs ?? null },
    },
    note: "Gateway cannot sign for users. Submit this transaction from the wallet/CLI SDK.",
  }, { network: NET, packageId: deployment.latestPackageId ?? PACKAGE }, 202);
});

const WEBHOOK_EVENTS = ["release.published", "bounty.claimed", "bounty.paid", "app.published", "agent.reviewed", "payment.paid", "*"];

app.get(["/webhooks", "/api/webhooks"], (_req, res) => {
  const data = (db.prepare(`SELECT id,event_type,target_url,active,created_at FROM webhook_subscriptions ORDER BY created_at DESC`).all() as any[]);
  return gateway(res, data, { network: NET, events: WEBHOOK_EVENTS });
});

app.post(["/webhooks", "/api/webhooks"], (req, res) => {
  const eventType = String(req.body?.eventType ?? req.body?.event ?? "*");
  const targetUrl = String(req.body?.url ?? req.body?.targetUrl ?? "");
  if (!WEBHOOK_EVENTS.includes(eventType)) return gateway(res, null, { events: WEBHOOK_EVENTS }, 400);
  try {
    const u = new URL(targetUrl);
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("unsupported protocol");
  } catch {
    return gateway(res, null, { note: "url must be an http(s) webhook endpoint" }, 400);
  }
  const id = randomUUID();
  up.webhookSub.run({
    id, event_type: eventType, target_url: targetUrl,
    secret: req.body?.secret ? String(req.body.secret) : null,
    created_at: Date.now(),
  });
  return gateway(res, { id, eventType, targetUrl, active: true }, { network: NET, events: WEBHOOK_EVENTS }, 201);
});

app.delete(["/webhooks/:id", "/api/webhooks/:id"], (req, res) => {
  const id = String(req.params.id);
  const info = db.prepare(`UPDATE webhook_subscriptions SET active=0 WHERE id=?`).run(id) as any;
  if ((info?.changes ?? 0) === 0) return missing(res);
  return gateway(res, { id, active: false }, { network: NET });
});

app.get(["/webhook-deliveries", "/api/webhook-deliveries"], (_req, res) => {
  const data = db.prepare(`SELECT * FROM webhook_deliveries ORDER BY delivered_at DESC LIMIT 100`).all();
  return gateway(res, data, { network: NET });
});

function healthPayload() {
  return {
    ok: ready,
    package: PACKAGE,
    network: NET,
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    lastPollOkAt,
    lastPollError: lastPollError || null,
    source: "indexer-cache",
    reverify: "rebuildable cache - verify object ids on Sui RPC + blob ids on Walrus (chain is source of truth)",
  };
}

app.get(["/health", "/api/health"], (_req, res) =>
  res.status(ready ? 200 : 503).json(healthPayload()));

app.get(["/status", "/api/status"], (_req, res) => gateway(res, {
  ...healthPayload(),
  eventSources: EVENT_SOURCES.map((s) => ({
    key: s.key,
    packageId: s.packageId,
    module: s.module,
    cursor: db.prepare(`SELECT tx, seq, updated_at FROM cursors WHERE module=?`).get(s.key) ?? null,
  })),
  rows: {
    repos: (db.prepare(`SELECT COUNT(*) n FROM repos`).get() as any).n,
    prs: (db.prepare(`SELECT COUNT(*) n FROM prs`).get() as any).n,
    releases: (db.prepare(`SELECT COUNT(*) n FROM releases`).get() as any).n,
    apps: (db.prepare(`SELECT COUNT(*) n FROM apps`).get() as any).n,
    payments: (db.prepare(`SELECT COUNT(*) n FROM payment_requests`).get() as any).n,
  },
}, { network: NET, packageId: PACKAGE }));

app.get("/metrics", (_req, res) => {
  const lines = [
    "# HELP signet_indexer_ready Indexer readiness: 1 after first successful startup poll.",
    "# TYPE signet_indexer_ready gauge",
    `signet_indexer_ready{network="${NET}"} ${ready ? 1 : 0}`,
    "# HELP signet_indexer_polls_total Total indexer poll loops.",
    "# TYPE signet_indexer_polls_total counter",
    `signet_indexer_polls_total{network="${NET}"} ${pollCount}`,
    "# HELP signet_indexer_poll_errors_total Total poll errors.",
    "# TYPE signet_indexer_poll_errors_total counter",
    `signet_indexer_poll_errors_total{network="${NET}"} ${pollErrorCount}`,
    "# HELP signet_indexer_cache_age_ms Milliseconds since the last fully successful poll.",
    "# TYPE signet_indexer_cache_age_ms gauge",
    `signet_indexer_cache_age_ms{network="${NET}"} ${lastPollOkAt ? Date.now() - lastPollOkAt : -1}`,
    "# HELP signet_indexer_partial_sync Indexer partial-sync flag: 1 when the last poll had an error.",
    "# TYPE signet_indexer_partial_sync gauge",
    `signet_indexer_partial_sync{network="${NET}"} ${lastPollError ? 1 : 0}`,
    "# HELP signet_http_requests_total HTTP requests by route.",
    "# TYPE signet_http_requests_total counter",
  ];
  for (const [route, m] of requestMetrics) {
    const safeRoute = route.replace(/"/g, "");
    lines.push(`signet_http_requests_total{route="${safeRoute}"} ${m.count}`);
    lines.push(`signet_http_request_errors_total{route="${safeRoute}"} ${m.errors}`);
    lines.push(`signet_http_request_duration_ms_sum{route="${safeRoute}"} ${m.totalMs}`);
  }
  res.type("text/plain; version=0.0.4").send(lines.join("\n") + "\n");
});

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
  res.json(db.prepare(
    `SELECT releases.*, release_links.merged_pr_id
     FROM releases LEFT JOIN release_links ON release_links.release_id = releases.id
     WHERE releases.repo_id=?`,
  ).all(req.params.id)),
);
app.get("/api/repos/:id/reputation", (req, res) =>
  res.json(db.prepare(`SELECT * FROM reputation WHERE repo_id=? ORDER BY prs_merged DESC`).all(req.params.id)),
);
app.get("/api/repos/:id/activity", (req, res) =>
  res.json(db.prepare(`SELECT * FROM activity WHERE repo_id=? ORDER BY rowid DESC LIMIT 100`).all(req.params.id)),
);
app.get("/api/releases/:id", (req, res) => {
  const r = db.prepare(
    `SELECT releases.*, release_links.merged_pr_id
     FROM releases LEFT JOIN release_links ON release_links.release_id = releases.id
     WHERE releases.id=?`,
  ).get(req.params.id);
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
