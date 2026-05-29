"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import {
  getRelease, getRepo, fetchManifest, fetchBlobText, short,
  explorerObject, blobUrl, routeTailFromLocation,
  type Release, type Repo, type Manifest,
} from "@/lib/forge";

export default function View() {
  const params = useParams<{ id: string }>();
  const [id, setId] = useState("");
  const [rel, setRel] = useState<Release | null | undefined>(undefined);
  const [repo, setRepo] = useState<Repo | null>(null);
  const [src, setSrc] = useState<Manifest | null>(null);
  const [report, setReport] = useState<string | null>(null);

  useEffect(() => {
    setId(params.id && params.id !== "__id__" ? params.id : routeTailFromLocation());
  }, [params.id]);

  useEffect(() => {
    if (!id) return;
    getRelease(id).then(async (r) => {
      setRel(r);
      if (!r) return;
      const [repoData, m, rep] = await Promise.all([
        getRepo(r.repoId).catch(() => null),
        fetchManifest(r.sourceSnapshot).catch(() => null),
        fetchBlobText(r.testReport).catch(() => null),
      ]);
      setRepo(repoData); setSrc(m); setReport(rep);
    }).catch(() => setRel(null));
  }, [id]);

  if (rel === undefined) return <div className="wrap"><div className="empty">Loading…</div></div>;
  if (rel === null) return <div className="wrap"><Link href="/" className="back">← all repositories</Link><div className="empty">Release not found.</div></div>;

  return (
    <div className="wrap">
      <Link href={repo ? `/repo/${repo.id}` : "/"} className="back">← {repo ? repo.name : "repository"}</Link>
      <section style={{ padding: "12px 0 24px" }}>
        <div className="eyebrow">verifiable release</div>
        <h1 className="display" style={{ fontSize: "clamp(46px,8vw,90px)", marginTop: 14 }}><span className="molten">{rel.version}</span></h1>
        <p className="lede" style={{ fontSize: 19, marginTop: 18 }}>
          Every artifact below lives on <em>Walrus</em> and is anchored by a <em>Sui</em> object.
          Click any node to verify it independently — nothing here is a screenshot.
        </p>
        <div className="node-body" style={{ marginTop: 20 }}>
          <a className="chip" href={explorerObject(rel.publishedBy)} target="_blank" rel="noreferrer">released by {short(rel.publishedBy)} ↗</a>
          <a className="chip" href={explorerObject(rel.id)} target="_blank" rel="noreferrer">release {short(rel.id, 6, 4)} ↗</a>
        </div>
      </section>

      <section className="section">
        <div className="section-head"><h2>Provenance chain</h2><span className="faint mono">source → artifact → tests → release</span></div>
        <div className="chain">
          <div className="link-node">
            <div className="node-badge">◆</div><div className="node-kind">source snapshot</div>
            <h4>{src ? `${src.files.length} files · tree ${short(src.treeHash, 6, 6)}` : "Source code on Walrus"}</h4>
            <p className="dim" style={{ fontSize: 15 }}>The exact code this release was built from, content-addressed and durable.</p>
            <div className="node-body"><a className="chip" href={blobUrl(rel.sourceSnapshot)} target="_blank" rel="noreferrer">blob {short(rel.sourceSnapshot, 8, 6)} ↗</a></div>
            {src && <div className="filetree" style={{ marginTop: 16 }}>{src.files.slice(0, 8).map((file) => (
              <div className="row" key={file.path}><span>{file.path}</span><span className="hash">{file.sha256.slice(0, 12)}</span></div>))}</div>}
          </div>
          <div className="link-node">
            <div className="node-badge">⬢</div><div className="node-kind">build artifact</div><h4>Compiled output</h4>
            <p className="dim" style={{ fontSize: 15 }}>The build produced from the source above — the bytes a user runs.</p>
            <div className="node-body"><a className="chip" href={blobUrl(rel.buildArtifact)} target="_blank" rel="noreferrer">blob {short(rel.buildArtifact, 8, 6)} ↗</a></div>
          </div>
          <div className="link-node">
            <div className="node-badge">✓</div><div className="node-kind">test / ci report</div><h4>Verification</h4>
            <p className="dim" style={{ fontSize: 15 }}>The agent-submitted CI report proving the build passed before release.</p>
            {report && <pre style={{ marginTop: 14, background: "var(--abyss-0)", border: "1px solid var(--steel-line)", borderRadius: 10, padding: "14px 16px", fontFamily: "var(--font-mono)", fontSize: 12.5, color: "var(--ok)", whiteSpace: "pre-wrap", overflowX: "auto" }}>{report.slice(0, 600)}</pre>}
            <div className="node-body"><a className="chip" href={blobUrl(rel.testReport)} target="_blank" rel="noreferrer">blob {short(rel.testReport, 8, 6)} ↗</a></div>
          </div>
          <div className="link-node">
            <div className="node-badge" style={{ color: "var(--molten-bright)", borderColor: "var(--molten-deep)" }}>★</div>
            <div className="node-kind">release object</div><h4>{rel.version} — anchored on Sui</h4>
            <p className="dim" style={{ fontSize: 15 }}>The on-chain object binding source, artifact and tests into one immutable, owner-signed release.</p>
            <div className="node-body"><a className="chip" href={explorerObject(rel.id)} target="_blank" rel="noreferrer">{short(rel.id, 10, 8)} ↗</a></div>
          </div>
        </div>
      </section>
    </div>
  );
}
