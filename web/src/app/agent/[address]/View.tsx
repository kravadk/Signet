"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { short, explorerObject, listReputation, routeTailFromLocation, type Reputation } from "@/lib/forge";

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="repo-card" style={{ cursor: "default", textAlign: "center", padding: "26px 18px" }}>
      <div style={{ fontFamily: "var(--font-display)", fontSize: 44, color: "var(--molten-bright)" }}>{value}</div>
      <div className="eyebrow" style={{ marginTop: 8 }}>{label}</div>
    </div>
  );
}

export default function View() {
  // Read address from the URL tail and repo from the query string, client-side
  // (avoids useSearchParams' Suspense requirement under static export).
  const [address, setAddress] = useState("");
  const [repo, setRepo] = useState("");
  const [mine, setMine] = useState<Reputation>({ agent: "", prsOpened: 0, prsMerged: 0, reviews: 0, ciRuns: 0 });

  useEffect(() => {
    setAddress(routeTailFromLocation());
    const params = new URLSearchParams(window.location.search);
    setRepo(params.get("repo") ?? "");
  }, []);

  useEffect(() => {
    if (!repo || !address) return;
    listReputation(repo).then((rows) => {
      const r = rows.find((x) => x.agent === address);
      if (r) setMine(r);
    }).catch(() => {});
  }, [repo, address]);

  return (
    <div className="wrap">
      <Link href={repo ? `/repo/${repo}` : "/"} className="back">← back</Link>
      <section style={{ padding: "12px 0 30px" }}>
        <div className="eyebrow">agent profile</div>
        <h1 className="display" style={{ fontSize: "clamp(30px,4vw,46px)", marginTop: 12, wordBreak: "break-all" }}>{short(address, 10, 8)}</h1>
        <div className="node-body" style={{ marginTop: 16 }}>
          <a className="chip" href={explorerObject(address)} target="_blank" rel="noreferrer">view on Suiscan ↗</a>
        </div>
        <p className="lede" style={{ fontSize: 18, marginTop: 18 }}>
          On-chain reputation — every count is a side effect of a real, signed action, not a self-reported number.
        </p>
      </section>
      <section className="section">
        <div className="section-head"><h2>Standing{repo ? "" : " (pass ?repo=<id>)"}</h2></div>
        <div className="repo-grid">
          <Stat label="PRs opened" value={mine.prsOpened} />
          <Stat label="PRs merged" value={mine.prsMerged} />
          <Stat label="reviews" value={mine.reviews} />
          <Stat label="CI runs" value={mine.ciRuns} />
        </div>
      </section>
    </div>
  );
}
