import Link from "next/link";
import {
  getRepo,
  listPullRequests,
  fetchManifest,
  prStatusLabel,
  short,
  explorerObject,
  blobUrl,
} from "@/lib/forge";
import { api, bountyStatusLabel, formatSui } from "@/lib/api";
import { Chip } from "@/components/Chrome";

export const revalidate = 15;

export default async function RepoPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const repo = await getRepo(id).catch(() => null);

  if (!repo) {
    return (
      <div className="wrap">
        <Link href="/" className="back">
          ← all repositories
        </Link>
        <div className="empty">Repository not found on testnet.</div>
      </div>
    );
  }

  const [prs, manifest, issues, bounties, reputation, activity] = await Promise.all([
    listPullRequests(id).catch(() => []),
    fetchManifest(repo.currentSnapshot).catch(() => null),
    api.issues(id),
    api.bounties(id),
    api.reputation(id),
    api.activity(id),
  ]);

  return (
    <div className="wrap">
      <Link href="/" className="back">
        ← all repositories
      </Link>

      <section style={{ padding: "12px 0 30px" }}>
        <div className="eyebrow">repository</div>
        <h1 className="display" style={{ fontSize: "clamp(40px,6vw,68px)", marginTop: 14 }}>
          {repo.name}
        </h1>

        <div className="kv" style={{ marginTop: 26 }}>
          <span className="k">owner</span>
          <Chip label={short(repo.owner, 10, 8)} href={explorerObject(repo.owner)} />
        </div>
        <div className="kv">
          <span className="k">default branch</span>
          <span className="mono">{repo.defaultBranch}</span>
        </div>
        <div className="kv">
          <span className="k">current ref</span>
          <span style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <span className="pill">v{repo.refVersion}</span>
            <Chip label={short(repo.currentSnapshot, 12, 8)} href={blobUrl(repo.currentSnapshot)} />
          </span>
        </div>
        <div className="kv">
          <span className="k">repository object</span>
          <Chip label={short(repo.id, 12, 8)} href={explorerObject(repo.id)} />
        </div>
        {repo.latestRelease && (
          <div className="kv">
            <span className="k">latest release</span>
            <Link href={`/release/${repo.latestRelease}`} className="btn primary">
              View provenance chain →
            </Link>
          </div>
        )}
      </section>

      {manifest && (
        <section className="section" style={{ paddingBottom: 50 }}>
          <div className="section-head">
            <h2>Current snapshot</h2>
            <span className="faint mono">
              {manifest.files.length} files · tree {short(manifest.treeHash, 6, 6)}
            </span>
          </div>
          <div className="filetree">
            {manifest.files.map((file) => (
              <div className="row" key={file.path}>
                <span>{file.path}</span>
                <span className="hash">
                  {file.size}b · {file.sha256.slice(0, 12)}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="section">
        <div className="section-head">
          <h2>Pull requests</h2>
          <span className="faint mono">{prs.length} total</span>
        </div>
        {prs.length === 0 ? (
          <div className="empty">No pull requests yet.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {prs.map((pr) => (
              <Link key={pr.id} href={`/pr/${pr.id}`} className="repo-card" style={{ display: "block" }}>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "flex-start",
                    gap: 16,
                  }}
                >
                  <div>
                    <h3 style={{ fontSize: 19, marginBottom: 8 }}>{pr.title || "(untitled PR)"}</h3>
                    <div className="dim mono" style={{ fontSize: 12 }}>
                      by {short(pr.author)} · {pr.reviewRefs.length} review(s)
                    </div>
                  </div>
                  <span className={`pill ${prStatusLabel(pr.status)}`}>
                    {prStatusLabel(pr.status)}
                  </span>
                </div>
                <div className="node-body" style={{ marginTop: 16 }}>
                  <Chip label={`base ${short(pr.baseSnapshot, 6, 4)}`} />
                  <Chip label={`head ${short(pr.headSnapshot, 6, 4)}`} />
                  <Chip label={short(pr.id, 6, 4)} />
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>

      {/* ===== Issues ===== */}
      <section className="section">
        <div className="section-head">
          <h2>Issues</h2>
          <span className="faint mono">{issues.length} total</span>
        </div>
        {issues.length === 0 ? (
          <div className="empty">No issues yet.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {issues.map((it) => (
              <div key={it.id} className="repo-card" style={{ cursor: "default", padding: 18 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 16 }}>
                  <div>
                    <h3 style={{ fontSize: 17 }}>{it.title}</h3>
                    <div className="dim mono" style={{ fontSize: 12, marginTop: 6 }}>
                      by {short(it.author)}
                    </div>
                  </div>
                  <span className={`pill ${it.status === 0 ? "open" : "closed"}`}>
                    {it.status === 0 ? "open" : "closed"}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ===== Bounties ===== */}
      <section className="section">
        <div className="section-head">
          <h2>Bounties</h2>
          <span className="faint mono">on-chain SUI escrow</span>
        </div>
        {bounties.length === 0 ? (
          <div className="empty">No bounties posted.</div>
        ) : (
          <div className="repo-grid">
            {bounties.map((b) => (
              <div key={b.id} className="repo-card" style={{ cursor: "default" }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                  <h3 style={{ fontSize: 18 }}>{b.title}</h3>
                  <span className={`pill ${b.status === 0 ? "open" : b.status === 2 ? "release" : "merged"}`}>
                    {bountyStatusLabel(b.status)}
                  </span>
                </div>
                <div style={{ marginTop: 14, fontFamily: "var(--font-display)", fontSize: 26, color: "var(--molten-bright)" }}>
                  {formatSui(b.amount)}
                </div>
                <div className="repo-meta">
                  <span>funder <b>{short(b.funder)}</b></span>
                  {b.claimant && <span>claimant <b>{short(b.claimant)}</b></span>}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ===== Agent reputation ===== */}
      <section className="section">
        <div className="section-head">
          <h2>Agent reputation</h2>
          <span className="faint mono">verifiable on-chain</span>
        </div>
        {reputation.length === 0 ? (
          <div className="empty">No agent activity recorded yet.</div>
        ) : (
          <div className="filetree">
            <div className="row" style={{ color: "var(--ink-faint)", textTransform: "uppercase", letterSpacing: "0.1em" }}>
              <span>agent</span>
              <span className="hash">opened / merged / reviews / ci</span>
            </div>
            {reputation.map((r) => (
              <Link key={r.agent} href={`/agent/${r.agent}?repo=${id}`} className="row" style={{ textDecoration: "none" }}>
                <span style={{ color: "var(--tide)" }}>{short(r.agent, 8, 6)}</span>
                <span className="hash">
                  {r.prs_opened} / {r.prs_merged} / {r.reviews} / {r.ci_runs}
                </span>
              </Link>
            ))}
          </div>
        )}
      </section>

      {/* ===== Activity feed ===== */}
      <section className="section">
        <div className="section-head">
          <h2>Activity</h2>
          <span className="faint mono">{activity.length} events</span>
        </div>
        {activity.length === 0 ? (
          <div className="empty">No activity (is the indexer running?).</div>
        ) : (
          <div className="filetree">
            {activity.slice(0, 20).map((a) => (
              <a
                key={`${a.tx}-${a.seq}`}
                className="row"
                href={`https://suiscan.xyz/testnet/tx/${a.tx}`}
                target="_blank"
                rel="noreferrer"
                style={{ textDecoration: "none" }}
              >
                <span style={{ color: "var(--molten)" }}>{a.type}</span>
                <span className="hash">{short(a.tx, 8, 6)} ↗</span>
              </a>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
