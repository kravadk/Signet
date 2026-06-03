/// Issues for Signet.
///
/// Lightweight issue tracker anchored on Sui. Anyone can open an issue on a repo
/// (issues are public discussion, not privileged writes); the issue author or
/// the repo owner can close it. Comment bodies live in Walrus (blob id), the
/// on-chain object anchors author + status + ordering.
module signet::issue;

use std::string::String;
use sui::event;
use signet::forge::{Self, Repository, RepoOwnerCap};

// ===== Errors =====

const EIssueRepoMismatch: u64 = 0;
const ENotIssueCloser: u64 = 1;
const EIssueNotOpen: u64 = 2;

// ===== Status =====

const STATUS_OPEN: u8 = 0;
const STATUS_CLOSED: u8 = 1;
public fun status_open(): u8 { STATUS_OPEN }
public fun status_closed(): u8 { STATUS_CLOSED }

// ===== Objects =====

/// A repo issue. Shared so comments attach and the UI lists it. `body_blob` is
/// the Walrus blob id of the full markdown body.
public struct Issue has key, store {
    id: UID,
    repo_id: ID,
    author: address,
    title: String,
    body_blob: String,
    status: u8,
    comment_count: u64,
}

/// A comment on an issue. `body_blob` is the Walrus blob id of the text.
public struct IssueComment has key, store {
    id: UID,
    issue_id: ID,
    author: address,
    body_blob: String,
}

// ===== Events =====

public struct IssueOpened has copy, drop {
    issue_id: ID,
    repo_id: ID,
    author: address,
    title: String,
}

public struct IssueClosed has copy, drop {
    issue_id: ID,
    repo_id: ID,
}

public struct IssueCommented has copy, drop {
    comment_id: ID,
    issue_id: ID,
    author: address,
    body_blob: String,
}

// ===== Open / comment / close =====

/// Open an issue on a repo. Permissionless (public discussion).
public fun open_issue(
    repo: &Repository,
    title: String,
    body_blob: String,
    ctx: &mut TxContext,
) {
    let issue = Issue {
        id: object::new(ctx),
        repo_id: object::id(repo),
        author: ctx.sender(),
        title,
        body_blob,
        status: STATUS_OPEN,
        comment_count: 0,
    };
    event::emit(IssueOpened {
        issue_id: object::id(&issue),
        repo_id: issue.repo_id,
        author: issue.author,
        title: issue.title,
    });
    transfer::share_object(issue);
}

/// Comment on an open issue. Permissionless.
public fun comment_issue(issue: &mut Issue, body_blob: String, ctx: &mut TxContext) {
    assert!(issue.status == STATUS_OPEN, EIssueNotOpen);
    let comment = IssueComment {
        id: object::new(ctx),
        issue_id: object::id(issue),
        author: ctx.sender(),
        body_blob,
    };
    issue.comment_count = issue.comment_count + 1;
    event::emit(IssueCommented {
        comment_id: object::id(&comment),
        issue_id: object::id(issue),
        author: comment.author,
        body_blob,
    });
    transfer::share_object(comment);
}

/// Close an issue. Allowed for the issue author (no cap needed).
public fun close_issue(issue: &mut Issue, ctx: &TxContext) {
    assert!(issue.author == ctx.sender(), ENotIssueCloser);
    assert!(issue.status == STATUS_OPEN, EIssueNotOpen);
    issue.status = STATUS_CLOSED;
    event::emit(IssueClosed { issue_id: object::id(issue), repo_id: issue.repo_id });
}

/// Close an issue as the repo owner (moderation).
public fun close_issue_as_owner(repo: &Repository, issue: &mut Issue, cap: &RepoOwnerCap) {
    forge::assert_owner(repo, cap);
    assert!(issue.repo_id == object::id(repo), EIssueRepoMismatch);
    assert!(issue.status == STATUS_OPEN, EIssueNotOpen);
    issue.status = STATUS_CLOSED;
    event::emit(IssueClosed { issue_id: object::id(issue), repo_id: issue.repo_id });
}

// ===== Read accessors =====

public fun issue_repo(i: &Issue): ID { i.repo_id }
public fun issue_author(i: &Issue): address { i.author }
public fun issue_title(i: &Issue): String { i.title }
public fun issue_body(i: &Issue): String { i.body_blob }
public fun issue_status(i: &Issue): u8 { i.status }
public fun issue_comment_count(i: &Issue): u64 { i.comment_count }
public fun comment_issue_id(c: &IssueComment): ID { c.issue_id }
public fun comment_author(c: &IssueComment): address { c.author }
public fun comment_body(c: &IssueComment): String { c.body_blob }
