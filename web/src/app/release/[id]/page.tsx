import Link from "next/link";
import {
  getRelease,
  getRepo,
  fetchManifest,
  fetchBlobText,
  short,
  explorerObject,
  blobUrl,
} from "@/lib/forge";
import { Chip } from "@/components/Chrome";

export const revalidate = 15;

export default async function ReleasePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const release = await getRelease(id).catch(() => null);

  if (!release) {
    return (
      <div className="wrap">
        <Link href="/" className="back">
          ← all repositories
        </Link>
        <div className="empty">Release not found on testnet.</div>
      </div>
    );
  }

  const [repo, sourceManifest, testReport] = await Promise.all([
    getRepo(release.repoId).catch(() => null),
    fetchManifest(release.sourceSnapshot).catch(() => null),
    fetchBlobText(release.testReport).catch(() => null),
  ]);

  return (
    <div className="wrap">
      <Link href={repo ? `/repo/${repo.id}` : "/"} className="back">
        ← {repo ? repo.name : "repository"}
      </Link>

      <section style={{ padding: "12px 0 24px" }}>
        <div className="eyebrow">verifiable release</div>
        <h1
          className="display"
          style={{ fontSize: "clamp(46px,8vw,90px)", marginTop: 14 }}
        >
          <span className="molten">{release.version}</span>
        </h1>
        <p className="lede" style={{ fontSize: 19, marginTop: 18 }}>
          Every artifact below lives on <em>Walrus</em> and is anchored by a{" "}
          <em>Sui</em> object. Click any node to verify it independently — nothing
          here is a screenshot.
        </p>
        <div className="node-body" style={{ marginTop: 20 }}>
          <Chip label={`released by ${short(release.publishedBy)}`} href={explorerObject(release.publishedBy)} />
          <Chip label={`release ${short(release.id, 6, 4)}`} href={explorerObject(release.id)} />
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <h2>Provenance chain</h2>
          <span className="faint mono">source → artifact → tests → release</span>
        </div>

        <div className="chain">
          {/* 1. Source snapshot */}
          <div className="link-node">
            <div className="node-badge">◆</div>
            <div className="node-kind">source snapshot</div>
            <h4>
              {sourceManifest
                ? `${sourceManifest.files.length} files · tree ${short(sourceManifest.treeHash, 6, 6)}`
                : "Source code on Walrus"}
            </h4>
            <p className="dim" style={{ fontSize: 15 }}>
              The exact code this release was built from, content-addressed and durable.
            </p>
            <div className="node-body">
              <Chip label={`blob ${short(release.sourceSnapshot, 8, 6)}`} href={blobUrl(release.sourceSnapshot)} />
              {repo && (
                <Chip label={`repo ${short(repo.id, 6, 4)}`} href={explorerObject(repo.id)} />
              )}
            </div>
            {sourceManifest && (
              <div className="filetree" style={{ marginTop: 16 }}>
                {sourceManifest.files.slice(0, 8).map((file) => (
                  <div className="row" key={file.path}>
                    <span>{file.path}</span>
                    <span className="hash">{file.sha256.slice(0, 12)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* 2. Build artifact */}
          <div className="link-node">
            <div className="node-badge">⬢</div>
            <div className="node-kind">build artifact</div>
            <h4>Compiled output</h4>
            <p className="dim" style={{ fontSize: 15 }}>
              The build produced from the source above — the bytes a user actually runs.
            </p>
            <div className="node-body">
              <Chip label={`blob ${short(release.buildArtifact, 8, 6)}`} href={blobUrl(release.buildArtifact)} />
            </div>
          </div>

          {/* 3. Test report */}
          <div className="link-node">
            <div className="node-badge">✓</div>
            <div className="node-kind">test / ci report</div>
            <h4>Verification</h4>
            <p className="dim" style={{ fontSize: 15 }}>
              The agent-submitted CI report proving the build passed before release.
            </p>
            {testReport && (
              <pre
                style={{
                  marginTop: 14,
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
                {testReport.slice(0, 600)}
              </pre>
            )}
            <div className="node-body">
              <Chip label={`blob ${short(release.testReport, 8, 6)}`} href={blobUrl(release.testReport)} />
            </div>
          </div>

          {/* 4. Release anchor */}
          <div className="link-node">
            <div className="node-badge" style={{ color: "var(--molten-bright)", borderColor: "var(--molten-deep)" }}>
              ★
            </div>
            <div className="node-kind">release object</div>
            <h4>{release.version} — anchored on Sui</h4>
            <p className="dim" style={{ fontSize: 15 }}>
              The on-chain object that binds source, artifact and tests into one
              immutable, owner-signed release.
            </p>
            <div className="node-body">
              <Chip label={short(release.id, 10, 8)} href={explorerObject(release.id)} />
              <Chip label={`by ${short(release.publishedBy, 6, 4)}`} href={explorerObject(release.publishedBy)} />
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
