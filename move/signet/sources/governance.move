/// Signet governance — community-decided spending of the protocol Treasury.
///
/// Today the Treasury (the accrued 2.5% protocol fee) is admin-withdrawable. This
/// module adds an autonomous path: anyone can open a `Proposal` to disburse a fixed
/// amount to a recipient; votes are weighted by on-chain builder reputation
/// (`playground::builder_score`); after the voting window AND a timelock, anyone may
/// `execute` a passed proposal, moving funds via the package-gated
/// `playground::pay_from_treasury`. No admin, no off-chain trust — the rules decide.
///
/// Additive module: introduces only new types/events; no existing layout changes.
/// (A `Proposal` is a standalone shared object — Sui forbids `init` in a module added
/// during an upgrade, and none is needed here.)
module signet::governance;

use std::string::String;
use sui::clock::{Self, Clock};
use sui::vec_set::{Self, VecSet};
use sui::event;
use signet::playground::{Self, Treasury, BuilderBoard};

const EAlreadyResolved: u64 = 0;
const EVotingClosed: u64 = 1;
const EAlreadyVoted: u64 = 2;
const ENoVotingPower: u64 = 3;
const ETimelockActive: u64 = 4;
const ETreasuryMismatch: u64 = 5;
const EQuorumNotMet: u64 = 6;
const EZeroAmount: u64 = 7;

const STATUS_VOTING: u8 = 0;
const STATUS_EXECUTED: u8 = 1;
const STATUS_REJECTED: u8 = 2;

/// Minimum total voting weight (for + against) for a proposal to be executable.
/// Tunable per deployment; keeps a single drive-by vote from moving funds.
const QUORUM: u64 = 1;

public struct Proposal has key {
    id: UID,
    proposer: address,
    treasury_id: ID,
    recipient: address,
    amount: u64,
    label: String,
    status: u8,
    votes_for: u64,
    votes_against: u64,
    voters: VecSet<address>,
    voting_ends_ms: u64,
    timelock_ms: u64,
    created_at_ms: u64,
}

public struct ProposalOpened has copy, drop {
    proposal_id: ID,
    proposer: address,
    treasury_id: ID,
    recipient: address,
    amount: u64,
    voting_ends_ms: u64,
    timelock_ms: u64,
}

public struct VoteCast has copy, drop {
    proposal_id: ID,
    voter: address,
    approve: bool,
    weight: u64,
}

public struct ProposalExecuted has copy, drop {
    proposal_id: ID,
    recipient: address,
    amount: u64,
    votes_for: u64,
    votes_against: u64,
}

public struct ProposalRejected has copy, drop {
    proposal_id: ID,
    votes_for: u64,
    votes_against: u64,
}

/// Open a proposal to disburse `amount` from `treasury` to `recipient`. Anyone may
/// propose; `treasury_id` binds the proposal to a specific Treasury so it can only
/// ever spend that one.
public fun open_proposal(
    treasury: &Treasury,
    recipient: address,
    amount: u64,
    label: String,
    voting_ms: u64,
    timelock_ms: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(amount > 0, EZeroAmount);
    let now = clock::timestamp_ms(clock);
    let p = Proposal {
        id: object::new(ctx),
        proposer: ctx.sender(),
        treasury_id: object::id(treasury),
        recipient,
        amount,
        label,
        status: STATUS_VOTING,
        votes_for: 0,
        votes_against: 0,
        voters: vec_set::empty(),
        voting_ends_ms: now + voting_ms,
        timelock_ms,
        created_at_ms: now,
    };
    event::emit(ProposalOpened {
        proposal_id: object::id(&p),
        proposer: p.proposer,
        treasury_id: p.treasury_id,
        recipient,
        amount,
        voting_ends_ms: p.voting_ends_ms,
        timelock_ms,
    });
    transfer::share_object(p);
}

/// Cast a reputation-weighted vote. Weight = the voter's BuilderBoard score; voters
/// with zero score cannot vote. One vote per address, only while voting is open.
public fun vote(
    p: &mut Proposal,
    board: &BuilderBoard,
    approve: bool,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(p.status == STATUS_VOTING, EAlreadyResolved);
    assert!(clock::timestamp_ms(clock) < p.voting_ends_ms, EVotingClosed);
    let voter = ctx.sender();
    assert!(!vec_set::contains(&p.voters, &voter), EAlreadyVoted);
    let weight = playground::builder_score(board, voter);
    assert!(weight > 0, ENoVotingPower);
    vec_set::insert(&mut p.voters, voter);
    if (approve) {
        p.votes_for = p.votes_for + weight;
    } else {
        p.votes_against = p.votes_against + weight;
    };
    event::emit(VoteCast { proposal_id: object::id(p), voter, approve, weight });
}

/// Permissionless crank: after the voting window + timelock, settle the proposal.
/// If approvals outweigh rejections (and quorum is met) the amount is disbursed from
/// the Treasury to the recipient; otherwise the proposal is marked rejected.
public fun execute(
    p: &mut Proposal,
    treasury: &mut Treasury,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(p.status == STATUS_VOTING, EAlreadyResolved);
    assert!(object::id(treasury) == p.treasury_id, ETreasuryMismatch);
    assert!(clock::timestamp_ms(clock) >= p.voting_ends_ms + p.timelock_ms, ETimelockActive);
    assert!(p.votes_for + p.votes_against >= QUORUM, EQuorumNotMet);
    if (p.votes_for > p.votes_against) {
        playground::pay_from_treasury(treasury, p.amount, p.recipient, ctx);
        p.status = STATUS_EXECUTED;
        event::emit(ProposalExecuted {
            proposal_id: object::id(p),
            recipient: p.recipient,
            amount: p.amount,
            votes_for: p.votes_for,
            votes_against: p.votes_against,
        });
    } else {
        p.status = STATUS_REJECTED;
        event::emit(ProposalRejected {
            proposal_id: object::id(p),
            votes_for: p.votes_for,
            votes_against: p.votes_against,
        });
    };
}

// ---- read accessors + constants ----
public fun proposal_status(p: &Proposal): u8 { p.status }
public fun proposal_votes_for(p: &Proposal): u64 { p.votes_for }
public fun proposal_votes_against(p: &Proposal): u64 { p.votes_against }
public fun proposal_amount(p: &Proposal): u64 { p.amount }
public fun proposal_recipient(p: &Proposal): address { p.recipient }
public fun proposal_treasury(p: &Proposal): ID { p.treasury_id }
public fun proposal_voting_ends_ms(p: &Proposal): u64 { p.voting_ends_ms }

public fun status_voting(): u8 { STATUS_VOTING }
public fun status_executed(): u8 { STATUS_EXECUTED }
public fun status_rejected(): u8 { STATUS_REJECTED }
public fun quorum(): u64 { QUORUM }

public fun e_already_resolved(): u64 { EAlreadyResolved }
public fun e_voting_closed(): u64 { EVotingClosed }
public fun e_already_voted(): u64 { EAlreadyVoted }
public fun e_no_voting_power(): u64 { ENoVotingPower }
public fun e_timelock_active(): u64 { ETimelockActive }
public fun e_treasury_mismatch(): u64 { ETreasuryMismatch }
public fun e_quorum_not_met(): u64 { EQuorumNotMet }
public fun e_zero_amount(): u64 { EZeroAmount }
