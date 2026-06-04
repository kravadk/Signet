/// Signet payment links / invoice requests.
///
/// A recipient creates a shared `PaymentRequest`; a payer fulfills it with SUI.
/// The object stays on-chain as the receipt anchor, and events power gateway
/// webhooks. Additive module: no existing object layouts are changed.
module signet::payment;

use std::string::String;
use std::option::{Self, Option};
use sui::coin::{Self, Coin};
use sui::sui::SUI;
use sui::clock::{Self, Clock};
use sui::event;

const EZeroAmount: u64 = 0;
const EUnderpaid: u64 = 1;
const EAlreadyClosed: u64 = 2;
const EExpired: u64 = 3;
const ENotController: u64 = 4;

public struct PaymentRequest has key, store {
    id: UID,
    creator: address,
    recipient: address,
    label: String,
    amount: u64,
    paid: bool,
    cancelled: bool,
    payer: Option<address>,
    created_at_ms: u64,
    expires_at_ms: Option<u64>,
}

public struct PaymentRequested has copy, drop {
    request_id: ID,
    creator: address,
    recipient: address,
    label: String,
    amount: u64,
    created_at_ms: u64,
    expires_at_ms: Option<u64>,
}

public struct PaymentPaid has copy, drop {
    request_id: ID,
    payer: address,
    recipient: address,
    amount: u64,
}

public struct PaymentCancelled has copy, drop {
    request_id: ID,
    by: address,
}

public fun create_request(
    recipient: address,
    label: String,
    amount: u64,
    expires_at_ms: Option<u64>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(amount > 0, EZeroAmount);
    let req = PaymentRequest {
        id: object::new(ctx),
        creator: ctx.sender(),
        recipient,
        label,
        amount,
        paid: false,
        cancelled: false,
        payer: option::none(),
        created_at_ms: clock::timestamp_ms(clock),
        expires_at_ms,
    };
    event::emit(PaymentRequested {
        request_id: object::id(&req),
        creator: req.creator,
        recipient: req.recipient,
        label: req.label,
        amount: req.amount,
        created_at_ms: req.created_at_ms,
        expires_at_ms: req.expires_at_ms,
    });
    transfer::share_object(req);
}

public fun pay(req: &mut PaymentRequest, payment: Coin<SUI>, clock: &Clock, ctx: &mut TxContext) {
    assert!(!req.paid && !req.cancelled, EAlreadyClosed);
    if (option::is_some(&req.expires_at_ms)) {
        assert!(clock::timestamp_ms(clock) <= *option::borrow(&req.expires_at_ms), EExpired);
    };
    let paid = coin::value(&payment);
    assert!(paid >= req.amount, EUnderpaid);
    let mut exact = payment;
    if (paid > req.amount) {
        let refund = coin::split(&mut exact, paid - req.amount, ctx);
        transfer::public_transfer(refund, ctx.sender());
    };
    transfer::public_transfer(exact, req.recipient);
    req.paid = true;
    req.payer = option::some(ctx.sender());
    event::emit(PaymentPaid {
        request_id: object::id(req),
        payer: ctx.sender(),
        recipient: req.recipient,
        amount: req.amount,
    });
}

public fun cancel(req: &mut PaymentRequest, ctx: &TxContext) {
    assert!(!req.paid && !req.cancelled, EAlreadyClosed);
    assert!(ctx.sender() == req.creator || ctx.sender() == req.recipient, ENotController);
    req.cancelled = true;
    event::emit(PaymentCancelled { request_id: object::id(req), by: ctx.sender() });
}

public fun request_creator(req: &PaymentRequest): address { req.creator }
public fun request_recipient(req: &PaymentRequest): address { req.recipient }
public fun request_label(req: &PaymentRequest): String { req.label }
public fun request_amount(req: &PaymentRequest): u64 { req.amount }
public fun request_paid(req: &PaymentRequest): bool { req.paid }
public fun request_cancelled(req: &PaymentRequest): bool { req.cancelled }
public fun request_payer(req: &PaymentRequest): Option<address> { req.payer }
public fun request_created_at_ms(req: &PaymentRequest): u64 { req.created_at_ms }
public fun request_expires_at_ms(req: &PaymentRequest): Option<u64> { req.expires_at_ms }

public fun e_zero_amount(): u64 { EZeroAmount }
public fun e_underpaid(): u64 { EUnderpaid }
public fun e_already_closed(): u64 { EAlreadyClosed }
public fun e_expired(): u64 { EExpired }
public fun e_not_controller(): u64 { ENotController }
