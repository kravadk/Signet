#[test_only]
module signet::governance_tests;

use std::string;
use sui::test_scenario::{Self as ts, Scenario};
use sui::clock;
use sui::coin;
use sui::sui::SUI;
use signet::playground::{Self as pg, Treasury, BuilderBoard};
use signet::governance::{Self as gov, Proposal};

const ADMIN: address = @0xA;
const V1: address = @0xB;   // score 100
const V2: address = @0xC;   // score 40
const NOPOWER: address = @0xE;
const RECIPIENT: address = @0xD;
const ANYONE: address = @0x9;

fun s(b: vector<u8>): string::String { string::utf8(b) }

// Treasury funded with 10_000, BuilderBoard with V1=100, V2=40.
fun setup(): Scenario {
    let mut scen = ts::begin(ADMIN);
    {
        let ctx = scen.ctx();
        pg::create_treasury(ADMIN, ctx);
        pg::create_builder_board(ctx);
    };
    scen.next_tx(ADMIN);
    {
        let mut t = scen.take_shared<Treasury>();
        let c = coin::mint_for_testing<SUI>(10_000, scen.ctx());
        pg::deposit_fee(&mut t, c);
        ts::return_shared(t);
    };
    scen.next_tx(ADMIN);
    {
        let mut board = scen.take_shared<BuilderBoard>();
        pg::set_score_for_testing(&mut board, V1, 100);
        pg::set_score_for_testing(&mut board, V2, 40);
        ts::return_shared(board);
    };
    scen
}

// open a proposal to pay RECIPIENT `amount`; voting 1000ms, timelock 500ms (clock starts at 0).
fun open(scen: &mut Scenario, clk: &clock::Clock, amount: u64) {
    scen.next_tx(V1);
    let t = scen.take_shared<Treasury>();
    gov::open_proposal(&t, RECIPIENT, amount, s(b"grant"), 1_000, 500, clk, scen.ctx());
    ts::return_shared(t);
}

fun cast(scen: &mut Scenario, clk: &clock::Clock, who: address, approve: bool) {
    scen.next_tx(who);
    let mut p = scen.take_shared<Proposal>();
    let board = scen.take_shared<BuilderBoard>();
    gov::vote(&mut p, &board, approve, clk, scen.ctx());
    ts::return_shared(board);
    ts::return_shared(p);
}

#[test]
fun test_proposal_passes_and_pays() {
    let mut scen = setup();
    let mut clk = clock::create_for_testing(scen.ctx());
    open(&mut scen, &clk, 5_000);
    cast(&mut scen, &clk, V1, true);   // +100 for
    cast(&mut scen, &clk, V2, false);  // +40 against
    clock::set_for_testing(&mut clk, 2_000); // past voting(1000)+timelock(500)
    scen.next_tx(ANYONE);
    {
        let mut p = scen.take_shared<Proposal>();
        let mut t = scen.take_shared<Treasury>();
        gov::execute(&mut p, &mut t, &clk, scen.ctx());
        assert!(gov::proposal_status(&p) == gov::status_executed(), 0);
        assert!(pg::treasury_balance(&t) == 5_000, 1); // 10_000 - 5_000
        ts::return_shared(t);
        ts::return_shared(p);
    };
    scen.next_tx(RECIPIENT);
    {
        let paid = scen.take_from_sender<coin::Coin<SUI>>();
        assert!(coin::value(&paid) == 5_000, 2);
        ts::return_to_sender(&scen, paid);
    };
    clock::destroy_for_testing(clk);
    scen.end();
}

#[test]
fun test_proposal_rejected_when_against_wins() {
    let mut scen = setup();
    let mut clk = clock::create_for_testing(scen.ctx());
    open(&mut scen, &clk, 5_000);
    cast(&mut scen, &clk, V1, false);  // 100 against
    cast(&mut scen, &clk, V2, true);   // 40 for
    clock::set_for_testing(&mut clk, 2_000);
    scen.next_tx(ANYONE);
    {
        let mut p = scen.take_shared<Proposal>();
        let mut t = scen.take_shared<Treasury>();
        gov::execute(&mut p, &mut t, &clk, scen.ctx());
        assert!(gov::proposal_status(&p) == gov::status_rejected(), 0);
        assert!(pg::treasury_balance(&t) == 10_000, 1); // untouched
        ts::return_shared(t);
        ts::return_shared(p);
    };
    clock::destroy_for_testing(clk);
    scen.end();
}

#[test]
#[expected_failure(abort_code = signet::governance::EAlreadyVoted)]
fun test_double_vote_aborts() {
    let mut scen = setup();
    let mut clk = clock::create_for_testing(scen.ctx());
    open(&mut scen, &clk, 1_000);
    cast(&mut scen, &clk, V1, true);
    cast(&mut scen, &clk, V1, true); // second vote by same address
    clock::destroy_for_testing(clk);
    scen.end();
}

#[test]
#[expected_failure(abort_code = signet::governance::ENoVotingPower)]
fun test_vote_without_power_aborts() {
    let mut scen = setup();
    let mut clk = clock::create_for_testing(scen.ctx());
    open(&mut scen, &clk, 1_000);
    cast(&mut scen, &clk, NOPOWER, true); // score 0
    clock::destroy_for_testing(clk);
    scen.end();
}

#[test]
#[expected_failure(abort_code = signet::governance::ETimelockActive)]
fun test_execute_before_timelock_aborts() {
    let mut scen = setup();
    let mut clk = clock::create_for_testing(scen.ctx());
    open(&mut scen, &clk, 1_000);
    cast(&mut scen, &clk, V1, true);
    clock::set_for_testing(&mut clk, 1_200); // past voting(1000) but before +timelock(500)
    scen.next_tx(ANYONE);
    {
        let mut p = scen.take_shared<Proposal>();
        let mut t = scen.take_shared<Treasury>();
        gov::execute(&mut p, &mut t, &clk, scen.ctx());
        ts::return_shared(t);
        ts::return_shared(p);
    };
    clock::destroy_for_testing(clk);
    scen.end();
}

#[test]
#[expected_failure(abort_code = signet::governance::EQuorumNotMet)]
fun test_no_quorum_aborts() {
    let mut scen = setup();
    let mut clk = clock::create_for_testing(scen.ctx());
    open(&mut scen, &clk, 1_000);
    // nobody votes
    clock::set_for_testing(&mut clk, 2_000);
    scen.next_tx(ANYONE);
    {
        let mut p = scen.take_shared<Proposal>();
        let mut t = scen.take_shared<Treasury>();
        gov::execute(&mut p, &mut t, &clk, scen.ctx());
        ts::return_shared(t);
        ts::return_shared(p);
    };
    clock::destroy_for_testing(clk);
    scen.end();
}
