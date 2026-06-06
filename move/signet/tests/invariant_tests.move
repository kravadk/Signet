#[test_only]
/// Property / invariant tests. Move has no built-in fuzzer, so these assert a
/// safety invariant across a TABLE of diverse inputs (the idiomatic Move
/// equivalent of property testing) rather than a single example.
module signet::invariant_tests;

use std::string;
use std::option;
use sui::test_scenario::{Self as ts};
use sui::clock;
use sui::coin;
use sui::sui::SUI;
use signet::payment::{Self as pay, PaymentRequest};

const CREATOR: address = @0xA;
const RECIPIENT: address = @0xB;
const PAYER: address = @0xC;

fun s(b: vector<u8>): string::String { string::utf8(b) }

/// INVARIANT (escrow conservation): for any valid payment where `paid >= amount`,
/// `pay()` transfers EXACTLY `amount` to the recipient and refunds EXACTLY
/// `paid - amount` to the payer — no value is minted or burned.
fun assert_payment_conserves(amount: u64, paid: u64) {
    let mut scen = ts::begin(CREATOR);
    {
        let clk = clock::create_for_testing(scen.ctx());
        pay::create_request(RECIPIENT, s(b"inv"), amount, option::none(), &clk, scen.ctx());
        clock::destroy_for_testing(clk);
    };
    scen.next_tx(PAYER);
    {
        let mut req = scen.take_shared<PaymentRequest>();
        let c = coin::mint_for_testing<SUI>(paid, scen.ctx());
        let clk = clock::create_for_testing(scen.ctx());
        pay::pay(&mut req, c, &clk, scen.ctx());
        clock::destroy_for_testing(clk);
        ts::return_shared(req);
    };
    // recipient received exactly `amount`
    scen.next_tx(RECIPIENT);
    {
        let got = scen.take_from_sender<coin::Coin<SUI>>();
        assert!(coin::value(&got) == amount, 100);
        ts::return_to_sender(&scen, got);
    };
    // payer refunded exactly the overpayment (a refund coin exists only when paid > amount)
    if (paid > amount) {
        scen.next_tx(PAYER);
        {
            let refund = scen.take_from_sender<coin::Coin<SUI>>();
            assert!(coin::value(&refund) == paid - amount, 101);
            ts::return_to_sender(&scen, refund);
        };
    };
    scen.end();
}

#[test]
fun payment_value_is_conserved_across_inputs() {
    assert_payment_conserves(1_000, 1_000);                 // exact, no refund
    assert_payment_conserves(1_000, 1_500);                 // overpay 500
    assert_payment_conserves(1, 1_000_000);                 // tiny invoice, large overpay
    assert_payment_conserves(7_777, 9_999);                 // odd values
    assert_payment_conserves(1_000_000_000, 1_000_000_001); // off-by-one overpay
    assert_payment_conserves(500_000, 500_001);             // minimal overpay
}
