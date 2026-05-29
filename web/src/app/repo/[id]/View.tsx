"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import {
  getRepo, listPullRequests, fetchManifest, prStatusLabel, short,
  explorerObject, blobUrl, listIssues, listBounties,
  listReputation, listActivity, routeTailFromLocation,
  type Repo, type PullRequest, type Manifest, type Issue, type Bounty,
  type Reputation, type Activity,
} from "@/lib/forge";

const fmtSui = (mist: number) => `${(mist / 1_000_000_000).toFixed(3)} SUI`;
const bountyLabel = (s: number) => ["open", "claimed", "paid", "cancelled"][s] ?? "unknown";

export default function View() {
  const params = useParams<{ id: string }>();
  const [id, setId] = useState("");
  const [repo, setRepo] = useState<Repo | null | undefined>(undefined);
  const [prs, setPrs] = useState<PullRequest[]>([]);
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [bounties, setBounties] = useState<Bounty[]>([]);
  const [reputation, setReputation] = useState<Reputation[]>([]);
  const [activity, setActivity] = useState<Activity[]>([]);

  // Resolve the real id client-side (placeholder under static export).
  useEffect(() => {
    setId(params.id && params.id !== "__id__" ? params.id : routeTailFromLocation());
  }, [params.id]);

  useEffect(() => {
    if (!id) return;
    getRepo(id).then(async (r) => {
      setRepo(r);
      if (!r) return;
      const [p, m, is, b, rep, act] = await Promise.all([
        listPullRequests(id).catch(() => []),
        fetchManifest(r.currentSnapshot).catch(() => null),
        listIssues(id).catch(() => []),
        listBounties(id).catch(() => []),
        listReputation(id).catch(() => []),
        listActivity(id).catch(() => []),
      ]);
      setPrs(p); setManifest(m); setIssues(is); setBounties(b); setReputation(rep); setActivity(act);
    }).catch(() => setRepo(null));
  }, [id]);

  if (repo === undefined) return <div className="wrap"><div className="empty">Loading from Sui testnet…</div></div>;
  if (repo === null) return (
    <div className="wrap"><Link href="/" className="back">← all repositories</Link>
      <div className="empty">Repository not found on testnet.</div></div>
  );

  return (
    <div className="wrap">
      <Link href="/" className="back">← all repositories</Link>

      <section style={{ padding: "12px 0 30px" }}>
        <div className="eyebrow">repository</div>
        <h1 className="display" style={{ fontSize: "clamp(40px,6vw,68px)", marginTop: 14 }}>{repo.name}</h1>
        <div className="kv" style={{ marginTop: 26 }}>
          <span className="k">owner</span><a className="chip" href={explorerObject(repo.owner)} target="_blank" rel="noreferrer">{short(repo.owner, 10, 8)} ↗</a>
        </div>
        <div className="kv"><span className="k">current ref</span>
          <span style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <span className="pill">v{repo.refVersion}</span>
            <a className="chip" href={blobUrl(repo.currentSnapshot)} target="_blank" rel="noreferrer">{short(repo.currentSnapshot, 12, 8)} ↗</a>
          </span>
        </div>
        {repo.latestRelease && (
          <div className="kv"><span className="k">latest release</span>
            <Link href={`/release/${repo.latestRelease}`} className="btn primary">View provenance chain →</Link></div>
        )}
      </section>

      {manifest && (
        <section className="section" style={{ paddingBottom: 50 }}>
          <div className="section-head"><h2>Current snapshot</h2>
            <span className="faint mono">{manifest.files.length} files · tree {short(manifest.treeHash, 6, 6)}</span></div>
          <div className="filetree">
            {manifest.files.map((file) => (
              <div className="row" key={file.path}><span>{file.path}</span><span className="hash">{file.size}b · {file.sha256.slice(0, 12)}</span></div>
            ))}
          </div>
        </section>
      )}

      <section className="section">
        <div className="section-head"><h2>Pull requests</h2><span className="faint mono">{prs.length} total</span></div>
        {prs.length === 0 ? <div className="empty">No pull requests yet.</div> : (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {prs.map((pr) => (
              <Link key={pr.id} href={`/pr/${pr.id}`} className="repo-card" style={{ display: "block" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16 }}>
                  <div><h3 style={{ fontSize: 19, marginBottom: 8 }}>{pr.title || "(untitled PR)"}</h3>
                    <div className="dim mono" style={{ fontSize: 12 }}>by {short(pr.author)} · {pr.reviewRefs.length} review(s)</div></div>
                  <span className={`pill ${prStatusLabel(pr.status)}`}>{prStatusLabel(pr.status)}</span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>

      <section className="section">
        <div className="section-head"><h2>Issues</h2><span className="faint mono">{issues.length} total</span></div>
        {issues.length === 0 ? <div className="empty">No issues yet.</div> : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {issues.map((it) => (
              <div key={it.id} className="repo-card" style={{ cursor: "default", padding: 18 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 16 }}>
                  <div><h3 style={{ fontSize: 17 }}>{it.title}</h3>
                    <div className="dim mono" style={{ fontSize: 12, marginTop: 6 }}>by {short(it.author)}</div></div>
                  <span className={`pill ${it.status === 0 ? "open" : "closed"}`}>{it.status === 0 ? "open" : "closed"}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="section">
        <div className="section-head"><h2>Bounties</h2><span className="faint mono">on-chain SUI escrow</span></div>
        {bounties.length === 0 ? <div className="empty">No bounties posted.</div> : (
          <div className="repo-grid">
            {bounties.map((b) => (
              <div key={b.id} className="repo-card" style={{ cursor: "default" }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                  <h3 style={{ fontSize: 18 }}>{b.title}</h3>
                  <span className={`pill ${b.status === 0 ? "open" : b.status === 2 ? "release" : "merged"}`}>{bountyLabel(b.status)}</span>
                </div>
                <div style={{ marginTop: 14, fontFamily: "var(--font-display)", fontSize: 26, color: "var(--molten-bright)" }}>{fmtSui(b.amount)}</div>
                <div className="repo-meta"><span>funder <b>{short(b.funder)}</b></span>{b.claimant && <span>claimant <b>{short(b.claimant)}</b></span>}</div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="section">
        <div className="section-head"><h2>Agent reputation</h2><span className="faint mono">verifiable on-chain</span></div>
        {reputation.length === 0 ? <div className="empty">No agent activity recorded yet.</div> : (
          <div className="filetree">
            <div className="row" style={{ color: "var(--ink-faint)", textTransform: "uppercase", letterSpacing: "0.1em" }}>
              <span>agent</span><span className="hash">opened / merged / reviews / ci</span></div>
            {reputation.map((r) => (
              <Link key={r.agent} href={`/agent/${r.agent}?repo=${id}`} className="row" style={{ textDecoration: "none" }}>
                <span style={{ color: "var(--tide)" }}>{short(r.agent, 8, 6)}</span>
                <span className="hash">{r.prsOpened} / {r.prsMerged} / {r.reviews} / {r.ciRuns}</span>
              </Link>
            ))}
          </div>
        )}
      </section>

      <section className="section">
        <div className="section-head"><h2>Activity</h2><span className="faint mono">{activity.length} events</span></div>
        {activity.length === 0 ? <div className="empty">No activity yet.</div> : (
          <div className="filetree">
            {activity.slice(0, 20).map((a) => (
              <a key={`${a.tx}-${a.seq}`} className="row" href={`https://suiscan.xyz/testnet/tx/${a.tx}`} target="_blank" rel="noreferrer" style={{ textDecoration: "none" }}>
                <span style={{ color: "var(--molten)" }}>{a.type}</span><span className="hash">{short(a.tx, 8, 6)} ↗</span>
              </a>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
