/// Agent reputation for WalrusForge.
///
/// Each agent (or human) accrues a verifiable on-chain `AgentProfile` scoped to a
/// repository: how many PRs they opened, how many got merged, how many reviews
/// they submitted, and how many CI runs they reported. Counters are bumped only
/// by sibling modules through `public(package)` hooks, so reputation cannot be
/// forged — it is a side effect of real, signed actions.
module walrusforge::reputation;

use sui::table::{Self, Table};
use sui::event;

// ===== Objects =====

/// Per-repo reputation ledger. Shared so anyone can read an agent's standing and
/// sibling modules can bump it. Keyed by agent address.
public struct RepoReputation has key {
    id: UID,
    repo_id: ID,
    profiles: Table<address, AgentProfile>,
}

/// One agent's tallies within a repo. `store`d inside the Table.
public struct AgentProfile has store, copy, drop {
    prs_opened: u64,
    prs_merged: u64,
    reviews: u64,
    ci_runs: u64,
}

// ===== Events =====

public struct ReputationUpdated has copy, drop {
    repo_id: ID,
    agent: address,
    prs_opened: u64,
    prs_merged: u64,
    reviews: u64,
    ci_runs: u64,
}

// ===== Creation =====

/// Create the reputation ledger for a repo. Called once at repo creation by the
/// forge module (package-internal).
public(package) fun new_ledger(repo_id: ID, ctx: &mut TxContext): RepoReputation {
    RepoReputation { id: object::new(ctx), repo_id, profiles: table::new(ctx) }
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
            AgentProfile { prs_opened: 0, prs_merged: 0, reviews: 0, ci_runs: 0 },
        );
    };
    table::borrow_mut(&mut ledger.profiles, agent)
}

fun emit(ledger: &RepoReputation, agent: address, p: &AgentProfile) {
    event::emit(ReputationUpdated {
        repo_id: ledger.repo_id,
        agent,
        prs_opened: p.prs_opened,
        prs_merged: p.prs_merged,
        reviews: p.reviews,
        ci_runs: p.ci_runs,
    });
}

public(package) fun bump_pr_opened(ledger: &mut RepoReputation, agent: address) {
    let p = ensure(ledger, agent);
    p.prs_opened = p.prs_opened + 1;
    let snapshot = *p;
    emit(ledger, agent, &snapshot);
}

public(package) fun bump_pr_merged(ledger: &mut RepoReputation, agent: address) {
    let p = ensure(ledger, agent);
    p.prs_merged = p.prs_merged + 1;
    let snapshot = *p;
    emit(ledger, agent, &snapshot);
}

public(package) fun bump_review(ledger: &mut RepoReputation, agent: address) {
    let p = ensure(ledger, agent);
    p.reviews = p.reviews + 1;
    let snapshot = *p;
    emit(ledger, agent, &snapshot);
}

public(package) fun bump_ci_run(ledger: &mut RepoReputation, agent: address) {
    let p = ensure(ledger, agent);
    p.ci_runs = p.ci_runs + 1;
    let snapshot = *p;
    emit(ledger, agent, &snapshot);
}

// ===== Read accessors =====

public fun ledger_repo(ledger: &RepoReputation): ID { ledger.repo_id }

public fun profile(ledger: &RepoReputation, agent: address): AgentProfile {
    if (table::contains(&ledger.profiles, agent)) {
        *table::borrow(&ledger.profiles, agent)
    } else {
        AgentProfile { prs_opened: 0, prs_merged: 0, reviews: 0, ci_runs: 0 }
    }
}

public fun prs_opened(p: &AgentProfile): u64 { p.prs_opened }
public fun prs_merged(p: &AgentProfile): u64 { p.prs_merged }
public fun reviews(p: &AgentProfile): u64 { p.reviews }
public fun ci_runs(p: &AgentProfile): u64 { p.ci_runs }
