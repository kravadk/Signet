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
use sui::clock::{Self, Clock};
use signet::forge::{Self, Repository, RepoOwnerCap};
use signet::reputation::{Self, RepoReputation, ReliabilityLedger};
use signet::playground::{Self, Treasury};

// ===== Errors =====

const ENotFunder: u64 = 0;
const ENotOpen: u64 = 1;
const ENotClaimed: u64 = 2;
const ENotClaimant: u64 = 3;
const EAlreadyClaimed: u64 = 4;
const EZeroAmount: u64 = 5;
const EScoreTooLow: u64 = 6;
const ENotParty: u64 = 7;        // dispute opener is neither funder nor claimant
const EDisputeResolved: u64 = 8; // dispute already arbitrated
const EBadBps: u64 = 9;          // payout split out of range
const EDisputeMismatch: u64 = 10; // dispute does not belong to this bounty
const EProofRequired: u64 = 11;  // approve_v2 needs submitted proof but none present
const ENoDeadline: u64 = 12;     // cancel_expired on a bounty with no deadline
const EDeadlineNotPassed: u64 = 13; // cancel_expired before the deadline
const ETermsMismatch: u64 = 14;  // terms object does not belong to this bounty

// ===== Status =====

const STATUS_OPEN: u8 = 0;      // funded, unclaimed
const STATUS_CLAIMED: u8 = 1;   // an agent is working
const STATUS_PAID: u8 = 2;      // approved + released
const STATUS_CANCELLED: u8 = 3; // funder reclaimed
const STATUS_DISPUTED: u8 = 4;  // a dispute is open; awaiting arbitration
public fun status_open(): u8 { STATUS_OPEN }
public fun status_claimed(): u8 { STATUS_CLAIMED }
public fun status_paid(): u8 { STATUS_PAID }
public fun status_cancelled(): u8 { STATUS_CANCELLED }
public fun status_disputed(): u8 { STATUS_DISPUTED }

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

/// Optional terms for a bounty (companion object; keeps `Bounty` layout stable).
public struct BountyTerms has key {
    id: UID,
    bounty_id: ID,
    /// Absolute Unix ms deadline by which work must be delivered (0 = no deadline).
    deadline_ms: u64,
    /// Whether a proof submission is required before the funder may approve.
    proof_required: bool,
}
public struct BountyTermsSet has copy, drop { bounty_id: ID, deadline_ms: u64, proof_required: bool }
public struct BountyExpired has copy, drop { bounty_id: ID }

// ===== Post / claim / submit / approve / cancel =====

/// Build + emit a funded bounty (shared by v1 and v2 post paths). Returns the id.
fun build_bounty(
    repo: &Repository,
    title: String,
    payment: Coin<SUI>,
    min_score: u64,
    ctx: &mut TxContext,
): ID {
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
    let bounty_id = object::id(&bounty);
    event::emit(BountyPosted {
        bounty_id,
        repo_id: bounty.repo_id,
        funder: bounty.funder,
        amount,
        title: bounty.title,
        min_score,
    });
    transfer::share_object(bounty);
    bounty_id
}

/// Post a bounty against a repo, locking `payment` in escrow.
public fun post_bounty(
    repo: &Repository,
    title: String,
    payment: Coin<SUI>,
    min_score: u64,
    ctx: &mut TxContext,
) {
    build_bounty(repo, title, payment, min_score, ctx);
}

/// Post a bounty with explicit terms: a `deadline_ms` (absolute Unix ms; 0 = none)
/// by which the work must be delivered, and whether a proof submission is required
/// before approval. Creates a companion `BountyTerms` object (upgrade-safe — the
/// `Bounty` layout is unchanged).
public fun post_bounty_v2(
    repo: &Repository,
    title: String,
    payment: Coin<SUI>,
    min_score: u64,
    deadline_ms: u64,
    proof_required: bool,
    ctx: &mut TxContext,
) {
    let bounty_id = build_bounty(repo, title, payment, min_score, ctx);
    let terms = BountyTerms {
        id: object::new(ctx),
        bounty_id,
        deadline_ms,
        proof_required,
    };
    event::emit(BountyTermsSet { bounty_id, deadline_ms, proof_required });
    transfer::share_object(terms);
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

// ===== Treasury-backed approval + deadline (v2, upgrade-safe) =====

/// Approve work and release escrow to the claimant, routing the protocol fee to
/// the shared Treasury (consistent protocol revenue, vs v1 which refunds the
/// funder). Funder-only. If the terms require proof, a submission must be present.
public fun approve_bounty_v2(
    bounty: &mut Bounty,
    terms: &BountyTerms,
    treasury: &mut Treasury,
    ctx: &mut TxContext,
) {
    assert!(bounty.funder == ctx.sender(), ENotFunder);
    assert!(bounty.status == STATUS_CLAIMED, ENotClaimed);
    assert!(terms.bounty_id == object::id(bounty), ETermsMismatch);
    if (terms.proof_required) { assert!(option::is_some(&bounty.proof), EProofRequired); };
    let claimant = *option::borrow(&bounty.claimant);

    let total = balance::value(&bounty.escrow);
    let fee = total * FEE_BPS / 10000;
    let payout = total - fee;

    let payout_coin = coin::take(&mut bounty.escrow, payout, ctx);
    transfer::public_transfer(payout_coin, claimant);
    if (fee > 0) {
        let fee_coin = coin::take(&mut bounty.escrow, fee, ctx);
        playground::deposit_fee(treasury, fee_coin);
    };
    bounty.status = STATUS_PAID;
    event::emit(BountyPaid { bounty_id: object::id(bounty), claimant, paid: payout, fee });
}

/// Reclaim a CLAIMED bounty whose deadline passed without approval. Funder-only;
/// refunds the full escrow and cancels. Requires the bounty's `BountyTerms` and a
/// Clock.
public fun cancel_expired(
    bounty: &mut Bounty,
    terms: &BountyTerms,
    clock: &Clock,
    reliability: &mut ReliabilityLedger,
    ctx: &mut TxContext,
) {
    assert!(bounty.funder == ctx.sender(), ENotFunder);
    assert!(terms.bounty_id == object::id(bounty), ETermsMismatch);
    assert!(bounty.status == STATUS_CLAIMED, ENotClaimed);
    assert!(terms.deadline_ms > 0, ENoDeadline);
    assert!(clock::timestamp_ms(clock) > terms.deadline_ms, EDeadlineNotPassed);
    // The claimant who missed the deadline accrues an expired signal.
    reputation::note_expired(reliability, *option::borrow(&bounty.claimant));
    let total = balance::value(&bounty.escrow);
    let refund = coin::take(&mut bounty.escrow, total, ctx);
    transfer::public_transfer(refund, bounty.funder);
    bounty.status = STATUS_CANCELLED;
    event::emit(BountyExpired { bounty_id: object::id(bounty) });
}

public fun terms_bounty(t: &BountyTerms): ID { t.bounty_id }
public fun terms_deadline_ms(t: &BountyTerms): u64 { t.deadline_ms }
public fun terms_proof_required(t: &BountyTerms): bool { t.proof_required }

// ===== Dispute / arbitration (upgrade-safe companion object) =====
//
// Rather than widen the `Bounty` struct (which would break package upgrades),
// a dispute is a separate shared object that references the bounty by id. The
// repo owner arbitrates with a partial split, so a claimed-but-contested bounty
// can't strand escrow forever.

/// An open dispute against a claimed bounty. Shared so the arbiter can resolve it.
public struct BountyDispute has key {
    id: UID,
    bounty_id: ID,
    opener: address,
    reason: String,
    resolved: bool,
    /// bps of escrow awarded to the claimant at resolution (0 = full refund to funder).
    payout_bps: u64,
}

public struct DisputeOpened has copy, drop { dispute_id: ID, bounty_id: ID, opener: address, reason: String }
public struct DisputeResolved has copy, drop { dispute_id: ID, bounty_id: ID, payout_bps: u64, paid: u64, refunded: u64, fee: u64 }

/// Open a dispute on a CLAIMED bounty. Only the funder or the current claimant
/// may open one. Moves the bounty into DISPUTED so it can't be approved/cancelled
/// out from under arbitration.
public fun open_dispute(
    bounty: &mut Bounty,
    reason: String,
    reliability: &mut ReliabilityLedger,
    ctx: &mut TxContext,
) {
    assert!(bounty.status == STATUS_CLAIMED, ENotClaimed);
    let sender = ctx.sender();
    let is_party = sender == bounty.funder || option::contains(&bounty.claimant, &sender);
    assert!(is_party, ENotParty);
    // The contested worker (claimant) accrues a disputed signal regardless of who opened.
    reputation::note_disputed(reliability, *option::borrow(&bounty.claimant));
    bounty.status = STATUS_DISPUTED;
    let dispute = BountyDispute {
        id: object::new(ctx),
        bounty_id: object::id(bounty),
        opener: sender,
        reason,
        resolved: false,
        payout_bps: 0,
    };
    event::emit(DisputeOpened {
        dispute_id: object::id(&dispute),
        bounty_id: object::id(bounty),
        opener: sender,
        reason: dispute.reason,
    });
    transfer::share_object(dispute);
}

/// Arbitrate a dispute. The repo owner decides `payout_bps` (0..=10000) of the
/// escrow to the claimant; the protocol fee is taken from that payout and the
/// remainder is refunded to the funder. Resolves the bounty to PAID.
public fun resolve_dispute(
    bounty: &mut Bounty,
    dispute: &mut BountyDispute,
    repo: &Repository,
    cap: &RepoOwnerCap,
    payout_bps: u64,
    ctx: &mut TxContext,
) {
    forge::assert_owner(repo, cap);
    assert!(object::id(repo) == bounty.repo_id, EDisputeMismatch);
    assert!(dispute.bounty_id == object::id(bounty), EDisputeMismatch);
    assert!(!dispute.resolved, EDisputeResolved);
    assert!(bounty.status == STATUS_DISPUTED, ENotClaimed);
    assert!(payout_bps <= 10000, EBadBps);
    let claimant = *option::borrow(&bounty.claimant);

    let total = balance::value(&bounty.escrow);
    let award = total * payout_bps / 10000;
    let fee = award * FEE_BPS / 10000;
    let paid = award - fee;

    if (paid > 0) {
        let payout_coin = coin::take(&mut bounty.escrow, paid, ctx);
        transfer::public_transfer(payout_coin, claimant);
    };
    if (fee > 0) {
        let fee_coin = coin::take(&mut bounty.escrow, fee, ctx);
        transfer::public_transfer(fee_coin, bounty.funder);
    };
    let refunded = balance::value(&bounty.escrow);
    if (refunded > 0) {
        let refund_coin = coin::take(&mut bounty.escrow, refunded, ctx);
        transfer::public_transfer(refund_coin, bounty.funder);
    };

    bounty.status = STATUS_PAID;
    dispute.resolved = true;
    dispute.payout_bps = payout_bps;
    event::emit(DisputeResolved {
        dispute_id: object::id(dispute),
        bounty_id: object::id(bounty),
        payout_bps,
        paid,
        refunded,
        fee,
    });
}

/// Same as `resolve_dispute`, but routes the protocol fee to the shared Treasury
/// instead of the funder (consistent protocol revenue).
public fun resolve_dispute_v2(
    bounty: &mut Bounty,
    dispute: &mut BountyDispute,
    repo: &Repository,
    cap: &RepoOwnerCap,
    treasury: &mut Treasury,
    payout_bps: u64,
    ctx: &mut TxContext,
) {
    forge::assert_owner(repo, cap);
    assert!(object::id(repo) == bounty.repo_id, EDisputeMismatch);
    assert!(dispute.bounty_id == object::id(bounty), EDisputeMismatch);
    assert!(!dispute.resolved, EDisputeResolved);
    assert!(bounty.status == STATUS_DISPUTED, ENotClaimed);
    assert!(payout_bps <= 10000, EBadBps);
    let claimant = *option::borrow(&bounty.claimant);

    let total = balance::value(&bounty.escrow);
    let award = total * payout_bps / 10000;
    let fee = award * FEE_BPS / 10000;
    let paid = award - fee;

    if (paid > 0) {
        let payout_coin = coin::take(&mut bounty.escrow, paid, ctx);
        transfer::public_transfer(payout_coin, claimant);
    };
    if (fee > 0) {
        let fee_coin = coin::take(&mut bounty.escrow, fee, ctx);
        playground::deposit_fee(treasury, fee_coin);
    };
    let refunded = balance::value(&bounty.escrow);
    if (refunded > 0) {
        let refund_coin = coin::take(&mut bounty.escrow, refunded, ctx);
        transfer::public_transfer(refund_coin, bounty.funder);
    };

    bounty.status = STATUS_PAID;
    dispute.resolved = true;
    dispute.payout_bps = payout_bps;
    event::emit(DisputeResolved {
        dispute_id: object::id(dispute),
        bounty_id: object::id(bounty),
        payout_bps,
        paid,
        refunded,
        fee,
    });
}

public fun dispute_bounty(d: &BountyDispute): ID { d.bounty_id }
public fun dispute_opener(d: &BountyDispute): address { d.opener }
public fun dispute_resolved(d: &BountyDispute): bool { d.resolved }
public fun dispute_payout_bps(d: &BountyDispute): u64 { d.payout_bps }

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
