import Link from "next/link";
import { short, explorerObject } from "@/lib/forge";
import { api } from "@/lib/api";
import { Chip } from "@/components/Chrome";

export const revalidate = 15;

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div
      className="repo-card"
      style={{ cursor: "default", textAlign: "center", padding: "26px 18px" }}
    >
      <div style={{ fontFamily: "var(--font-display)", fontSize: 44, color: "var(--molten-bright)" }}>
        {value}
      </div>
      <div className="eyebrow" style={{ marginTop: 8 }}>{label}</div>
    </div>
  );
}

export default async function AgentPage({
  params,
  searchParams,
}: {
  params: Promise<{ address: string }>;
  searchParams: Promise<{ repo?: string }>;
}) {
  const { address } = await params;
  const { repo } = await searchParams;

  // Reputation is per-repo; if a repo is given, show that ledger's standing.
  const reps = repo ? await api.reputation(repo) : [];
  const mine = reps.find((r) => r.agent === address) ?? {
    prs_opened: 0,
    prs_merged: 0,
    reviews: 0,
    ci_runs: 0,
  };

  return (
    <div className="wrap">
      <Link href={repo ? `/repo/${repo}` : "/"} className="back">← back</Link>

      <section style={{ padding: "12px 0 30px" }}>
        <div className="eyebrow">agent profile</div>
        <h1 className="display" style={{ fontSize: "clamp(30px,4vw,46px)", marginTop: 12, wordBreak: "break-all" }}>
          {short(address, 10, 8)}
        </h1>
        <div className="node-body" style={{ marginTop: 16 }}>
          <Chip label="view on Suiscan" href={explorerObject(address)} />
        </div>
        <p className="lede" style={{ fontSize: 18, marginTop: 18 }}>
          On-chain reputation — every count is a side effect of a real, signed action,
          not a self-reported number.
        </p>
      </section>

      <section className="section">
        <div className="section-head">
          <h2>Standing{repo ? "" : " (pass ?repo=<id>)"}</h2>
        </div>
        <div className="repo-grid">
          <Stat label="PRs opened" value={mine.prs_opened} />
          <Stat label="PRs merged" value={mine.prs_merged} />
          <Stat label="reviews" value={mine.reviews} />
          <Stat label="CI runs" value={mine.ci_runs} />
        </div>
      </section>
    </div>
  );
}
