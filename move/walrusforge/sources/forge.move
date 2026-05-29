/// WalrusForge — agent-native release network on Sui + Walrus.
///
/// `forge` is the core module: it owns the shared registry, the `Repository`
/// object (refs + provenance anchors), and the capability model that gates who
/// can do what. Source code, diffs, reports and artifacts live in Walrus; this
/// module stores only Walrus blob ids, hashes and permissions.
module walrusforge::forge;

use std::string::String;
use sui::event;
use sui::table::{Self, Table};
use sui::vec_set::{Self, VecSet};

// ===== Errors =====

const ENotRepoOwner: u64 = 0;
const EAgentCannotMerge: u64 = 1;
const ECapRepoMismatch: u64 = 2;
const ECapMissingScope: u64 = 3;
const ECapExpired: u64 = 4;
const ENameTaken: u64 = 5;
const ECapRevoked: u64 = 6;

// ===== Agent capability scopes (bitflags) =====

const SCOPE_OPEN_PR: u8 = 1; // 0b001
const SCOPE_REVIEW: u8 = 2; // 0b010
const SCOPE_RUN_CI: u8 = 4; // 0b100

// Public accessors so sibling modules / clients can build scope masks.
public fun scope_open_pr(): u8 { SCOPE_OPEN_PR }
public fun scope_review(): u8 { SCOPE_REVIEW }
public fun scope_run_ci(): u8 { SCOPE_RUN_CI }

// ===== Objects =====

/// Shared registry of all repositories created through WalrusForge.
/// `names` enforces globally-unique repo names for a clean demo namespace.
public struct ForgeRegistry has key {
    id: UID,
    repo_count: u64,
    names: Table<String, ID>,
}

/// A repository. Holds metadata + the *current* ref (a Walrus snapshot) and a
/// pointer to the latest published release. The actual tree/objects are in
/// Walrus, addressed by `current_snapshot`.
public struct Repository has key, store {
    id: UID,
    name: String,
    owner: address,
    default_branch: String,
    /// Walrus blob id of the current snapshot manifest for `default_branch`.
    current_snapshot: String,
    /// Monotonic ref version; increments on every merge/ref update.
    ref_version: u64,
    /// ID of the latest `Release` object, if any.
    latest_release: Option<ID>,
    /// AgentCap ids the owner has revoked. Checked in `assert_agent_scope`, so
    /// the owner can disable a delegated agent without holding its object.
    revoked_caps: VecSet<ID>,
}

/// Owner permission: update refs, merge PRs, publish releases. Soulbound to the
/// repo via `repo_id`. Transferable so ownership can move, but only the holder
/// can perform privileged actions.
public struct RepoOwnerCap has key, store {
    id: UID,
    repo_id: ID,
}

/// Delegated, scoped permission for an agent (or human collaborator).
/// `scopes` is a bitmask of SCOPE_* flags. `expires_at_epoch` allows TTL-style
/// revocation: 0 means never expires.
public struct AgentCap has key, store {
    id: UID,
    repo_id: ID,
    scopes: u8,
    expires_at_epoch: u64,
    label: String,
}

// ===== Events (provenance trail) =====

public struct RepoCreated has copy, drop {
    repo_id: ID,
    name: String,
    owner: address,
    snapshot: String,
}

public struct RefUpdated has copy, drop {
    repo_id: ID,
    new_snapshot: String,
    ref_version: u64,
}

public struct AgentCapGranted has copy, drop {
    repo_id: ID,
    cap_id: ID,
    recipient: address,
    scopes: u8,
    expires_at_epoch: u64,
}

public struct AgentCapRevoked has copy, drop {
    repo_id: ID,
    cap_id: ID,
}

// ===== Init: publish the shared registry once =====

fun init(ctx: &mut TxContext) {
    transfer::share_object(ForgeRegistry {
        id: object::new(ctx),
        repo_count: 0,
        names: table::new(ctx),
    });
}

// ===== Repository lifecycle =====

/// Create a repository. The caller becomes owner and receives a `RepoOwnerCap`.
/// The `Repository` is a shared object so PRs, reviews and the UI can read it.
#[allow(lint(self_transfer))]
public fun create_repo(
    registry: &mut ForgeRegistry,
    name: String,
    default_branch: String,
    initial_snapshot: String,
    ctx: &mut TxContext,
) {
    assert!(!table::contains(&registry.names, name), ENameTaken);

    let owner = ctx.sender();
    let repo = Repository {
        id: object::new(ctx),
        name,
        owner,
        default_branch,
        current_snapshot: initial_snapshot,
        ref_version: 0,
        latest_release: option::none(),
        revoked_caps: vec_set::empty(),
    };
    let repo_id = object::id(&repo);

    table::add(&mut registry.names, repo.name, repo_id);
    registry.repo_count = registry.repo_count + 1;

    event::emit(RepoCreated {
        repo_id,
        name: repo.name,
        owner,
        snapshot: repo.current_snapshot,
    });

    transfer::transfer(
        RepoOwnerCap { id: object::new(ctx), repo_id },
        owner,
    );

    // Stand up the agent-reputation ledger alongside the repo.
    walrusforge::reputation::share_ledger(
        walrusforge::reputation::new_ledger(repo_id, ctx),
    );

    transfer::share_object(repo);
}

/// Update the current ref to a new Walrus snapshot. Owner-only — this is the
/// privileged action a merge ultimately performs.
public fun update_ref(
    repo: &mut Repository,
    cap: &RepoOwnerCap,
    new_snapshot: String,
) {
    assert_owner(repo, cap);
    repo.current_snapshot = new_snapshot;
    repo.ref_version = repo.ref_version + 1;
    event::emit(RefUpdated {
        repo_id: object::id(repo),
        new_snapshot: repo.current_snapshot,
        ref_version: repo.ref_version,
    });
}

// ===== Capability granting =====

/// Owner grants a scoped `AgentCap` to `recipient`. `scopes` is a bitmask built
/// from scope_* helpers; never includes merge/publish — those stay owner-only.
public fun grant_agent_cap(
    repo: &Repository,
    cap: &RepoOwnerCap,
    recipient: address,
    scopes: u8,
    expires_at_epoch: u64,
    label: String,
    ctx: &mut TxContext,
) {
    assert_owner(repo, cap);
    let agent_cap = AgentCap {
        id: object::new(ctx),
        repo_id: object::id(repo),
        scopes,
        expires_at_epoch,
        label,
    };
    event::emit(AgentCapGranted {
        repo_id: object::id(repo),
        cap_id: object::id(&agent_cap),
        recipient,
        scopes,
        expires_at_epoch,
    });
    transfer::transfer(agent_cap, recipient);
}

/// Owner revokes a previously-granted `AgentCap` by id. Idempotent. The agent
/// keeps the object but can no longer pass `assert_agent_scope`. This is the
/// instant kill-switch complementing the cap's epoch TTL.
public fun revoke_agent_cap(
    repo: &mut Repository,
    cap: &RepoOwnerCap,
    agent_cap_id: ID,
) {
    assert_owner(repo, cap);
    if (!vec_set::contains(&repo.revoked_caps, &agent_cap_id)) {
        vec_set::insert(&mut repo.revoked_caps, agent_cap_id);
    };
    event::emit(AgentCapRevoked { repo_id: object::id(repo), cap_id: agent_cap_id });
}

// ===== Authorization helpers (used here and by sibling modules) =====

/// Abort unless `cap` is the owner cap for `repo`.
public fun assert_owner(repo: &Repository, cap: &RepoOwnerCap) {
    assert!(cap.repo_id == object::id(repo), ENotRepoOwner);
}

/// Abort unless `cap` belongs to `repo`, carries `required_scope`, and is not
/// expired at the current epoch. Used to gate PR/review/CI actions.
public fun assert_agent_scope(
    repo: &Repository,
    cap: &AgentCap,
    required_scope: u8,
    ctx: &TxContext,
) {
    assert!(cap.repo_id == object::id(repo), ECapRepoMismatch);
    assert!(!vec_set::contains(&repo.revoked_caps, &object::id(cap)), ECapRevoked);
    assert!(cap.scopes & required_scope == required_scope, ECapMissingScope);
    assert!(
        cap.expires_at_epoch == 0 || ctx.epoch() < cap.expires_at_epoch,
        ECapExpired,
    );
}

/// Explicit guard documenting that an `AgentCap` can never authorize a merge.
/// Sibling merge logic calls owner checks; this exists so the rule is testable
/// and self-documenting.
public fun assert_not_agent_merge(_cap: &AgentCap) {
    abort EAgentCannotMerge
}

// ===== Mutators reserved for sibling modules within the package =====

/// Record the latest release id on the repo. Package-internal: only callable by
/// the release module via a `public(package)` boundary.
public(package) fun set_latest_release(repo: &mut Repository, release_id: ID) {
    repo.latest_release = option::some(release_id);
}

// ===== Read accessors =====

public fun repo_owner(repo: &Repository): address { repo.owner }
public fun repo_name(repo: &Repository): String { repo.name }
public fun current_snapshot(repo: &Repository): String { repo.current_snapshot }
public fun ref_version(repo: &Repository): u64 { repo.ref_version }
public fun default_branch(repo: &Repository): String { repo.default_branch }
public fun latest_release(repo: &Repository): Option<ID> { repo.latest_release }
public fun repo_count(registry: &ForgeRegistry): u64 { registry.repo_count }
public fun owner_cap_repo(cap: &RepoOwnerCap): ID { cap.repo_id }
public fun agent_cap_repo(cap: &AgentCap): ID { cap.repo_id }
public fun agent_cap_scopes(cap: &AgentCap): u8 { cap.scopes }
public fun agent_cap_id(cap: &AgentCap): ID { object::id(cap) }
public fun is_cap_revoked(repo: &Repository, agent_cap_id: ID): bool {
    vec_set::contains(&repo.revoked_caps, &agent_cap_id)
}

// ===== Test-only init exposure =====

#[test_only]
public fun init_for_testing(ctx: &mut TxContext) {
    init(ctx);
}
