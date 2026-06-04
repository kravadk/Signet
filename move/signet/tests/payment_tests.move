#[test_only]
module signet::payment_tests;

use std::string;
use std::option;
use sui::test_scenario::{Self as ts, Scenario};
use sui::clock;
use sui::coin;
use sui::sui::SUI;
use signet::payment::{Self as pay, PaymentRequest};

const CREATOR: address = @0xA;
const RECIPIENT: address = @0xB;
const PAYER: address = @0xC;
const STRANGER: address = @0xD;

fun s(b: vector<u8>): string::String { string::utf8(b) }

fun setup_request(): Scenario {
    let mut scen = ts::begin(CREATOR);
    {
        let clk = clock::create_for_testing(scen.ctx());
        pay::create_request(RECIPIENT, s(b"invoice-1"), 1_000, option::none(), &clk, scen.ctx());
        clock::destroy_for_testing(clk);
    };
    scen
}

#[test]
fun test_create_request_state() {
    let mut scen = setup_request();
    scen.next_tx(CREATOR);
    {
        let req = scen.take_shared<PaymentRequest>();
        assert!(pay::request_creator(&req) == CREATOR, 0);
        assert!(pay::request_recipient(&req) == RECIPIENT, 1);
        assert!(pay::request_amount(&req) == 1_000, 2);
        assert!(!pay::request_paid(&req), 3);
        assert!(!pay::request_cancelled(&req), 4);
        ts::return_shared(req);
    };
    scen.end();
}

#[test]
fun test_pay_request_refunds_overpayment() {
    let mut scen = setup_request();
    scen.next_tx(PAYER);
    {
        let mut req = scen.take_shared<PaymentRequest>();
        let payment = coin::mint_for_testing<SUI>(1_500, scen.ctx());
        let clk = clock::create_for_testing(scen.ctx());
        pay::pay(&mut req, payment, &clk, scen.ctx());
        clock::destroy_for_testing(clk);
        assert!(pay::request_paid(&req), 0);
        let payer = pay::request_payer(&req);
        assert!(*option::borrow(&payer) == PAYER, 1);
        ts::return_shared(req);
    };
    scen.next_tx(PAYER);
    {
        let refund = scen.take_from_sender<coin::Coin<SUI>>();
        assert!(coin::value(&refund) == 500, 0);
        ts::return_to_sender(&scen, refund);
    };
    scen.next_tx(RECIPIENT);
    {
        let paid = scen.take_from_sender<coin::Coin<SUI>>();
        assert!(coin::value(&paid) == 1_000, 0);
        ts::return_to_sender(&scen, paid);
    };
    scen.end();
}

#[test]
#[expected_failure(abort_code = signet::payment::EUnderpaid)]
fun test_underpaid_aborts() {
    let mut scen = setup_request();
    scen.next_tx(PAYER);
    {
        let mut req = scen.take_shared<PaymentRequest>();
        let payment = coin::mint_for_testing<SUI>(999, scen.ctx());
        let clk = clock::create_for_testing(scen.ctx());
        pay::pay(&mut req, payment, &clk, scen.ctx());
        clock::destroy_for_testing(clk);
        ts::return_shared(req);
    };
    scen.end();
}

#[test]
fun test_creator_can_cancel() {
    let mut scen = setup_request();
    scen.next_tx(CREATOR);
    {
        let mut req = scen.take_shared<PaymentRequest>();
        pay::cancel(&mut req, scen.ctx());
        assert!(pay::request_cancelled(&req), 0);
        ts::return_shared(req);
    };
    scen.end();
}

#[test]
#[expected_failure(abort_code = signet::payment::ENotController)]
fun test_stranger_cannot_cancel() {
    let mut scen = setup_request();
    scen.next_tx(STRANGER);
    {
        let mut req = scen.take_shared<PaymentRequest>();
        pay::cancel(&mut req, scen.ctx());
        ts::return_shared(req);
    };
    scen.end();
}
