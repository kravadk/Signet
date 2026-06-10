#[test_only]
module signet::subscription_tests;

use std::string;
use sui::test_scenario::{Self as ts, Scenario};
use sui::clock;
use sui::coin;
use sui::sui::SUI;
use signet::subscription::{Self as sub, Subscription, Stream};

const PAYER: address = @0xA;
const PAYEE: address = @0xB;
const STRANGER: address = @0xC;

fun s(b: vector<u8>): string::String { string::utf8(b) }

#[test]
fun test_create_refunds_overfunding() {
    let mut scen = ts::begin(PAYER);
    let clk = clock::create_for_testing(scen.ctx());
    // need = 1000 * 3 = 3000; fund 3500 -> refund 500
    let funding = coin::mint_for_testing<SUI>(3_500, scen.ctx());
    sub::create_subscription(PAYEE, s(b"plan"), 1_000, 100, 3, funding, &clk, scen.ctx());
    clock::destroy_for_testing(clk);
    scen.next_tx(PAYER);
    {
        let refund = scen.take_from_sender<coin::Coin<SUI>>();
        assert!(coin::value(&refund) == 500, 0);
        ts::return_to_sender(&scen, refund);
    };
    scen.next_tx(PAYER);
    {
        let sb = scen.take_shared<Subscription>();
        assert!(sub::sub_escrow_value(&sb) == 3_000, 1);
        assert!(sub::sub_next_claim_at_ms(&sb) == 100, 2);
        ts::return_shared(sb);
    };
    scen.end();
}

#[test]
fun test_claim_due_pays_matured_periods() {
    let mut scen = ts::begin(PAYER);
    let mut clk = clock::create_for_testing(scen.ctx());
    let funding = coin::mint_for_testing<SUI>(3_000, scen.ctx());
    sub::create_subscription(PAYEE, s(b"plan"), 1_000, 100, 3, funding, &clk, scen.ctx());
    clock::set_for_testing(&mut clk, 250); // periods at 100 and 200 are due (2)
    scen.next_tx(PAYEE);
    {
        let mut sb = scen.take_shared<Subscription>();
        sub::claim_due(&mut sb, &clk, scen.ctx());
        assert!(sub::sub_periods_claimed(&sb) == 2, 0);
        assert!(sub::sub_escrow_value(&sb) == 1_000, 1);
        assert!(sub::sub_next_claim_at_ms(&sb) == 300, 2);
        ts::return_shared(sb);
    };
    scen.next_tx(PAYEE);
    {
        let paid = scen.take_from_sender<coin::Coin<SUI>>();
        assert!(coin::value(&paid) == 2_000, 3);
        ts::return_to_sender(&scen, paid);
    };
    clock::destroy_for_testing(clk);
    scen.end();
}

#[test]
#[expected_failure(abort_code = signet::subscription::ENothingDue)]
fun test_claim_nothing_due_aborts() {
    let mut scen = ts::begin(PAYER);
    let mut clk = clock::create_for_testing(scen.ctx());
    let funding = coin::mint_for_testing<SUI>(3_000, scen.ctx());
    sub::create_subscription(PAYEE, s(b"plan"), 1_000, 100, 3, funding, &clk, scen.ctx());
    clock::set_for_testing(&mut clk, 50); // before first period (100)
    scen.next_tx(PAYEE);
    {
        let mut sb = scen.take_shared<Subscription>();
        sub::claim_due(&mut sb, &clk, scen.ctx());
        ts::return_shared(sb);
    };
    clock::destroy_for_testing(clk);
    scen.end();
}

#[test]
#[expected_failure(abort_code = signet::subscription::ENotPayee)]
fun test_non_payee_cannot_claim() {
    let mut scen = ts::begin(PAYER);
    let clk = clock::create_for_testing(scen.ctx());
    let funding = coin::mint_for_testing<SUI>(3_000, scen.ctx());
    sub::create_subscription(PAYEE, s(b"plan"), 1_000, 100, 3, funding, &clk, scen.ctx());
    scen.next_tx(STRANGER);
    {
        let mut sb = scen.take_shared<Subscription>();
        sub::claim_due(&mut sb, &clk, scen.ctx());
        ts::return_shared(sb);
    };
    clock::destroy_for_testing(clk);
    scen.end();
}

#[test]
fun test_cancel_refunds_unclaimed() {
    let mut scen = ts::begin(PAYER);
    let mut clk = clock::create_for_testing(scen.ctx());
    let funding = coin::mint_for_testing<SUI>(3_000, scen.ctx());
    sub::create_subscription(PAYEE, s(b"plan"), 1_000, 100, 3, funding, &clk, scen.ctx());
    clock::set_for_testing(&mut clk, 150); // 1 period due
    scen.next_tx(PAYEE);
    {
        let mut sb = scen.take_shared<Subscription>();
        sub::claim_due(&mut sb, &clk, scen.ctx());
        ts::return_shared(sb);
    };
    scen.next_tx(PAYER);
    {
        let mut sb = scen.take_shared<Subscription>();
        sub::cancel(&mut sb, scen.ctx()); // refund remaining 2000 to payer
        assert!(sub::sub_cancelled(&sb), 0);
        assert!(sub::sub_escrow_value(&sb) == 0, 1);
        ts::return_shared(sb);
    };
    scen.next_tx(PAYER);
    {
        let refund = scen.take_from_sender<coin::Coin<SUI>>();
        assert!(coin::value(&refund) == 2_000, 2);
        ts::return_to_sender(&scen, refund);
    };
    clock::destroy_for_testing(clk);
    scen.end();
}

#[test]
#[expected_failure(abort_code = signet::subscription::EUnderfunded)]
fun test_underfunded_aborts() {
    let mut scen = ts::begin(PAYER);
    let clk = clock::create_for_testing(scen.ctx());
    let funding = coin::mint_for_testing<SUI>(2_999, scen.ctx()); // need 3000
    sub::create_subscription(PAYEE, s(b"plan"), 1_000, 100, 3, funding, &clk, scen.ctx());
    clock::destroy_for_testing(clk);
    scen.end();
}

#[test]
fun test_stream_vests_pro_rata() {
    let mut scen = ts::begin(PAYER);
    let mut clk = clock::create_for_testing(scen.ctx());
    let funding = coin::mint_for_testing<SUI>(1_000, scen.ctx());
    sub::create_stream(PAYEE, s(b"stream"), funding, 1_000, &clk, scen.ctx());
    clock::set_for_testing(&mut clk, 400); // 40% vested = 400
    scen.next_tx(PAYEE);
    {
        let mut st = scen.take_shared<Stream>();
        sub::claim_stream(&mut st, &clk, scen.ctx());
        assert!(sub::stream_claimed(&st) == 400, 0);
        assert!(sub::stream_escrow_value(&st) == 600, 1);
        ts::return_shared(st);
    };
    scen.next_tx(PAYEE);
    {
        let paid = scen.take_from_sender<coin::Coin<SUI>>();
        assert!(coin::value(&paid) == 400, 2);
        ts::return_to_sender(&scen, paid);
    };
    clock::destroy_for_testing(clk);
    scen.end();
}

#[test]
fun test_stream_cancel_splits() {
    let mut scen = ts::begin(PAYER);
    let mut clk = clock::create_for_testing(scen.ctx());
    let funding = coin::mint_for_testing<SUI>(1_000, scen.ctx());
    sub::create_stream(PAYEE, s(b"stream"), funding, 1_000, &clk, scen.ctx());
    clock::set_for_testing(&mut clk, 300); // 30% vested = 300
    scen.next_tx(PAYER);
    {
        let mut st = scen.take_shared<Stream>();
        sub::cancel_stream(&mut st, &clk, scen.ctx());
        assert!(sub::stream_cancelled(&st), 0);
        assert!(sub::stream_escrow_value(&st) == 0, 1);
        ts::return_shared(st);
    };
    scen.next_tx(PAYEE);
    {
        let vested = scen.take_from_sender<coin::Coin<SUI>>();
        assert!(coin::value(&vested) == 300, 2);
        ts::return_to_sender(&scen, vested);
    };
    scen.next_tx(PAYER);
    {
        let refund = scen.take_from_sender<coin::Coin<SUI>>();
        assert!(coin::value(&refund) == 700, 3);
        ts::return_to_sender(&scen, refund);
    };
    clock::destroy_for_testing(clk);
    scen.end();
}
