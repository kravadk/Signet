import Link from "next/link";
import {
  getPullRequest,
  getRepo,
  fetchManifest,
  fetchBlobText,
  prStatusLabel,
  short,
  explorerObject,
  blobUrl,
} from "@/lib/forge";
import { Chip } from "@/components/Chrome";

export const revalidate = 15;

export default async function PrPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const pr = await getPullRequest(id).catch(() => null);

  if (!pr) {
    return (
      <div className="wrap">
        <Link href="/" className="back">← all repositories</Link>
        <div className="empty">Pull request not found on testnet.</div>
      </div>
    );
  }

  const [repo, headManifest, baseManifest] = await Promise.all([
    getRepo(pr.repoId).catch(() => null),
    fetchManifest(pr.headSnapshot).catch(() => null),
    fetchManifest(pr.baseSnapshot).catch(() => null),
  ]);

  // Pull the attached review reports (text) from Walrus for display.
  const reviews = await Promise.all(
    pr.reviewRefs.map(async (blob) => ({ blob, text: await fetchBlobText(blob).catch(() => null) })),
  );

  // Naive diff: which files changed between base and head manifests.
  const baseMap = new Map((baseManifest?.files ?? []).map((f) => [f.path, f.sha256]));
  const headFiles = headManifest?.files ?? [];
  const changed = headFiles.filter((f) => baseMap.get(f.path) !== f.sha256);

  return (
    <div className="wrap">
      <Link href={repo ? `/repo/${repo.id}` : "/"} className="back">
        ← {repo ? repo.name : "repository"}
      </Link>

      <section style={{ padding: "12px 0 24px" }}>
        <div className="eyebrow">pull request</div>
        <h1 className="display" style={{ fontSize: "clamp(34px,5vw,56px)", marginTop: 12 }}>
          {pr.title || "(untitled PR)"}
        </h1>
        <div style={{ marginTop: 18, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <span className={`pill ${prStatusLabel(pr.status)}`}>{prStatusLabel(pr.status)}</span>
          <span className="dim mono" style={{ fontSize: 13 }}>by {short(pr.author, 10, 6)}</span>
        </div>
        <div className="node-body" style={{ marginTop: 18 }}>
          <Chip label={`base ${short(pr.baseSnapshot, 8, 6)}`} href={blobUrl(pr.baseSnapshot)} />
          <Chip label={`head ${short(pr.headSnapshot, 8, 6)}`} href={blobUrl(pr.headSnapshot)} />
          <Chip label={`pr ${short(pr.id, 6, 4)}`} href={explorerObject(pr.id)} />
        </div>
      </section>

      <section className="section" style={{ paddingBottom: 50 }}>
        <div className="section-head">
          <h2>Changed files</h2>
          <span className="faint mono">{changed.length} of {headFiles.length}</span>
        </div>
        {changed.length === 0 ? (
          <div className="empty">No file-level changes detected against base.</div>
        ) : (
          <div className="filetree">
            {changed.map((f) => (
              <div className="row" key={f.path}>
                <span style={{ color: "var(--molten-bright)" }}>{f.path}</span>
                <span className="hash">{baseMap.has(f.path) ? "modified" : "added"} · {f.sha256.slice(0, 12)}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="section">
        <div className="section-head">
          <h2>Reviews</h2>
          <span className="faint mono">{reviews.length} attached</span>
        </div>
        {reviews.length === 0 ? (
          <div className="empty">No reviews yet. A CI agent or human reviewer can attach one.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {reviews.map((rv) => (
              <div key={rv.blob} className="link-node" style={{ marginLeft: 0 }}>
                <div className="node-kind">review report</div>
                {rv.text && (
                  <pre
                    style={{
                      marginTop: 12,
                      background: "var(--abyss-0)",
                      border: "1px solid var(--steel-line)",
                      borderRadius: 10,
                      padding: "14px 16px",
                      fontFamily: "var(--font-mono)",
                      fontSize: 12.5,
                      color: "var(--ok)",
                      whiteSpace: "pre-wrap",
                      overflowX: "auto",
                    }}
                  >
                    {rv.text.slice(0, 800)}
                  </pre>
                )}
                <div className="node-body">
                  <Chip label={`blob ${short(rv.blob, 8, 6)}`} href={blobUrl(rv.blob)} />
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
