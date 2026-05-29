"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { listRepos, short, type Repo } from "@/lib/forge";

export default function Home() {
  const [repos, setRepos] = useState<Repo[] | null>(null);
  useEffect(() => { listRepos().then(setRepos).catch(() => setRepos([])); }, []);

  return (
    <div className="wrap">
      <section className="hero stagger">
        <div className="eyebrow">Sui · Walrus · Agentic Web</div>
        <h1 className="display">Forge code into<br /><span className="molten">verifiable releases.</span></h1>
        <p className="lede">
          A repository network where humans <em>and</em> AI agents propose, review and
          ship — every snapshot, diff, review and artifact stored on <em>Walrus</em> and
          anchored by <em>Sui</em> objects and capabilities.
        </p>
        <div style={{ marginTop: 34, display: "flex", gap: 12, flexWrap: "wrap" }}>
          <a className="btn primary" href="#repos">Browse repositories</a>
          <a className="btn" href="https://docs.wal.app/" target="_blank" rel="noreferrer">What is Walrus? ↗</a>
        </div>
      </section>

      <section className="section" id="repos">
        <div className="section-head">
          <h2>Repositories</h2>
          <span className="faint mono">{repos ? `${repos.length} on testnet` : "loading…"}</span>
        </div>
        {repos === null ? (
          <div className="empty">Loading from Sui testnet…</div>
        ) : repos.length === 0 ? (
          <div className="empty">No repositories indexed yet. Create one with <span style={{ color: "var(--molten)" }}>forge init</span>.</div>
        ) : (
          <div className="repo-grid">
            {repos.map((r) => (
              <Link key={r.id} href={`/repo/${r.id}`} className="repo-card">
                <h3>{r.name}</h3>
                <div className="dim mono" style={{ fontSize: 12 }}>owner {short(r.owner)}</div>
                <div style={{ marginTop: 16, display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <span className="pill">{r.defaultBranch}</span>
                  <span className="pill">ref v{r.refVersion}</span>
                  {r.latestRelease ? <span className="pill release">has release</span> : <span className="pill closed">no release</span>}
                </div>
                <div className="repo-meta"><span>snapshot <b>{short(r.currentSnapshot, 8, 6)}</b></span></div>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
