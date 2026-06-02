/// Agent reputation for WalrusForge.
///
/// Each agent (or human) accrues a verifiable on-chain `AgentProfile` scoped to a
/// repository: how many PRs they opened, how many got merged, how many reviews
/// they submitted, and how many CI runs they reported. Counters are bumped only
/// by sibling modules through `public(package)` hooks, so reputation cannot be
/// forged — it is a side effect of real, signed actions.
module walrusforge::reputation;

use sui::table::{Self, Table};
use sui::vec_set::{Self, VecSet};
use sui::event;

// ===== Errors =====

const EVouchSelf: u64 = 0;
const EVouchTwice: u64 = 1;
const EVouchScoreTooLow: u64 = 2;

/// Minimum score required to vouch for another agent (anti-sybil).
const VOUCH_MIN_SCORE: u64 = 10;

// ===== Score weights (aggregate trust score) =====
const W_PR_MERGED: u64 = 10;
const W_REVIEW: u64 = 3;
const W_CI_RUN: u64 = 2;
const W_VOUCH: u64 = 5;

// ===== Objects =====

/// Per-repo reputation ledger. Shared so anyone can read an agent's standing and
/// sibling modules can bump it. Keyed by agent address.
public struct RepoReputation has key {
    id: UID,
    repo_id: ID,
    profiles: Table<address, AgentProfile>,
    /// Records who vouched for whom to prevent double-vouch (key = voucher).
    vouch_pairs: VecSet<vector<u8>>,
}

/// One agent's tallies within a repo. `store`d inside the Table.
/// `score` is a derived aggregate (recomputed on every bump) so the UI can sort
/// and gate cheaply. `last_epoch` records the most recent activity (soft decay).
public struct AgentProfile has store, copy, drop {
    prs_opened: u64,
    prs_merged: u64,
    reviews: u64,
    ci_runs: u64,
    vouches: u64,
    score: u64,
    last_epoch: u64,
}

// ===== Events =====

public struct ReputationUpdated has copy, drop {
    repo_id: ID,
    agent: address,
    prs_opened: u64,
    prs_merged: u64,
    reviews: u64,
    ci_runs: u64,
    vouches: u64,
    score: u64,
    last_epoch: u64,
}

public struct AgentVouched has copy, drop {
    repo_id: ID,
    voucher: address,
    subject: address,
}

// ===== Creation =====

/// Create the reputation ledger for a repo. Called once at repo creation by the
/// forge module (package-internal).
public(package) fun new_ledger(repo_id: ID, ctx: &mut TxContext): RepoReputation {
    RepoReputation {
        id: object::new(ctx),
        repo_id,
        profiles: table::new(ctx),
        vouch_pairs: vec_set::empty(),
    }
}

/// Deterministic aggregate trust score from an agent's tallies.
fun compute_score(p: &AgentProfile): u64 {
    p.prs_merged * W_PR_MERGED + p.reviews * W_REVIEW + p.ci_runs * W_CI_RUN + p.vouches * W_VOUCH
}

public(package) fun share_ledger(ledger: RepoReputation) {
    transfer::share_object(ledger);
}

// ===== Counter bumps (package-internal; called from pull_request) =====

fun ensure(ledger: &mut RepoReputation, agent: address): &mut AgentProfile {
    if (!table::contains(&ledger.profiles, agent)) {
        table::add(
            &mut ledger.profiles,
            agent,
            AgentProfile { prs_opened: 0, prs_merged: 0, reviews: 0, ci_runs: 0, vouches: 0, score: 0, last_epoch: 0 },
        );
    };
    table::borrow_mut(&mut ledger.profiles, agent)
}

/// Recompute the derived score + stamp the activity epoch. Call after any bump.
fun refresh(p: &mut AgentProfile, ctx: &TxContext) {
    p.score = compute_score(p);
    p.last_epoch = ctx.epoch();
}

fun emit(ledger: &RepoReputation, agent: address, p: &AgentProfile) {
    event::emit(ReputationUpdated {
        repo_id: ledger.repo_id,
        agent,
        prs_opened: p.prs_opened,
        prs_merged: p.prs_merged,
        reviews: p.reviews,
        ci_runs: p.ci_runs,
        vouches: p.vouches,
        score: p.score,
        last_epoch: p.last_epoch,
    });
}

public(package) fun bump_pr_opened(ledger: &mut RepoReputation, agent: address, ctx: &TxContext) {
    let p = ensure(ledger, agent);
    p.prs_opened = p.prs_opened + 1;
    refresh(p, ctx);
    let snapshot = *p;
    emit(ledger, agent, &snapshot);
}

public(package) fun bump_pr_merged(ledger: &mut RepoReputation, agent: address, ctx: &TxContext) {
    let p = ensure(ledger, agent);
    p.prs_merged = p.prs_merged + 1;
    refresh(p, ctx);
    let snapshot = *p;
    emit(ledger, agent, &snapshot);
}

public(package) fun bump_review(ledger: &mut RepoReputation, agent: address, ctx: &TxContext) {
    let p = ensure(ledger, agent);
    p.reviews = p.reviews + 1;
    refresh(p, ctx);
    let snapshot = *p;
    emit(ledger, agent, &snapshot);
}

public(package) fun bump_ci_run(ledger: &mut RepoReputation, agent: address, ctx: &TxContext) {
    let p = ensure(ledger, agent);
    p.ci_runs = p.ci_runs + 1;
    refresh(p, ctx);
    let snapshot = *p;
    emit(ledger, agent, &snapshot);
}

// ===== Vouching (permissionless, gated by voucher's own score) =====

/// Vouch for another agent in this repo. The voucher must already have a score
/// ≥ VOUCH_MIN_SCORE; cannot vouch for self; cannot vouch for the same subject
/// twice. Bumps the subject's `vouches` (and thus score).
public fun vouch(ledger: &mut RepoReputation, subject: address, ctx: &mut TxContext) {
    let voucher = ctx.sender();
    assert!(voucher != subject, EVouchSelf);
    assert!(score_of(ledger, voucher) >= VOUCH_MIN_SCORE, EVouchScoreTooLow);

    // pair key = voucher bytes ++ subject bytes (unique per ordered pair)
    let mut key = sui::address::to_bytes(voucher);
    vector::append(&mut key, sui::address::to_bytes(subject));
    assert!(!vec_set::contains(&ledger.vouch_pairs, &key), EVouchTwice);
    vec_set::insert(&mut ledger.vouch_pairs, key);

    let p = ensure(ledger, subject);
    p.vouches = p.vouches + 1;
    refresh(p, ctx);
    let snapshot = *p;
    emit(ledger, subject, &snapshot);

    event::emit(AgentVouched { repo_id: ledger.repo_id, voucher, subject });
}

// ===== Read accessors =====

public fun ledger_repo(ledger: &RepoReputation): ID { ledger.repo_id }

public fun profile(ledger: &RepoReputation, agent: address): AgentProfile {
    if (table::contains(&ledger.profiles, agent)) {
        *table::borrow(&ledger.profiles, agent)
    } else {
        AgentProfile { prs_opened: 0, prs_merged: 0, reviews: 0, ci_runs: 0, vouches: 0, score: 0, last_epoch: 0 }
    }
}

/// Aggregate score for an agent (0 if unknown). Used by gates (bounty lock,
/// vouch threshold) and runner selection.
public fun score_of(ledger: &RepoReputation, agent: address): u64 {
    if (table::contains(&ledger.profiles, agent)) {
        table::borrow(&ledger.profiles, agent).score
    } else { 0 }
}

/// Transparent runner selection: of the candidate addresses, return the one with
/// the highest score (first wins on tie). Aborts if the list is empty.
public fun top_runner(ledger: &RepoReputation, candidates: vector<address>): address {
    let n = vector::length(&candidates);
    assert!(n > 0, 100);
    let mut best = *vector::borrow(&candidates, 0);
    let mut best_score = score_of(ledger, best);
    let mut i = 1;
    while (i < n) {
        let c = *vector::borrow(&candidates, i);
        let s = score_of(ledger, c);
        if (s > best_score) { best = c; best_score = s; };
        i = i + 1;
    };
    best
}

public fun prs_opened(p: &AgentProfile): u64 { p.prs_opened }
public fun prs_merged(p: &AgentProfile): u64 { p.prs_merged }
public fun reviews(p: &AgentProfile): u64 { p.reviews }
public fun ci_runs(p: &AgentProfile): u64 { p.ci_runs }
public fun vouches(p: &AgentProfile): u64 { p.vouches }
public fun score(p: &AgentProfile): u64 { p.score }
public fun last_epoch(p: &AgentProfile): u64 { p.last_epoch }
