/// Pull requests and reviews for Signet.
///
/// A `PullRequest` proposes moving a repo's ref from a `base_snapshot` to a
/// `head_snapshot` (both Walrus blob ids). Agents with the `open_pr` scope can
/// create PRs; agents with the `review` scope can attach signed reviews. Only
/// the repo owner can merge — merging updates the repo ref via `forge`.
module signet::pull_request;

use std::string::String;
use sui::event;
use signet::forge::{Self, Repository, RepoOwnerCap, AgentCap};
use signet::reputation::{Self, RepoReputation};

// ===== Errors =====

const EPrRepoMismatch: u64 = 0;
const EPrNotOpen: u64 = 1;
const EBaseStale: u64 = 2;
const ENotEnoughApprovals: u64 = 3;

// ===== PR status =====

const STATUS_OPEN: u8 = 0;
const STATUS_MERGED: u8 = 1;
const STATUS_CLOSED: u8 = 2;

public fun status_open(): u8 { STATUS_OPEN }
public fun status_merged(): u8 { STATUS_MERGED }
public fun status_closed(): u8 { STATUS_CLOSED }

// ===== Review verdicts =====

const VERDICT_APPROVE: u8 = 1;
const VERDICT_REQUEST_CHANGES: u8 = 2;
const VERDICT_COMMENT: u8 = 3;

public fun verdict_approve(): u8 { VERDICT_APPROVE }
public fun verdict_request_changes(): u8 { VERDICT_REQUEST_CHANGES }
public fun verdict_comment(): u8 { VERDICT_COMMENT }

// ===== Objects =====

/// A pull request. Shared so reviews can be attached and the UI can read it.
/// `diff_manifest` is the Walrus blob id of the diff/manifest describing the
/// change from base to head.
public struct PullRequest has key, store {
    id: UID,
    repo_id: ID,
    author: address,
    base_snapshot: String,
    head_snapshot: String,
    diff_manifest: String,
    title: String,
    status: u8,
    /// Walrus blob ids of attached review reports (for quick UI listing).
    review_refs: vector<String>,
    /// Count of reviews with the APPROVE verdict — used to gate merge.
    approvals: u64,
}

/// A review attached to a PR. `report_blob` is the Walrus blob id of the full
/// review/test report; the on-chain object anchors reviewer identity + verdict.
public struct Review has key, store {
    id: UID,
    pr_id: ID,
    reviewer: address,
    verdict: u8,
    report_blob: String,
}

// ===== Events =====

public struct PrOpened has copy, drop {
    pr_id: ID,
    repo_id: ID,
    author: address,
    base_snapshot: String,
    head_snapshot: String,
}

public struct ReviewSubmitted has copy, drop {
    review_id: ID,
    pr_id: ID,
    reviewer: address,
    verdict: u8,
    report_blob: String,
}

public struct PrMerged has copy, drop {
    pr_id: ID,
    repo_id: ID,
    merged_snapshot: String,
}

public struct PrClosed has copy, drop {
    pr_id: ID,
    repo_id: ID,
}

// ===== Open a PR (agent with open_pr scope, or owner) =====

/// Open a PR using an `AgentCap` that carries the `open_pr` scope. The PR's
/// base is pinned to the repo's current snapshot at creation time.
public fun open_pr_as_agent(
    repo: &Repository,
    rep: &mut RepoReputation,
    cap: &AgentCap,
    head_snapshot: String,
    diff_manifest: String,
    title: String,
    ctx: &mut TxContext,
) {
    forge::assert_agent_scope(repo, cap, forge::scope_open_pr(), ctx);
    open_pr_internal(repo, rep, head_snapshot, diff_manifest, title, ctx);
}

/// Owner can open a PR directly with their owner cap (no agent scope needed).
public fun open_pr_as_owner(
    repo: &Repository,
    rep: &mut RepoReputation,
    cap: &RepoOwnerCap,
    head_snapshot: String,
    diff_manifest: String,
    title: String,
    ctx: &mut TxContext,
) {
    forge::assert_owner(repo, cap);
    open_pr_internal(repo, rep, head_snapshot, diff_manifest, title, ctx);
}

fun open_pr_internal(
    repo: &Repository,
    rep: &mut RepoReputation,
    head_snapshot: String,
    diff_manifest: String,
    title: String,
    ctx: &mut TxContext,
) {
    let pr = PullRequest {
        id: object::new(ctx),
        repo_id: object::id(repo),
        author: ctx.sender(),
        base_snapshot: forge::current_snapshot(repo),
        head_snapshot,
        diff_manifest,
        title,
        status: STATUS_OPEN,
        review_refs: vector[],
        approvals: 0,
    };
    event::emit(PrOpened {
        pr_id: object::id(&pr),
        repo_id: pr.repo_id,
        author: pr.author,
        base_snapshot: pr.base_snapshot,
        head_snapshot: pr.head_snapshot,
    });
    reputation::bump_pr_opened(rep, ctx.sender(), ctx);
    transfer::share_object(pr);
}

// ===== Submit a review (agent with review scope, or owner) =====

/// Attach a review to a PR using an `AgentCap` with the `review` scope.
public fun submit_review_as_agent(
    repo: &Repository,
    rep: &mut RepoReputation,
    pr: &mut PullRequest,
    cap: &AgentCap,
    verdict: u8,
    report_blob: String,
    ctx: &mut TxContext,
) {
    forge::assert_agent_scope(repo, cap, forge::scope_review(), ctx);
    submit_review_internal(repo, rep, pr, verdict, report_blob, ctx);
}

/// Owner can review directly.
public fun submit_review_as_owner(
    repo: &Repository,
    rep: &mut RepoReputation,
    pr: &mut PullRequest,
    cap: &RepoOwnerCap,
    verdict: u8,
    report_blob: String,
    ctx: &mut TxContext,
) {
    forge::assert_owner(repo, cap);
    submit_review_internal(repo, rep, pr, verdict, report_blob, ctx);
}

fun submit_review_internal(
    repo: &Repository,
    rep: &mut RepoReputation,
    pr: &mut PullRequest,
    verdict: u8,
    report_blob: String,
    ctx: &mut TxContext,
) {
    assert!(pr.repo_id == object::id(repo), EPrRepoMismatch);
    assert!(pr.status == STATUS_OPEN, EPrNotOpen);

    let review = Review {
        id: object::new(ctx),
        pr_id: object::id(pr),
        reviewer: ctx.sender(),
        verdict,
        report_blob,
    };
    vector::push_back(&mut pr.review_refs, report_blob);
    if (verdict == VERDICT_APPROVE) { pr.approvals = pr.approvals + 1; };
    event::emit(ReviewSubmitted {
        review_id: object::id(&review),
        pr_id: object::id(pr),
        reviewer: review.reviewer,
        verdict,
        report_blob,
    });
    reputation::bump_review(rep, ctx.sender(), ctx);
    transfer::share_object(review);
}

// ===== Merge (owner only) =====

/// Merge a PR: advance the repo ref to the PR's head snapshot. Owner-only.
/// Aborts if the PR's base no longer matches the repo's current snapshot,
/// preventing a stale merge from silently clobbering newer work.
public fun merge_pr(
    repo: &mut Repository,
    rep: &mut RepoReputation,
    pr: &mut PullRequest,
    cap: &RepoOwnerCap,
    ctx: &TxContext,
) {
    forge::assert_owner(repo, cap);
    assert!(pr.repo_id == object::id(repo), EPrRepoMismatch);
    assert!(pr.status == STATUS_OPEN, EPrNotOpen);
    assert!(pr.base_snapshot == forge::current_snapshot(repo), EBaseStale);
    // Enforced review threshold: the repo's min_approvals must be met. Owner
    // still merges, but cannot bypass the approvals gate they configured.
    assert!(pr.approvals >= (forge::min_approvals(repo) as u64), ENotEnoughApprovals);

    forge::update_ref(repo, cap, pr.head_snapshot);
    pr.status = STATUS_MERGED;

    event::emit(PrMerged {
        pr_id: object::id(pr),
        repo_id: pr.repo_id,
        merged_snapshot: pr.head_snapshot,
    });
    // Credit the PR author with a merged PR.
    reputation::bump_pr_merged(rep, pr.author, ctx);
}

/// Close a PR without merging. Owner-only.
public fun close_pr(repo: &Repository, pr: &mut PullRequest, cap: &RepoOwnerCap) {
    forge::assert_owner(repo, cap);
    assert!(pr.repo_id == object::id(repo), EPrRepoMismatch);
    assert!(pr.status == STATUS_OPEN, EPrNotOpen);
    pr.status = STATUS_CLOSED;
    event::emit(PrClosed { pr_id: object::id(pr), repo_id: pr.repo_id });
}

// ===== Read accessors =====

public fun pr_status(pr: &PullRequest): u8 { pr.status }
public fun pr_author(pr: &PullRequest): address { pr.author }
public fun pr_base(pr: &PullRequest): String { pr.base_snapshot }
public fun pr_head(pr: &PullRequest): String { pr.head_snapshot }
public fun pr_diff_manifest(pr: &PullRequest): String { pr.diff_manifest }
public fun pr_repo(pr: &PullRequest): ID { pr.repo_id }
public fun pr_review_count(pr: &PullRequest): u64 { vector::length(&pr.review_refs) }
public fun pr_approvals(pr: &PullRequest): u64 { pr.approvals }
public fun review_verdict(r: &Review): u8 { r.verdict }
public fun review_reporter(r: &Review): address { r.reviewer }
public fun review_blob(r: &Review): String { r.report_blob }
