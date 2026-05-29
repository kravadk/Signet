/**
 * Web client for the WalrusForge indexer REST API.
 *
 * Pages read pre-indexed data from the backend (fast, no per-request RPC scan).
 * Base URL is configurable via NEXT_PUBLIC_FORGE_API; defaults to the local
 * indexer. Each call is defensive: on any failure it returns an empty result so
 * a page can still render (and fall back to on-chain reads where it has them).
 */

const BASE = process.env.NEXT_PUBLIC_FORGE_API ?? "http://localhost:4318";

async function get<T>(path: string, fallback: T): Promise<T> {
  try {
    const res = await fetch(`${BASE}${path}`, { cache: "no-store" });
    if (!res.ok) return fallback;
    return (await res.json()) as T;
  } catch {
    return fallback;
  }
}

export interface ApiIssue {
  id: string;
  repo_id: string;
  author: string;
  title: string;
  status: number; // 0 open, 1 closed
}

export interface ApiBounty {
  id: string;
  repo_id: string;
  funder: string;
  title: string;
  amount: number; // MIST
  status: number; // 0 open,1 claimed,2 paid,3 cancelled
  claimant: string | null;
}

export interface ApiReputation {
  repo_id: string;
  agent: string;
  prs_opened: number;
  prs_merged: number;
  reviews: number;
  ci_runs: number;
}

export interface ApiActivity {
  tx: string;
  seq: string;
  type: string;
  repo_id: string;
  json: string;
}

export const api = {
  issues: (repoId: string) => get<ApiIssue[]>(`/api/repos/${repoId}/issues`, []),
  bounties: (repoId: string) => get<ApiBounty[]>(`/api/repos/${repoId}/bounties`, []),
  reputation: (repoId: string) => get<ApiReputation[]>(`/api/repos/${repoId}/reputation`, []),
  activity: (repoId: string) => get<ApiActivity[]>(`/api/repos/${repoId}/activity`, []),
  globalActivity: () => get<ApiActivity[]>(`/api/activity`, []),
};

export const MIST_PER_SUI = 1_000_000_000;
export const formatSui = (mist: number) => `${(mist / MIST_PER_SUI).toFixed(3)} SUI`;
export const bountyStatusLabel = (s: number) =>
  ["open", "claimed", "paid", "cancelled"][s] ?? "unknown";
