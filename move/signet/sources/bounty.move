/// Bounties for Signet — on-chain SUI escrow for repo work.
///
/// A funder posts a bounty against a repo, locking SUI in the `Bounty` object.
/// An agent (or human) claims it, submits a PR as proof, and the funder approves
/// — releasing the escrow to the claimant minus a small protocol fee. If nobody
/// delivers, the funder can cancel and reclaim. This gives Signet a real
/// incentive layer: agents get paid for verifiable, merged work.
module signet::bounty;

use std::string::String;
use sui::balance::{Self, Balance};
use sui::coin::{Self, Coin};
use sui::sui::SUI;
use sui::event;
use signet::forge::Repository;
use signet::reputation::{Self, RepoReputation};

// ===== Errors =====

const ENotFunder: u64 = 0;
const ENotOpen: u64 = 1;
const ENotClaimed: u64 = 2;
const ENotClaimant: u64 = 3;
const EAlreadyClaimed: u64 = 4;
const EZeroAmount: u64 = 5;
const EScoreTooLow: u64 = 6;

// ===== Status =====

const STATUS_OPEN: u8 = 0;      // funded, unclaimed
const STATUS_CLAIMED: u8 = 1;   // an agent is working
const STATUS_PAID: u8 = 2;      // approved + released
const STATUS_CANCELLED: u8 = 3; // funder reclaimed
public fun status_open(): u8 { STATUS_OPEN }
public fun status_claimed(): u8 { STATUS_CLAIMED }
public fun status_paid(): u8 { STATUS_PAID }
public fun status_cancelled(): u8 { STATUS_CANCELLED }

/// Protocol fee in basis points (2.5%). Kept modest and transparent.
const FEE_BPS: u64 = 250;

// ===== Objects =====

/// An escrowed bounty. Shared so claimants and the UI can interact. Holds the
/// locked SUI in `escrow` until paid or cancelled.
public struct Bounty has key {
    id: UID,
    repo_id: ID,
    funder: address,
    title: String,
    amount: u64,             // original funded amount (for display)
    escrow: Balance<SUI>,    // the locked coins
    status: u8,
    claimant: Option<address>,
    /// Walrus blob id / PR id of the submitted proof, once delivered.
    proof: Option<String>,
    /// Minimum reputation score required to claim (0 = open to anyone).
    min_score: u64,
}

// ===== Events =====

public struct BountyPosted has copy, drop {
    bounty_id: ID,
    repo_id: ID,
    funder: address,
    amount: u64,
    title: String,
    min_score: u64,
}
public struct BountyClaimed has copy, drop { bounty_id: ID, claimant: address }
public struct BountySubmitted has copy, drop { bounty_id: ID, proof: String }
public struct BountyPaid has copy, drop {
    bounty_id: ID,
    claimant: address,
    paid: u64,
    fee: u64,
}
public struct BountyCancelled has copy, drop { bounty_id: ID }

// ===== Post / claim / submit / approve / cancel =====

/// Post a bounty against a repo, locking `payment` in escrow.
public fun post_bounty(
    repo: &Repository,
    title: String,
    payment: Coin<SUI>,
    min_score: u64,
    ctx: &mut TxContext,
) {
    let amount = coin::value(&payment);
    assert!(amount > 0, EZeroAmount);
    let bounty = Bounty {
        id: object::new(ctx),
        repo_id: object::id(repo),
        funder: ctx.sender(),
        title,
        amount,
        escrow: coin::into_balance(payment),
        status: STATUS_OPEN,
        claimant: option::none(),
        proof: option::none(),
        min_score,
    };
    event::emit(BountyPosted {
        bounty_id: object::id(&bounty),
        repo_id: bounty.repo_id,
        funder: bounty.funder,
        amount,
        title: bounty.title,
        min_score,
    });
    transfer::share_object(bounty);
}

/// Claim an open bounty. The claimant commits to delivering the work. If the
/// bounty sets a `min_score`, the claimant's reputation in that repo must meet it
/// — the `rep` ledger must be the one belonging to the bounty's repo.
public fun claim_bounty(bounty: &mut Bounty, rep: &RepoReputation, ctx: &TxContext) {
    assert!(bounty.status == STATUS_OPEN, ENotOpen);
    assert!(option::is_none(&bounty.claimant), EAlreadyClaimed);
    if (bounty.min_score > 0) {
        assert!(reputation::ledger_repo(rep) == bounty.repo_id, EScoreTooLow);
        assert!(reputation::score_of(rep, ctx.sender()) >= bounty.min_score, EScoreTooLow);
    };
    bounty.claimant = option::some(ctx.sender());
    bounty.status = STATUS_CLAIMED;
    event::emit(BountyClaimed { bounty_id: object::id(bounty), claimant: ctx.sender() });
}

/// Submit proof of work (e.g. the PR id or a Walrus blob). Claimant-only.
public fun submit_bounty(bounty: &mut Bounty, proof: String, ctx: &TxContext) {
    assert!(bounty.status == STATUS_CLAIMED, ENotClaimed);
    assert!(option::contains(&bounty.claimant, &ctx.sender()), ENotClaimant);
    bounty.proof = option::some(proof);
    event::emit(BountySubmitted { bounty_id: object::id(bounty), proof });
}

/// Approve the work and release escrow to the claimant minus the protocol fee.
/// Funder-only. The fee is returned to the funder (kept in-ecosystem for the
/// MVP; a treasury split is post-MVP).
public fun approve_bounty(bounty: &mut Bounty, ctx: &mut TxContext) {
    assert!(bounty.funder == ctx.sender(), ENotFunder);
    assert!(bounty.status == STATUS_CLAIMED, ENotClaimed);
    let claimant = *option::borrow(&bounty.claimant);

    let total = balance::value(&bounty.escrow);
    let fee = total * FEE_BPS / 10000;
    let payout = total - fee;

    let payout_coin = coin::take(&mut bounty.escrow, payout, ctx);
    transfer::public_transfer(payout_coin, claimant);

    if (fee > 0) {
        let fee_coin = coin::take(&mut bounty.escrow, fee, ctx);
        transfer::public_transfer(fee_coin, bounty.funder);
    };

    bounty.status = STATUS_PAID;
    event::emit(BountyPaid {
        bounty_id: object::id(bounty),
        claimant,
        paid: payout,
        fee,
    });
}

/// Cancel an unclaimed bounty and refund the funder. Funder-only, OPEN only.
public fun cancel_bounty(bounty: &mut Bounty, ctx: &mut TxContext) {
    assert!(bounty.funder == ctx.sender(), ENotFunder);
    assert!(bounty.status == STATUS_OPEN, ENotOpen);
    let total = balance::value(&bounty.escrow);
    let refund = coin::take(&mut bounty.escrow, total, ctx);
    transfer::public_transfer(refund, bounty.funder);
    bounty.status = STATUS_CANCELLED;
    event::emit(BountyCancelled { bounty_id: object::id(bounty) });
}

// ===== Read accessors =====

public fun bounty_repo(b: &Bounty): ID { b.repo_id }
public fun bounty_funder(b: &Bounty): address { b.funder }
public fun bounty_amount(b: &Bounty): u64 { b.amount }
public fun bounty_escrow_value(b: &Bounty): u64 { balance::value(&b.escrow) }
public fun bounty_status(b: &Bounty): u8 { b.status }
public fun bounty_claimant(b: &Bounty): Option<address> { b.claimant }
public fun bounty_proof(b: &Bounty): Option<String> { b.proof }
public fun bounty_min_score(b: &Bounty): u64 { b.min_score }
public fun fee_bps(): u64 { FEE_BPS }
