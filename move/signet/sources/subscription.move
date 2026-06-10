/// Signet subscriptions & streams — recurring and continuous SUI payments.
///
/// Where `payment` is one-shot, this is time-based:
///   - `Subscription`: the payer pre-funds N periods into escrow; the payee claims
///     one period's amount each `period_ms`; the payer can cancel and reclaim any
///     unclaimed escrow.
///   - `Stream`: the payer escrows a lump sum that vests linearly over `duration_ms`;
///     the payee claims the vested-but-unclaimed portion at any time.
///
/// Mirrors `payment`'s exact-transfer + overpayment-refund discipline and uses the
/// shared `Clock` (0x6) for time. Additive module: only new types/events.
module signet::subscription;

use std::string::String;
use sui::balance::{Self, Balance};
use sui::coin::{Self, Coin};
use sui::sui::SUI;
use sui::clock::{Self, Clock};
use sui::event;

const EZeroAmount: u64 = 0;
const EUnderfunded: u64 = 1;
const ECancelled: u64 = 2;
const ENotPayee: u64 = 3;
const ENotController: u64 = 4;
const ENothingDue: u64 = 5;
const EZeroPeriods: u64 = 6;
const EZeroDuration: u64 = 7;

// ============================ Recurring subscription ============================

public struct Subscription has key {
    id: UID,
    payer: address,
    payee: address,
    label: String,
    amount_per_period: u64,
    period_ms: u64,
    total_periods: u64,
    periods_claimed: u64,
    escrow: Balance<SUI>,
    cancelled: bool,
    created_at_ms: u64,
    next_claim_at_ms: u64,
}

public struct SubscriptionCreated has copy, drop {
    subscription_id: ID,
    payer: address,
    payee: address,
    amount_per_period: u64,
    period_ms: u64,
    total_periods: u64,
    next_claim_at_ms: u64,
}

public struct PeriodClaimed has copy, drop {
    subscription_id: ID,
    payee: address,
    periods: u64,
    amount: u64,
    periods_claimed: u64,
}

public struct SubscriptionCancelled has copy, drop {
    subscription_id: ID,
    by: address,
    refund: u64,
}

/// Create a subscription, pre-funding `amount_per_period * total_periods` into escrow.
/// Overpayment is refunded to the payer immediately (exact-funding discipline). The
/// first period becomes claimable at `now + period_ms`.
public fun create_subscription(
    payee: address,
    label: String,
    amount_per_period: u64,
    period_ms: u64,
    total_periods: u64,
    funding: Coin<SUI>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(amount_per_period > 0, EZeroAmount);
    assert!(total_periods > 0, EZeroPeriods);
    assert!(period_ms > 0, EZeroDuration);
    let need = amount_per_period * total_periods;
    let funded = coin::value(&funding);
    assert!(funded >= need, EUnderfunded);
    let mut bal = coin::into_balance(funding);
    if (funded > need) {
        let refund = coin::from_balance(balance::split(&mut bal, funded - need), ctx);
        transfer::public_transfer(refund, ctx.sender());
    };
    let now = clock::timestamp_ms(clock);
    let sub = Subscription {
        id: object::new(ctx),
        payer: ctx.sender(),
        payee,
        label,
        amount_per_period,
        period_ms,
        total_periods,
        periods_claimed: 0,
        escrow: bal,
        cancelled: false,
        created_at_ms: now,
        next_claim_at_ms: now + period_ms,
    };
    event::emit(SubscriptionCreated {
        subscription_id: object::id(&sub),
        payer: sub.payer,
        payee,
        amount_per_period,
        period_ms,
        total_periods,
        next_claim_at_ms: sub.next_claim_at_ms,
    });
    transfer::share_object(sub);
}

/// Payee claims every period that has come due. Pays `amount_per_period` per matured
/// period and advances the schedule. Aborts if nothing is due yet.
public fun claim_due(sub: &mut Subscription, clock: &Clock, ctx: &mut TxContext) {
    assert!(!sub.cancelled, ECancelled);
    assert!(ctx.sender() == sub.payee, ENotPayee);
    let now = clock::timestamp_ms(clock);
    let mut due = 0;
    while (
        sub.periods_claimed + due < sub.total_periods
            && now >= sub.next_claim_at_ms + due * sub.period_ms
    ) {
        due = due + 1;
    };
    assert!(due > 0, ENothingDue);
    let amount = sub.amount_per_period * due;
    let payout = coin::from_balance(balance::split(&mut sub.escrow, amount), ctx);
    transfer::public_transfer(payout, sub.payee);
    sub.periods_claimed = sub.periods_claimed + due;
    sub.next_claim_at_ms = sub.next_claim_at_ms + due * sub.period_ms;
    event::emit(PeriodClaimed {
        subscription_id: object::id(sub),
        payee: sub.payee,
        periods: due,
        amount,
        periods_claimed: sub.periods_claimed,
    });
}

/// Cancel the subscription. Either party may cancel; all unclaimed escrow is refunded
/// to the payer (the payee keeps whatever they already claimed).
public fun cancel(sub: &mut Subscription, ctx: &mut TxContext) {
    assert!(!sub.cancelled, ECancelled);
    assert!(ctx.sender() == sub.payer || ctx.sender() == sub.payee, ENotController);
    let remaining = balance::value(&sub.escrow);
    if (remaining > 0) {
        let refund = coin::from_balance(balance::split(&mut sub.escrow, remaining), ctx);
        transfer::public_transfer(refund, sub.payer);
    };
    sub.cancelled = true;
    event::emit(SubscriptionCancelled { subscription_id: object::id(sub), by: ctx.sender(), refund: remaining });
}

public fun sub_payer(s: &Subscription): address { s.payer }
public fun sub_payee(s: &Subscription): address { s.payee }
public fun sub_amount_per_period(s: &Subscription): u64 { s.amount_per_period }
public fun sub_total_periods(s: &Subscription): u64 { s.total_periods }
public fun sub_periods_claimed(s: &Subscription): u64 { s.periods_claimed }
public fun sub_escrow_value(s: &Subscription): u64 { balance::value(&s.escrow) }
public fun sub_cancelled(s: &Subscription): bool { s.cancelled }
public fun sub_next_claim_at_ms(s: &Subscription): u64 { s.next_claim_at_ms }

// ================================== Stream =====================================

public struct Stream has key {
    id: UID,
    payer: address,
    payee: address,
    label: String,
    escrow: Balance<SUI>,
    total: u64,
    claimed: u64,
    start_ms: u64,
    duration_ms: u64,
    cancelled: bool,
}

public struct StreamCreated has copy, drop {
    stream_id: ID,
    payer: address,
    payee: address,
    total: u64,
    start_ms: u64,
    duration_ms: u64,
}

public struct StreamClaimed has copy, drop {
    stream_id: ID,
    payee: address,
    amount: u64,
    claimed: u64,
}

public struct StreamCancelled has copy, drop {
    stream_id: ID,
    by: address,
    to_payee: u64,
    refund: u64,
}

/// Create a linear stream: the full `funding` vests evenly over `duration_ms`.
public fun create_stream(
    payee: address,
    label: String,
    funding: Coin<SUI>,
    duration_ms: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(duration_ms > 0, EZeroDuration);
    let total = coin::value(&funding);
    assert!(total > 0, EZeroAmount);
    let now = clock::timestamp_ms(clock);
    let stream = Stream {
        id: object::new(ctx),
        payer: ctx.sender(),
        payee,
        label,
        escrow: coin::into_balance(funding),
        total,
        claimed: 0,
        start_ms: now,
        duration_ms,
        cancelled: false,
    };
    event::emit(StreamCreated {
        stream_id: object::id(&stream),
        payer: stream.payer,
        payee,
        total,
        start_ms: now,
        duration_ms,
    });
    transfer::share_object(stream);
}

/// Amount vested by `now` (capped at total). u128 intermediate to avoid overflow.
fun vested_at(stream: &Stream, now: u64): u64 {
    let elapsed = if (now >= stream.start_ms + stream.duration_ms) {
        stream.duration_ms
    } else if (now <= stream.start_ms) {
        0
    } else {
        now - stream.start_ms
    };
    (((stream.total as u128) * (elapsed as u128)) / (stream.duration_ms as u128)) as u64
}

/// Payee claims the vested-but-unclaimed portion.
public fun claim_stream(stream: &mut Stream, clock: &Clock, ctx: &mut TxContext) {
    assert!(!stream.cancelled, ECancelled);
    assert!(ctx.sender() == stream.payee, ENotPayee);
    let vested = vested_at(stream, clock::timestamp_ms(clock));
    let claimable = vested - stream.claimed;
    assert!(claimable > 0, ENothingDue);
    let payout = coin::from_balance(balance::split(&mut stream.escrow, claimable), ctx);
    transfer::public_transfer(payout, stream.payee);
    stream.claimed = stream.claimed + claimable;
    event::emit(StreamClaimed { stream_id: object::id(stream), payee: stream.payee, amount: claimable, claimed: stream.claimed });
}

/// Cancel a stream: pay the payee everything vested-but-unclaimed, refund the rest
/// (the unvested remainder) to the payer.
public fun cancel_stream(stream: &mut Stream, clock: &Clock, ctx: &mut TxContext) {
    assert!(!stream.cancelled, ECancelled);
    assert!(ctx.sender() == stream.payer || ctx.sender() == stream.payee, ENotController);
    let vested = vested_at(stream, clock::timestamp_ms(clock));
    let to_payee = vested - stream.claimed;
    if (to_payee > 0) {
        let payout = coin::from_balance(balance::split(&mut stream.escrow, to_payee), ctx);
        transfer::public_transfer(payout, stream.payee);
        stream.claimed = stream.claimed + to_payee;
    };
    let refund = balance::value(&stream.escrow);
    if (refund > 0) {
        let back = coin::from_balance(balance::split(&mut stream.escrow, refund), ctx);
        transfer::public_transfer(back, stream.payer);
    };
    stream.cancelled = true;
    event::emit(StreamCancelled { stream_id: object::id(stream), by: ctx.sender(), to_payee, refund });
}

public fun stream_payer(s: &Stream): address { s.payer }
public fun stream_payee(s: &Stream): address { s.payee }
public fun stream_total(s: &Stream): u64 { s.total }
public fun stream_claimed(s: &Stream): u64 { s.claimed }
public fun stream_escrow_value(s: &Stream): u64 { balance::value(&s.escrow) }
public fun stream_cancelled(s: &Stream): bool { s.cancelled }

public fun e_zero_amount(): u64 { EZeroAmount }
public fun e_underfunded(): u64 { EUnderfunded }
public fun e_cancelled(): u64 { ECancelled }
public fun e_not_payee(): u64 { ENotPayee }
public fun e_not_controller(): u64 { ENotController }
public fun e_nothing_due(): u64 { ENothingDue }
