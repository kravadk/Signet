"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import {
  getPullRequest, getRepo, fetchManifest, fetchBlobText, prStatusLabel,
  short, explorerObject, blobUrl, routeTailFromLocation,
  type PullRequest, type Repo, type Manifest,
} from "@/lib/forge";

export default function View() {
  const params = useParams<{ id: string }>();
  const [id, setId] = useState("");
  const [pr, setPr] = useState<PullRequest | null | undefined>(undefined);
  const [repo, setRepo] = useState<Repo | null>(null);
  const [head, setHead] = useState<Manifest | null>(null);
  const [base, setBase] = useState<Manifest | null>(null);
  const [reviews, setReviews] = useState<{ blob: string; text: string | null }[]>([]);

  useEffect(() => {
    setId(params.id && params.id !== "__id__" ? params.id : routeTailFromLocation());
  }, [params.id]);

  useEffect(() => {
    if (!id) return;
    getPullRequest(id).then(async (p) => {
      setPr(p);
      if (!p) return;
      const [r, h, b] = await Promise.all([
        getRepo(p.repoId).catch(() => null),
        fetchManifest(p.headSnapshot).catch(() => null),
        fetchManifest(p.baseSnapshot).catch(() => null),
      ]);
      setRepo(r); setHead(h); setBase(b);
      const rv = await Promise.all(p.reviewRefs.map(async (blob) => ({ blob, text: await fetchBlobText(blob).catch(() => null) })));
      setReviews(rv);
    }).catch(() => setPr(null));
  }, [id]);

  if (pr === undefined) return <div className="wrap"><div className="empty">Loading…</div></div>;
  if (pr === null) return <div className="wrap"><Link href="/" className="back">← all repositories</Link><div className="empty">Pull request not found.</div></div>;

  const baseMap = new Map((base?.files ?? []).map((file) => [file.path, file.sha256]));
  const headFiles = head?.files ?? [];
  const changed = headFiles.filter((file) => baseMap.get(file.path) !== file.sha256);

  return (
    <div className="wrap">
      <Link href={repo ? `/repo/${repo.id}` : "/"} className="back">← {repo ? repo.name : "repository"}</Link>
      <section style={{ padding: "12px 0 24px" }}>
        <div className="eyebrow">pull request</div>
        <h1 className="display" style={{ fontSize: "clamp(34px,5vw,56px)", marginTop: 12 }}>{pr.title || "(untitled PR)"}</h1>
        <div style={{ marginTop: 18, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <span className={`pill ${prStatusLabel(pr.status)}`}>{prStatusLabel(pr.status)}</span>
          <span className="dim mono" style={{ fontSize: 13 }}>by {short(pr.author, 10, 6)}</span>
        </div>
        <div className="node-body" style={{ marginTop: 18 }}>
          <a className="chip" href={blobUrl(pr.baseSnapshot)} target="_blank" rel="noreferrer">base {short(pr.baseSnapshot, 8, 6)} ↗</a>
          <a className="chip" href={blobUrl(pr.headSnapshot)} target="_blank" rel="noreferrer">head {short(pr.headSnapshot, 8, 6)} ↗</a>
          <a className="chip" href={explorerObject(pr.id)} target="_blank" rel="noreferrer">pr {short(pr.id, 6, 4)} ↗</a>
        </div>
      </section>

      <section className="section" style={{ paddingBottom: 50 }}>
        <div className="section-head"><h2>Changed files</h2><span className="faint mono">{changed.length} of {headFiles.length}</span></div>
        {changed.length === 0 ? <div className="empty">No file-level changes detected against base.</div> : (
          <div className="filetree">{changed.map((file) => (
            <div className="row" key={file.path}><span style={{ color: "var(--molten-bright)" }}>{file.path}</span>
              <span className="hash">{baseMap.has(file.path) ? "modified" : "added"} · {file.sha256.slice(0, 12)}</span></div>
          ))}</div>
        )}
      </section>

      <section className="section">
        <div className="section-head"><h2>Reviews</h2><span className="faint mono">{reviews.length} attached</span></div>
        {reviews.length === 0 ? <div className="empty">No reviews yet.</div> : (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {reviews.map((rv) => (
              <div key={rv.blob} className="link-node" style={{ marginLeft: 0 }}>
                <div className="node-kind">review report</div>
                {rv.text && <pre style={{ marginTop: 12, background: "var(--abyss-0)", border: "1px solid var(--steel-line)", borderRadius: 10, padding: "14px 16px", fontFamily: "var(--font-mono)", fontSize: 12.5, color: "var(--ok)", whiteSpace: "pre-wrap", overflowX: "auto" }}>{rv.text.slice(0, 800)}</pre>}
                <div className="node-body"><a className="chip" href={blobUrl(rv.blob)} target="_blank" rel="noreferrer">blob {short(rv.blob, 8, 6)} ↗</a></div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
