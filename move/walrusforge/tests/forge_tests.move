#[test_only]
module walrusforge::forge_tests;

use std::string;
use sui::test_scenario::{Self as ts, Scenario};
use sui::coin;
use sui::sui::SUI;
use walrusforge::forge::{Self, ForgeRegistry, Repository, RepoOwnerCap, AgentCap};
use walrusforge::reputation::{Self, RepoReputation};
use walrusforge::pull_request::{Self as pr, PullRequest};
use walrusforge::release::{Self, Release};
use walrusforge::issue::{Self, Issue};
use walrusforge::bounty::{Self, Bounty};

const OWNER: address = @0xA;
const AGENT: address = @0xB;
const FUNDER: address = @0xD;

fun s(b: vector<u8>): string::String { string::utf8(b) }

/// Bootstrap: publish registry, create a repo owned by OWNER.
fun setup(): Scenario {
    let mut scen = ts::begin(OWNER);
    {
        forge::init_for_testing(scen.ctx());
    };
    scen.next_tx(OWNER);
    {
        let mut registry = scen.take_shared<ForgeRegistry>();
        forge::create_repo(
            &mut registry,
            s(b"counter-move-demo"),
            s(b"main"),
            s(b"blob_init"),
            scen.ctx(),
        );
        ts::return_shared(registry);
    };
    scen
}

fun grant_pr_review_cap(scen: &mut Scenario) {
    scen.next_tx(OWNER);
    {
        let repo = scen.take_shared<Repository>();
        let cap = scen.take_from_sender<RepoOwnerCap>();
        let scopes = forge::scope_open_pr() | forge::scope_review();
        forge::grant_agent_cap(&repo, &cap, AGENT, scopes, 0, s(b"ci-bot"), scen.ctx());
        scen.return_to_sender(cap);
        ts::return_shared(repo);
    };
}

#[test]
fun test_create_repo_sets_initial_state() {
    let mut scen = setup();
    scen.next_tx(OWNER);
    {
        let repo = scen.take_shared<Repository>();
        assert!(forge::repo_owner(&repo) == OWNER, 100);
        assert!(forge::current_snapshot(&repo) == s(b"blob_init"), 101);
        assert!(forge::ref_version(&repo) == 0, 102);
        assert!(forge::latest_release(&repo).is_none(), 103);
        ts::return_shared(repo);
    };
    scen.end();
}

#[test]
fun test_owner_can_update_ref() {
    let mut scen = setup();
    scen.next_tx(OWNER);
    {
        let mut repo = scen.take_shared<Repository>();
        let cap = scen.take_from_sender<RepoOwnerCap>();
        forge::update_ref(&mut repo, &cap, s(b"blob_v2"));
        assert!(forge::current_snapshot(&repo) == s(b"blob_v2"), 200);
        assert!(forge::ref_version(&repo) == 1, 201);
        scen.return_to_sender(cap);
        ts::return_shared(repo);
    };
    scen.end();
}

#[test]
fun test_agent_can_open_pr_with_scope() {
    let mut scen = setup();
    grant_pr_review_cap(&mut scen);
    scen.next_tx(AGENT);
    {
        let repo = scen.take_shared<Repository>();
        let mut rep = scen.take_shared<RepoReputation>();
        let cap = scen.take_from_sender<AgentCap>();
        pr::open_pr_as_agent(&repo, &mut rep, &cap, s(b"blob_head"), s(b"blob_diff"), s(b"fix"), scen.ctx());
        scen.return_to_sender(cap);
        ts::return_shared(rep);
        ts::return_shared(repo);
    };
    scen.next_tx(AGENT);
    {
        let pull = scen.take_shared<PullRequest>();
        assert!(pr::pr_base(&pull) == s(b"blob_init"), 300);
        assert!(pr::pr_head(&pull) == s(b"blob_head"), 301);
        assert!(pr::pr_status(&pull) == pr::status_open(), 302);
        assert!(pr::pr_author(&pull) == AGENT, 303);
        ts::return_shared(pull);
    };
    scen.end();
}

#[test]
#[expected_failure(abort_code = walrusforge::forge::ECapMissingScope)]
fun test_agent_without_pr_scope_cannot_open_pr() {
    let mut scen = setup();
    scen.next_tx(OWNER);
    {
        let repo = scen.take_shared<Repository>();
        let cap = scen.take_from_sender<RepoOwnerCap>();
        forge::grant_agent_cap(&repo, &cap, AGENT, forge::scope_review(), 0, s(b"r"), scen.ctx());
        scen.return_to_sender(cap);
        ts::return_shared(repo);
    };
    scen.next_tx(AGENT);
    {
        let repo = scen.take_shared<Repository>();
        let mut rep = scen.take_shared<RepoReputation>();
        let cap = scen.take_from_sender<AgentCap>();
        pr::open_pr_as_agent(&repo, &mut rep, &cap, s(b"h"), s(b"d"), s(b"no"), scen.ctx());
        scen.return_to_sender(cap);
        ts::return_shared(rep);
        ts::return_shared(repo);
    };
    scen.end();
}

#[test]
#[expected_failure(abort_code = walrusforge::forge::ECapExpired)]
fun test_expired_cap_cannot_open_pr() {
    let mut scen = setup();
    scen.next_tx(OWNER);
    {
        let repo = scen.take_shared<Repository>();
        let cap = scen.take_from_sender<RepoOwnerCap>();
        forge::grant_agent_cap(&repo, &cap, AGENT, forge::scope_open_pr(), 1, s(b"x"), scen.ctx());
        scen.return_to_sender(cap);
        ts::return_shared(repo);
    };
    scen.next_epoch(OWNER);
    scen.next_epoch(OWNER);
    scen.next_tx(AGENT);
    {
        let repo = scen.take_shared<Repository>();
        let mut rep = scen.take_shared<RepoReputation>();
        let cap = scen.take_from_sender<AgentCap>();
        pr::open_pr_as_agent(&repo, &mut rep, &cap, s(b"h"), s(b"d"), s(b"exp"), scen.ctx());
        scen.return_to_sender(cap);
        ts::return_shared(rep);
        ts::return_shared(repo);
    };
    scen.end();
}

#[test]
#[expected_failure(abort_code = walrusforge::forge::ECapRevoked)]
fun test_revoked_cap_cannot_open_pr() {
    let mut scen = setup();
    grant_pr_review_cap(&mut scen);

    // Owner revokes the agent's cap by id.
    scen.next_tx(AGENT);
    let cap_id;
    {
        let cap = scen.take_from_sender<AgentCap>();
        cap_id = forge::agent_cap_id(&cap);
        scen.return_to_sender(cap);
    };
    scen.next_tx(OWNER);
    {
        let mut repo = scen.take_shared<Repository>();
        let owner_cap = scen.take_from_sender<RepoOwnerCap>();
        forge::revoke_agent_cap(&mut repo, &owner_cap, cap_id);
        assert!(forge::is_cap_revoked(&repo, cap_id), 500);
        scen.return_to_sender(owner_cap);
        ts::return_shared(repo);
    };
    // Agent now tries to open a PR -> abort ECapRevoked.
    scen.next_tx(AGENT);
    {
        let repo = scen.take_shared<Repository>();
        let mut rep = scen.take_shared<RepoReputation>();
        let cap = scen.take_from_sender<AgentCap>();
        pr::open_pr_as_agent(&repo, &mut rep, &cap, s(b"h"), s(b"d"), s(b"rev"), scen.ctx());
        scen.return_to_sender(cap);
        ts::return_shared(rep);
        ts::return_shared(repo);
    };
    scen.end();
}

#[test]
fun test_full_provenance_chain_and_reputation() {
    let mut scen = setup();
    grant_pr_review_cap(&mut scen);

    // Agent opens PR.
    scen.next_tx(AGENT);
    {
        let repo = scen.take_shared<Repository>();
        let mut rep = scen.take_shared<RepoReputation>();
        let cap = scen.take_from_sender<AgentCap>();
        pr::open_pr_as_agent(&repo, &mut rep, &cap, s(b"blob_head"), s(b"blob_diff"), s(b"fix"), scen.ctx());
        scen.return_to_sender(cap);
        ts::return_shared(rep);
        ts::return_shared(repo);
    };

    // Agent reviews.
    scen.next_tx(AGENT);
    {
        let repo = scen.take_shared<Repository>();
        let mut rep = scen.take_shared<RepoReputation>();
        let mut pull = scen.take_shared<PullRequest>();
        let cap = scen.take_from_sender<AgentCap>();
        pr::submit_review_as_agent(&repo, &mut rep, &mut pull, &cap, pr::verdict_approve(), s(b"blob_report"), scen.ctx());
        assert!(pr::pr_review_count(&pull) == 1, 400);
        scen.return_to_sender(cap);
        ts::return_shared(pull);
        ts::return_shared(rep);
        ts::return_shared(repo);
    };

    // Owner merges.
    scen.next_tx(OWNER);
    {
        let mut repo = scen.take_shared<Repository>();
        let mut rep = scen.take_shared<RepoReputation>();
        let mut pull = scen.take_shared<PullRequest>();
        let cap = scen.take_from_sender<RepoOwnerCap>();
        pr::merge_pr(&mut repo, &mut rep, &mut pull, &cap, scen.ctx());
        assert!(pr::pr_status(&pull) == pr::status_merged(), 401);
        assert!(forge::current_snapshot(&repo) == s(b"blob_head"), 402);
        // Reputation: AGENT opened 1, reviewed 1, merged 1.
        let prof = reputation::profile(&rep, AGENT);
        assert!(reputation::prs_opened(&prof) == 1, 410);
        assert!(reputation::reviews(&prof) == 1, 411);
        assert!(reputation::prs_merged(&prof) == 1, 412);
        scen.return_to_sender(cap);
        ts::return_shared(pull);
        ts::return_shared(rep);
        ts::return_shared(repo);
    };

    // Owner publishes release.
    scen.next_tx(OWNER);
    {
        let mut repo = scen.take_shared<Repository>();
        let cap = scen.take_from_sender<RepoOwnerCap>();
        release::publish_release(
            &mut repo, &cap, s(b"v0.1.0"), s(b"blob_head"), s(b"blob_artifact"), s(b"blob_report"), scen.ctx(),
        );
        assert!(forge::latest_release(&repo).is_some(), 404);
        scen.return_to_sender(cap);
        ts::return_shared(repo);
    };
    scen.next_tx(OWNER);
    {
        let rel = scen.take_shared<Release>();
        assert!(release::release_version(&rel) == s(b"v0.1.0"), 405);
        assert!(release::release_source(&rel) == s(b"blob_head"), 406);
        ts::return_shared(rel);
    };
    scen.end();
}

#[test]
#[expected_failure(abort_code = walrusforge::pull_request::EBaseStale)]
fun test_stale_merge_aborts() {
    let mut scen = setup();
    grant_pr_review_cap(&mut scen);
    scen.next_tx(AGENT);
    {
        let repo = scen.take_shared<Repository>();
        let mut rep = scen.take_shared<RepoReputation>();
        let cap = scen.take_from_sender<AgentCap>();
        pr::open_pr_as_agent(&repo, &mut rep, &cap, s(b"blob_head"), s(b"blob_diff"), s(b"pr1"), scen.ctx());
        scen.return_to_sender(cap);
        ts::return_shared(rep);
        ts::return_shared(repo);
    };
    scen.next_tx(OWNER);
    {
        let mut repo = scen.take_shared<Repository>();
        let cap = scen.take_from_sender<RepoOwnerCap>();
        forge::update_ref(&mut repo, &cap, s(b"blob_moved"));
        scen.return_to_sender(cap);
        ts::return_shared(repo);
    };
    scen.next_tx(OWNER);
    {
        let mut repo = scen.take_shared<Repository>();
        let mut rep = scen.take_shared<RepoReputation>();
        let mut pull = scen.take_shared<PullRequest>();
        let cap = scen.take_from_sender<RepoOwnerCap>();
        pr::merge_pr(&mut repo, &mut rep, &mut pull, &cap, scen.ctx());
        scen.return_to_sender(cap);
        ts::return_shared(pull);
        ts::return_shared(rep);
        ts::return_shared(repo);
    };
    scen.end();
}

// ===== Issues =====

#[test]
fun test_issue_lifecycle() {
    let mut scen = setup();
    scen.next_tx(AGENT);
    {
        let repo = scen.take_shared<Repository>();
        issue::open_issue(&repo, s(b"bug: counter overflows"), s(b"blob_body"), scen.ctx());
        ts::return_shared(repo);
    };
    scen.next_tx(AGENT);
    {
        let mut iss = scen.take_shared<Issue>();
        assert!(issue::issue_status(&iss) == issue::status_open(), 600);
        assert!(issue::issue_author(&iss) == AGENT, 601);
        issue::comment_issue(&mut iss, s(b"blob_comment"), scen.ctx());
        assert!(issue::issue_comment_count(&iss) == 1, 602);
        // author closes
        issue::close_issue(&mut iss, scen.ctx());
        assert!(issue::issue_status(&iss) == issue::status_closed(), 603);
        ts::return_shared(iss);
    };
    scen.end();
}

// ===== Bounties =====

#[test]
fun test_bounty_full_flow() {
    let mut scen = setup();

    // Funder posts a 1000 MIST bounty.
    scen.next_tx(FUNDER);
    {
        let repo = scen.take_shared<Repository>();
        let payment = coin::mint_for_testing<SUI>(1000, scen.ctx());
        bounty::post_bounty(&repo, s(b"fix the test"), payment, 0, scen.ctx());
        ts::return_shared(repo);
    };
    // Agent claims + submits.
    scen.next_tx(AGENT);
    {
        let mut b = scen.take_shared<Bounty>();
        let rep = scen.take_shared<RepoReputation>();
        assert!(bounty::bounty_status(&b) == bounty::status_open(), 700);
        bounty::claim_bounty(&mut b, &rep, scen.ctx());
        assert!(bounty::bounty_status(&b) == bounty::status_claimed(), 701);
        bounty::submit_bounty(&mut b, s(b"pr_0xabc"), scen.ctx());
        ts::return_shared(rep);
        ts::return_shared(b);
    };
    // Funder approves -> claimant paid (minus fee).
    scen.next_tx(FUNDER);
    {
        let mut b = scen.take_shared<Bounty>();
        bounty::approve_bounty(&mut b, scen.ctx());
        assert!(bounty::bounty_status(&b) == bounty::status_paid(), 702);
        assert!(bounty::bounty_escrow_value(&b) == 0, 703);
        ts::return_shared(b);
    };
    // Agent received a coin (fee 2.5% of 1000 = 25; payout 975).
    scen.next_tx(AGENT);
    {
        let paid = scen.take_from_sender<coin::Coin<SUI>>();
        assert!(coin::value(&paid) == 975, 704);
        scen.return_to_sender(paid);
    };
    scen.end();
}

#[test]
fun test_bounty_cancel_refunds() {
    let mut scen = setup();
    scen.next_tx(FUNDER);
    {
        let repo = scen.take_shared<Repository>();
        let payment = coin::mint_for_testing<SUI>(500, scen.ctx());
        bounty::post_bounty(&repo, s(b"unclaimed"), payment, 0, scen.ctx());
        ts::return_shared(repo);
    };
    scen.next_tx(FUNDER);
    {
        let mut b = scen.take_shared<Bounty>();
        bounty::cancel_bounty(&mut b, scen.ctx());
        assert!(bounty::bounty_status(&b) == bounty::status_cancelled(), 710);
        ts::return_shared(b);
    };
    scen.next_tx(FUNDER);
    {
        let refund = scen.take_from_sender<coin::Coin<SUI>>();
        assert!(coin::value(&refund) == 500, 711);
        scen.return_to_sender(refund);
    };
    scen.end();
}

#[test]
#[expected_failure(abort_code = walrusforge::bounty::ENotFunder)]
fun test_bounty_only_funder_approves() {
    let mut scen = setup();
    scen.next_tx(FUNDER);
    {
        let repo = scen.take_shared<Repository>();
        let payment = coin::mint_for_testing<SUI>(100, scen.ctx());
        bounty::post_bounty(&repo, s(b"b"), payment, 0, scen.ctx());
        ts::return_shared(repo);
    };
    scen.next_tx(AGENT);
    {
        let mut b = scen.take_shared<Bounty>();
        let rep = scen.take_shared<RepoReputation>();
        bounty::claim_bounty(&mut b, &rep, scen.ctx());
        ts::return_shared(rep);
        ts::return_shared(b);
    };
    // AGENT (not funder) tries to approve -> abort.
    scen.next_tx(AGENT);
    {
        let mut b = scen.take_shared<Bounty>();
        bounty::approve_bounty(&mut b, scen.ctx());
        ts::return_shared(b);
    };
    scen.end();
}

// ===== Trust layer: score, vouching, approval-gated merge, score-locked bounty =====

/// Run a full open->review(approve)->merge cycle so AGENT earns score.
/// Returns with all objects back to the pool. Score after = merged*10 + review*3 = 13.
fun earn_score(scen: &mut Scenario) {
    grant_pr_review_cap(scen);
    scen.next_tx(AGENT);
    {
        let repo = scen.take_shared<Repository>();
        let mut rep = scen.take_shared<RepoReputation>();
        let cap = scen.take_from_sender<AgentCap>();
        pr::open_pr_as_agent(&repo, &mut rep, &cap, s(b"blob_head"), s(b"blob_diff"), s(b"pr1"), scen.ctx());
        scen.return_to_sender(cap);
        ts::return_shared(rep);
        ts::return_shared(repo);
    };
    scen.next_tx(AGENT);
    {
        let repo = scen.take_shared<Repository>();
        let mut rep = scen.take_shared<RepoReputation>();
        let mut pull = scen.take_shared<PullRequest>();
        let cap = scen.take_from_sender<AgentCap>();
        pr::submit_review_as_agent(&repo, &mut rep, &mut pull, &cap, pr::verdict_approve(), s(b"blob_report"), scen.ctx());
        scen.return_to_sender(cap);
        ts::return_shared(pull);
        ts::return_shared(rep);
        ts::return_shared(repo);
    };
    scen.next_tx(OWNER);
    {
        let mut repo = scen.take_shared<Repository>();
        let mut rep = scen.take_shared<RepoReputation>();
        let mut pull = scen.take_shared<PullRequest>();
        let cap = scen.take_from_sender<RepoOwnerCap>();
        pr::merge_pr(&mut repo, &mut rep, &mut pull, &cap, scen.ctx());
        scen.return_to_sender(cap);
        ts::return_shared(pull);
        ts::return_shared(rep);
        ts::return_shared(repo);
    };
}

#[test]
fun test_score_aggregates() {
    let mut scen = setup();
    earn_score(&mut scen);
    scen.next_tx(AGENT);
    {
        let rep = scen.take_shared<RepoReputation>();
        // merged 1 (*10) + reviews 1 (*3) + opened 1 (*0) = 13
        assert!(reputation::score_of(&rep, AGENT) == 13, 800);
        let prof = reputation::profile(&rep, AGENT);
        assert!(reputation::score(&prof) == 13, 801);
        ts::return_shared(rep);
    };
    scen.end();
}

#[test]
fun test_vouch_raises_score() {
    let mut scen = setup();
    earn_score(&mut scen); // AGENT now has score 13 (>= VOUCH_MIN_SCORE 10)
    scen.next_tx(AGENT);
    {
        let mut rep = scen.take_shared<RepoReputation>();
        reputation::vouch(&mut rep, FUNDER, scen.ctx());
        // FUNDER gets vouches 1 (*5) = 5
        assert!(reputation::score_of(&rep, FUNDER) == 5, 810);
        ts::return_shared(rep);
    };
    scen.end();
}

#[test]
#[expected_failure(abort_code = walrusforge::reputation::EVouchScoreTooLow)]
fun test_low_score_cannot_vouch() {
    let mut scen = setup();
    // FUNDER has zero score, tries to vouch -> abort.
    scen.next_tx(FUNDER);
    {
        let mut rep = scen.take_shared<RepoReputation>();
        reputation::vouch(&mut rep, AGENT, scen.ctx());
        ts::return_shared(rep);
    };
    scen.end();
}

#[test]
#[expected_failure(abort_code = walrusforge::reputation::EVouchSelf)]
fun test_cannot_vouch_self() {
    let mut scen = setup();
    earn_score(&mut scen);
    scen.next_tx(AGENT);
    {
        let mut rep = scen.take_shared<RepoReputation>();
        reputation::vouch(&mut rep, AGENT, scen.ctx());
        ts::return_shared(rep);
    };
    scen.end();
}

#[test]
#[expected_failure(abort_code = walrusforge::pull_request::ENotEnoughApprovals)]
fun test_merge_blocked_below_min_approvals() {
    let mut scen = setup();
    grant_pr_review_cap(&mut scen);
    // Owner requires 1 approval.
    scen.next_tx(OWNER);
    {
        let mut repo = scen.take_shared<Repository>();
        let cap = scen.take_from_sender<RepoOwnerCap>();
        forge::set_min_approvals(&mut repo, &cap, 1);
        scen.return_to_sender(cap);
        ts::return_shared(repo);
    };
    // Agent opens a PR (no approval yet).
    scen.next_tx(AGENT);
    {
        let repo = scen.take_shared<Repository>();
        let mut rep = scen.take_shared<RepoReputation>();
        let cap = scen.take_from_sender<AgentCap>();
        pr::open_pr_as_agent(&repo, &mut rep, &cap, s(b"blob_head"), s(b"blob_diff"), s(b"pr1"), scen.ctx());
        scen.return_to_sender(cap);
        ts::return_shared(rep);
        ts::return_shared(repo);
    };
    // Owner merges with 0 approvals -> abort.
    scen.next_tx(OWNER);
    {
        let mut repo = scen.take_shared<Repository>();
        let mut rep = scen.take_shared<RepoReputation>();
        let mut pull = scen.take_shared<PullRequest>();
        let cap = scen.take_from_sender<RepoOwnerCap>();
        pr::merge_pr(&mut repo, &mut rep, &mut pull, &cap, scen.ctx());
        scen.return_to_sender(cap);
        ts::return_shared(pull);
        ts::return_shared(rep);
        ts::return_shared(repo);
    };
    scen.end();
}

#[test]
fun test_merge_passes_with_enough_approvals() {
    let mut scen = setup();
    earn_score(&mut scen); // includes an approve review + merge; passes when min=0
    // Now set min=1 and run another approved cycle to confirm gate passes.
    scen.next_tx(OWNER);
    {
        let mut repo = scen.take_shared<Repository>();
        let cap = scen.take_from_sender<RepoOwnerCap>();
        forge::set_min_approvals(&mut repo, &cap, 1);
        scen.return_to_sender(cap);
        ts::return_shared(repo);
    };
    scen.next_tx(AGENT);
    {
        let repo = scen.take_shared<Repository>();
        let mut rep = scen.take_shared<RepoReputation>();
        let cap = scen.take_from_sender<AgentCap>();
        // base advanced to blob_head after earn_score's merge; open from there
        pr::open_pr_as_agent(&repo, &mut rep, &cap, s(b"blob_head2"), s(b"blob_diff2"), s(b"pr2"), scen.ctx());
        scen.return_to_sender(cap);
        ts::return_shared(rep);
        ts::return_shared(repo);
    };
    scen.next_tx(AGENT);
    {
        let repo = scen.take_shared<Repository>();
        let mut rep = scen.take_shared<RepoReputation>();
        let mut pull = scen.take_shared<PullRequest>();
        let cap = scen.take_from_sender<AgentCap>();
        pr::submit_review_as_agent(&repo, &mut rep, &mut pull, &cap, pr::verdict_approve(), s(b"blob_report2"), scen.ctx());
        assert!(pr::pr_approvals(&pull) == 1, 820);
        scen.return_to_sender(cap);
        ts::return_shared(pull);
        ts::return_shared(rep);
        ts::return_shared(repo);
    };
    scen.next_tx(OWNER);
    {
        let mut repo = scen.take_shared<Repository>();
        let mut rep = scen.take_shared<RepoReputation>();
        let mut pull = scen.take_shared<PullRequest>();
        let cap = scen.take_from_sender<RepoOwnerCap>();
        pr::merge_pr(&mut repo, &mut rep, &mut pull, &cap, scen.ctx());
        assert!(pr::pr_status(&pull) == pr::status_merged(), 821);
        scen.return_to_sender(cap);
        ts::return_shared(pull);
        ts::return_shared(rep);
        ts::return_shared(repo);
    };
    scen.end();
}

#[test]
fun test_set_min_approvals_sets_value() {
    let mut scen = setup();
    scen.next_tx(OWNER);
    {
        let mut repo = scen.take_shared<Repository>();
        let cap = scen.take_from_sender<RepoOwnerCap>();
        assert!(forge::min_approvals(&repo) == 0, 830);
        forge::set_min_approvals(&mut repo, &cap, 2);
        assert!(forge::min_approvals(&repo) == 2, 831);
        scen.return_to_sender(cap);
        ts::return_shared(repo);
    };
    scen.end();
}

#[test]
#[expected_failure(abort_code = walrusforge::bounty::EScoreTooLow)]
fun test_bounty_score_lock_blocks_low_score() {
    let mut scen = setup();
    // Funder posts a bounty requiring score >= 5.
    scen.next_tx(FUNDER);
    {
        let repo = scen.take_shared<Repository>();
        let payment = coin::mint_for_testing<SUI>(1000, scen.ctx());
        bounty::post_bounty(&repo, s(b"needs-rep"), payment, 5, scen.ctx());
        ts::return_shared(repo);
    };
    // OWNER (zero score in this repo) tries to claim -> abort.
    scen.next_tx(OWNER);
    {
        let mut b = scen.take_shared<Bounty>();
        let rep = scen.take_shared<RepoReputation>();
        bounty::claim_bounty(&mut b, &rep, scen.ctx());
        ts::return_shared(rep);
        ts::return_shared(b);
    };
    scen.end();
}
