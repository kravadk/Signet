/// Verifiable releases for Signet — the provenance chain.
///
/// A `Release` ties together the full chain that a hackathon judge can verify:
///   source snapshot  ->  build artifact  ->  test report
/// every element addressed by a Walrus blob id and anchored on Sui. Only the
/// repo owner can publish a release, and publishing records the release id back
/// onto the `Repository` as `latest_release`.
module signet::release;

use std::string::String;
use sui::event;
use signet::forge::{Self, Repository, RepoOwnerCap};
use signet::pull_request::{Self, PullRequest};

// ===== Errors =====

const EPrRepoMismatch: u64 = 0;
const EPrNotMerged: u64 = 1;

// ===== Objects =====

/// An immutable-by-convention release record. Shared so the UI and agents can
/// read the provenance chain. Fields are Walrus blob ids unless noted.
public struct Release has key, store {
    id: UID,
    repo_id: ID,
    /// Semantic version string, e.g. "v0.1.0".
    version: String,
    /// Walrus blob id of the source snapshot this release was built from.
    source_snapshot: String,
    /// Walrus blob id of the build artifact (binary, bytecode, bundle).
    build_artifact: String,
    /// Walrus blob id of the test/CI report proving the build passed.
    test_report: String,
    published_by: address,
}

/// Additive v2 hard-link object. Kept separate from `Release` so historical
/// releases and deployed object layout stay backward compatible.
public struct ReleaseLink has key, store {
    id: UID,
    release_id: ID,
    repo_id: ID,
    merged_pr_id: ID,
}

// ===== Events =====

public struct ReleasePublished has copy, drop {
    release_id: ID,
    repo_id: ID,
    version: String,
    source_snapshot: String,
    build_artifact: String,
    test_report: String,
    published_by: address,
}

public struct ReleaseLinked has copy, drop {
    link_id: ID,
    release_id: ID,
    repo_id: ID,
    merged_pr_id: ID,
}

// ===== Publish (owner only) =====

fun publish_release_internal(
    repo: &mut Repository,
    cap: &RepoOwnerCap,
    version: String,
    source_snapshot: String,
    build_artifact: String,
    test_report: String,
    ctx: &mut TxContext,
): ID {
    forge::assert_owner(repo, cap);

    let release = Release {
        id: object::new(ctx),
        repo_id: object::id(repo),
        version,
        source_snapshot,
        build_artifact,
        test_report,
        published_by: ctx.sender(),
    };
    let release_id = object::id(&release);

    forge::set_latest_release(repo, release_id);

    event::emit(ReleasePublished {
        release_id,
        repo_id: object::id(repo),
        version: release.version,
        source_snapshot: release.source_snapshot,
        build_artifact: release.build_artifact,
        test_report: release.test_report,
        published_by: release.published_by,
    });

    transfer::share_object(release);
    release_id
}

/// Publish a release. Owner-only. Records the full provenance chain and updates
/// the repo's `latest_release` pointer via the package-internal mutator.
public fun publish_release(
    repo: &mut Repository,
    cap: &RepoOwnerCap,
    version: String,
    source_snapshot: String,
    build_artifact: String,
    test_report: String,
    ctx: &mut TxContext,
) {
    publish_release_internal(repo, cap, version, source_snapshot, build_artifact, test_report, ctx);
}

/// Publish a release with an explicit merged-PR hard link. This is the preferred
/// v2 path: the release source is taken from the merged PR head, so verifiers do
/// not need to infer the link by scanning historical `PrMerged` events.
public fun publish_release_v2(
    repo: &mut Repository,
    cap: &RepoOwnerCap,
    merged_pr: &PullRequest,
    version: String,
    build_artifact: String,
    test_report: String,
    ctx: &mut TxContext,
) {
    assert!(pull_request::pr_repo(merged_pr) == object::id(repo), EPrRepoMismatch);
    assert!(pull_request::pr_status(merged_pr) == pull_request::status_merged(), EPrNotMerged);

    let repo_id = object::id(repo);
    let merged_pr_id = object::id(merged_pr);
    let release_id = publish_release_internal(
        repo,
        cap,
        version,
        pull_request::pr_head(merged_pr),
        build_artifact,
        test_report,
        ctx,
    );
    let link = ReleaseLink { id: object::new(ctx), release_id, repo_id, merged_pr_id };
    let link_id = object::id(&link);
    event::emit(ReleaseLinked { link_id, release_id, repo_id, merged_pr_id });
    transfer::share_object(link);
}

// ===== Read accessors (the provenance chain, for UI/agents) =====

public fun release_repo(r: &Release): ID { r.repo_id }
public fun release_version(r: &Release): String { r.version }
public fun release_source(r: &Release): String { r.source_snapshot }
public fun release_artifact(r: &Release): String { r.build_artifact }
public fun release_test_report(r: &Release): String { r.test_report }
public fun release_publisher(r: &Release): address { r.published_by }
public fun link_release(l: &ReleaseLink): ID { l.release_id }
public fun link_repo(l: &ReleaseLink): ID { l.repo_id }
public fun link_merged_pr(l: &ReleaseLink): ID { l.merged_pr_id }
