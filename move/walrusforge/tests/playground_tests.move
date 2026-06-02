#[test_only]
module walrusforge::playground_tests;

use std::string;
use std::option;
use sui::test_scenario::{Self as ts, Scenario};
use sui::clock;
use sui::coin;
use sui::sui::SUI;
use walrusforge::playground::{Self as pg, PublishedApp, StarRegistry, BuilderBoard, FlagRegistry, NameRegistry, Treasury, AppBounty, ForkRegistry, PrivacyRegistry};

const BUILDER: address = @0xA;
const VISITOR: address = @0xB;
const TIPPER: address = @0xC;

fun s(b: vector<u8>): string::String { string::utf8(b) }

fun setup(): Scenario {
    let mut scen = ts::begin(BUILDER);
    { pg::init_for_testing(scen.ctx()); };
    scen
}

/// Publish one app from BUILDER.
fun publish_one(scen: &mut Scenario) {
    scen.next_tx(BUILDER);
    {
        let mut board = scen.take_shared<BuilderBoard>();
        let clk = clock::create_for_testing(scen.ctx());
        pg::publish_app_v2(
            s(b"pomodoro-timer"), s(b"a pomodoro timer with a ring"),
            s(b"manifest_blob_1"), s(b"archive_blob_1"), s(b"treehash_1"),
            s(b"tool"), option::none(), &mut board, &clk, scen.ctx(),
        );
        clock::destroy_for_testing(clk);
        ts::return_shared(board);
    };
}

#[test]
fun test_publish_sets_initial_state() {
    let mut scen = setup();
    publish_one(&mut scen);
    scen.next_tx(BUILDER);
    {
        let app = scen.take_shared<PublishedApp>();
        assert!(pg::builder(&app) == BUILDER, 0);
        assert!(pg::visits(&app) == 0, 1);
        assert!(pg::stars(&app) == 0, 2);
        assert!(pg::tips_total(&app) == 0, 3);
        assert!(option::is_none(pg::parent(&app)), 4);
        ts::return_shared(app);
    };
    scen.end();
}

#[test]
fun test_record_visit_increments() {
    let mut scen = setup();
    publish_one(&mut scen);
    scen.next_tx(VISITOR);
    {
        let mut app = scen.take_shared<PublishedApp>();
        pg::record_visit(&mut app);
        pg::record_visit(&mut app);
        assert!(pg::visits(&app) == 2, 0);
        ts::return_shared(app);
    };
    scen.end();
}

#[test]
fun test_star_increments() {
    let mut scen = setup();
    publish_one(&mut scen);
    scen.next_tx(VISITOR);
    {
        let mut app = scen.take_shared<PublishedApp>();
        let mut reg = scen.take_shared<StarRegistry>();
        let mut board = scen.take_shared<BuilderBoard>();
        pg::star_v2(&mut app, &mut reg, &mut board, scen.ctx());
        assert!(pg::stars(&app) == 1, 0);
        ts::return_shared(app);
        ts::return_shared(reg);
        ts::return_shared(board);
    };
    scen.end();
}

#[test]
#[expected_failure(abort_code = walrusforge::playground::EAlreadyStarred)]
fun test_double_star_aborts() {
    let mut scen = setup();
    publish_one(&mut scen);
    scen.next_tx(VISITOR);
    {
        let mut app = scen.take_shared<PublishedApp>();
        let mut reg = scen.take_shared<StarRegistry>();
        let mut board = scen.take_shared<BuilderBoard>();
        pg::star_v2(&mut app, &mut reg, &mut board, scen.ctx());
        pg::star_v2(&mut app, &mut reg, &mut board, scen.ctx()); // same address again -> abort
        ts::return_shared(app);
        ts::return_shared(reg);
        ts::return_shared(board);
    };
    scen.end();
}

#[test]
#[expected_failure(abort_code = walrusforge::playground::ECannotStarOwn)]
fun test_star_own_aborts() {
    let mut scen = setup();
    publish_one(&mut scen);
    scen.next_tx(BUILDER); // builder stars own app -> abort
    {
        let mut app = scen.take_shared<PublishedApp>();
        let mut reg = scen.take_shared<StarRegistry>();
        let mut board = scen.take_shared<BuilderBoard>();
        pg::star_v2(&mut app, &mut reg, &mut board, scen.ctx());
        ts::return_shared(app);
        ts::return_shared(reg);
        ts::return_shared(board);
    };
    scen.end();
}

#[test]
fun test_remix_records_parent() {
    let mut scen = setup();
    publish_one(&mut scen);
    scen.next_tx(VISITOR);
    let parent_id;
    {
        let app = scen.take_shared<PublishedApp>();
        parent_id = object::id(&app);
        ts::return_shared(app);
    };
    scen.next_tx(VISITOR);
    {
        let mut board = scen.take_shared<BuilderBoard>();
        let clk = clock::create_for_testing(scen.ctx());
        pg::publish_app_v2(
            s(b"pomodoro-remix"), s(b"pomodoro but blue"),
            s(b"manifest_blob_2"), s(b"archive_blob_2"), s(b"treehash_2"),
            s(b"tool"), option::some(parent_id), &mut board, &clk, scen.ctx(),
        );
        clock::destroy_for_testing(clk);
        ts::return_shared(board);
    };
    scen.next_tx(VISITOR);
    {
        let a = scen.take_shared<PublishedApp>();
        let b = scen.take_shared<PublishedApp>();
        let remix = if (pg::builder(&a) == VISITOR && option::is_some(pg::parent(&a))) { &a } else { &b };
        assert!(option::is_some(pg::parent(remix)), 0);
        assert!(*option::borrow(pg::parent(remix)) == parent_id, 1);
        ts::return_shared(a);
        ts::return_shared(b);
    };
    scen.end();
}

#[test]
fun test_tip_forwards_to_builder() {
    let mut scen = setup();
    publish_one(&mut scen);
    scen.next_tx(TIPPER);
    {
        let mut app = scen.take_shared<PublishedApp>();
        let pay = coin::mint_for_testing<SUI>(1_000_000, scen.ctx());
        pg::tip_app(&mut app, pay, scen.ctx());
        // 2.5% fee -> builder credited 975_000
        assert!(pg::tips_total(&app) == 975_000, 0);
        ts::return_shared(app);
    };
    scen.end();
}

#[test]
fun test_builder_score_increments() {
    let mut scen = setup();
    publish_one(&mut scen); // BUILDER publishes 1 app -> apps=1, score = 5
    scen.next_tx(VISITOR);
    {
        let mut app = scen.take_shared<PublishedApp>();
        let mut reg = scen.take_shared<StarRegistry>();
        let mut board = scen.take_shared<BuilderBoard>();
        pg::star_v2(&mut app, &mut reg, &mut board, scen.ctx()); // +1 star to BUILDER -> stars=1
        // score = apps(1)*5 + stars(1)*3 = 8
        assert!(pg::builder_score(&board, BUILDER) == 8, 0);
        assert!(pg::builder_apps(&board, BUILDER) == 1, 1);
        ts::return_shared(app);
        ts::return_shared(reg);
        ts::return_shared(board);
    };
    scen.end();
}

#[test]
fun test_remix_credits_parent_reputation() {
    let mut scen = setup();
    publish_one(&mut scen); // BUILDER publishes -> apps=1, score=5
    // VISITOR remixes BUILDER's app via publish_remix_v3.
    scen.next_tx(VISITOR);
    {
        let parent = scen.take_shared<PublishedApp>();
        let mut board = scen.take_shared<BuilderBoard>();
        let clk = clock::create_for_testing(scen.ctx());
        pg::publish_remix_v3(
            s(b"pomodoro-remix"), s(b"pomodoro but neon"),
            s(b"manifest_blob_r"), s(b"archive_blob_r"), s(b"treehash_r"),
            s(b"tool"), &parent, &mut board, &clk, scen.ctx(),
        );
        clock::destroy_for_testing(clk);
        // VISITOR earned an app; BUILDER earned a remix.
        assert!(pg::builder_apps(&board, VISITOR) == 1, 0);
        assert!(pg::builder_remixes(&board, BUILDER) == 1, 1);
        // BUILDER score = apps(1)*5 + remixes(1)*4 = 9
        assert!(pg::builder_score(&board, BUILDER) == 9, 2);
        // VISITOR score = apps(1)*5 = 5
        assert!(pg::builder_score(&board, VISITOR) == 5, 3);
        ts::return_shared(parent);
        ts::return_shared(board);
    };
    scen.end();
}

#[test]
fun test_self_remix_does_not_farm_score() {
    let mut scen = setup();
    publish_one(&mut scen); // BUILDER publishes -> apps=1, score=5
    // BUILDER remixes their OWN app -> apps=2, but remixes_received stays 0.
    scen.next_tx(BUILDER);
    {
        let parent = scen.take_shared<PublishedApp>();
        let mut board = scen.take_shared<BuilderBoard>();
        let clk = clock::create_for_testing(scen.ctx());
        pg::publish_remix_v3(
            s(b"self-remix"), s(b"my own remix"),
            s(b"manifest_blob_s"), s(b"archive_blob_s"), s(b"treehash_s"),
            s(b"tool"), &parent, &mut board, &clk, scen.ctx(),
        );
        clock::destroy_for_testing(clk);
        assert!(pg::builder_apps(&board, BUILDER) == 2, 0);
        assert!(pg::builder_remixes(&board, BUILDER) == 0, 1); // no self-credit
        assert!(pg::builder_score(&board, BUILDER) == 10, 2);  // apps(2)*5 only
        ts::return_shared(parent);
        ts::return_shared(board);
    };
    scen.end();
}

#[test]
fun test_flag_increments() {
    let mut scen = setup();
    publish_one(&mut scen);
    scen.next_tx(VISITOR);
    {
        let app = scen.take_shared<PublishedApp>();
        let mut freg = scen.take_shared<FlagRegistry>();
        let id = object::id(&app);
        pg::flag_app(&app, &mut freg, scen.ctx());
        assert!(pg::flag_count(&freg, id) == 1, 0);
        ts::return_shared(app);
        ts::return_shared(freg);
    };
    scen.end();
}

#[test]
#[expected_failure(abort_code = walrusforge::playground::EAlreadyFlagged)]
fun test_double_flag_aborts() {
    let mut scen = setup();
    publish_one(&mut scen);
    scen.next_tx(VISITOR);
    {
        let app = scen.take_shared<PublishedApp>();
        let mut freg = scen.take_shared<FlagRegistry>();
        pg::flag_app(&app, &mut freg, scen.ctx());
        pg::flag_app(&app, &mut freg, scen.ctx()); // same address -> abort
        ts::return_shared(app);
        ts::return_shared(freg);
    };
    scen.end();
}

#[test]
fun test_builder_can_hide() {
    let mut scen = setup();
    publish_one(&mut scen);
    scen.next_tx(BUILDER);
    {
        let app = scen.take_shared<PublishedApp>();
        let mut freg = scen.take_shared<FlagRegistry>();
        let id = object::id(&app);
        pg::set_hidden(&app, &mut freg, true, scen.ctx());
        assert!(pg::is_hidden(&freg, id), 0);
        pg::set_hidden(&app, &mut freg, false, scen.ctx());
        assert!(!pg::is_hidden(&freg, id), 1);
        ts::return_shared(app);
        ts::return_shared(freg);
    };
    scen.end();
}

#[test]
#[expected_failure(abort_code = walrusforge::playground::ENotBuilder)]
fun test_non_builder_cannot_hide() {
    let mut scen = setup();
    publish_one(&mut scen);
    scen.next_tx(VISITOR); // not the builder
    {
        let app = scen.take_shared<PublishedApp>();
        let mut freg = scen.take_shared<FlagRegistry>();
        pg::set_hidden(&app, &mut freg, true, scen.ctx());
        ts::return_shared(app);
        ts::return_shared(freg);
    };
    scen.end();
}

// ===== Versioning =====

#[test]
fun test_update_app_rewrites_content() {
    let mut scen = setup();
    publish_one(&mut scen);
    scen.next_tx(BUILDER);
    {
        let mut app = scen.take_shared<PublishedApp>();
        let clk = clock::create_for_testing(scen.ctx());
        pg::update_app(&mut app, s(b"manifest_v2"), s(b"archive_v2"), s(b"treehash_v2"), &clk, scen.ctx());
        assert!(pg::tree_hash(&app) == s(b"treehash_v2"), 0);
        clock::destroy_for_testing(clk);
        ts::return_shared(app);
    };
    scen.end();
}

#[test]
#[expected_failure(abort_code = walrusforge::playground::ENotBuilder)]
fun test_non_builder_cannot_update() {
    let mut scen = setup();
    publish_one(&mut scen);
    scen.next_tx(VISITOR); // not the builder
    {
        let mut app = scen.take_shared<PublishedApp>();
        let clk = clock::create_for_testing(scen.ctx());
        pg::update_app(&mut app, s(b"x"), s(b"y"), s(b"z"), &clk, scen.ctx());
        clock::destroy_for_testing(clk);
        ts::return_shared(app);
    };
    scen.end();
}

// ===== Namespace =====

#[test]
fun test_claim_and_release_name() {
    let mut scen = setup();
    scen.next_tx(BUILDER);
    {
        let mut reg = scen.take_shared<NameRegistry>();
        pg::claim_name(&mut reg, s(b"alice"), scen.ctx());
        assert!(option::is_some(&pg::name_owner(&reg, s(b"alice"))), 0);
        assert!(*option::borrow(&pg::name_owner(&reg, s(b"alice"))) == BUILDER, 1);
        assert!(option::is_some(&pg::name_of_owner(&reg, BUILDER)), 2);
        pg::release_name(&mut reg, scen.ctx());
        assert!(option::is_none(&pg::name_owner(&reg, s(b"alice"))), 3);
        ts::return_shared(reg);
    };
    scen.end();
}

#[test]
#[expected_failure(abort_code = walrusforge::playground::ENameTaken)]
fun test_name_taken_aborts() {
    let mut scen = setup();
    scen.next_tx(BUILDER);
    {
        let mut reg = scen.take_shared<NameRegistry>();
        pg::claim_name(&mut reg, s(b"alice"), scen.ctx());
        ts::return_shared(reg);
    };
    scen.next_tx(VISITOR); // different address claims the same name -> abort
    {
        let mut reg = scen.take_shared<NameRegistry>();
        pg::claim_name(&mut reg, s(b"alice"), scen.ctx());
        ts::return_shared(reg);
    };
    scen.end();
}

// ===== Treasury / tip v2 =====

#[test]
fun test_tip_v2_accrues_fee_to_treasury() {
    let mut scen = setup();
    publish_one(&mut scen);
    scen.next_tx(TIPPER);
    {
        let mut app = scen.take_shared<PublishedApp>();
        let mut treasury = scen.take_shared<Treasury>();
        let pay = coin::mint_for_testing<SUI>(1_000_000, scen.ctx());
        pg::tip_app_v2(&mut app, &mut treasury, pay, scen.ctx());
        // fee = 2.5% = 25_000 to treasury; builder credited 975_000
        assert!(pg::treasury_balance(&treasury) == 25_000, 0);
        assert!(pg::tips_total(&app) == 975_000, 1);
        ts::return_shared(app);
        ts::return_shared(treasury);
    };
    scen.end();
}

#[test]
fun test_admin_can_withdraw_treasury() {
    let mut scen = setup(); // admin = BUILDER (setup begins as BUILDER)
    publish_one(&mut scen);
    scen.next_tx(TIPPER);
    {
        let mut app = scen.take_shared<PublishedApp>();
        let mut treasury = scen.take_shared<Treasury>();
        let pay = coin::mint_for_testing<SUI>(1_000_000, scen.ctx());
        pg::tip_app_v2(&mut app, &mut treasury, pay, scen.ctx());
        ts::return_shared(app);
        ts::return_shared(treasury);
    };
    scen.next_tx(BUILDER); // admin withdraws
    {
        let mut treasury = scen.take_shared<Treasury>();
        pg::withdraw_treasury(&mut treasury, 25_000, scen.ctx());
        assert!(pg::treasury_balance(&treasury) == 0, 0);
        ts::return_shared(treasury);
    };
    scen.end();
}

#[test]
#[expected_failure(abort_code = walrusforge::playground::ENotAdmin)]
fun test_non_admin_cannot_withdraw() {
    let mut scen = setup();
    scen.next_tx(VISITOR); // not the admin
    {
        let mut treasury = scen.take_shared<Treasury>();
        pg::withdraw_treasury(&mut treasury, 0, scen.ctx());
        ts::return_shared(treasury);
    };
    scen.end();
}

// ===== App bounties =====

/// TIPPER posts a bounty; helper to create it.
fun post_bounty(scen: &mut Scenario) {
    scen.next_tx(TIPPER);
    {
        let clk = clock::create_for_testing(scen.ctx());
        let pay = coin::mint_for_testing<SUI>(1_000_000, scen.ctx());
        pg::post_app_bounty(s(b"build a neon clock"), pay, &clk, scen.ctx());
        clock::destroy_for_testing(clk);
    };
}

#[test]
fun test_post_and_award_bounty() {
    let mut scen = setup();
    publish_one(&mut scen);   // BUILDER's app
    post_bounty(&mut scen);   // TIPPER posts 1_000_000
    scen.next_tx(TIPPER);
    {
        let mut bounty = scen.take_shared<AppBounty>();
        let app = scen.take_shared<PublishedApp>();
        let mut treasury = scen.take_shared<Treasury>();
        assert!(pg::bounty_open(&bounty), 0);
        assert!(pg::bounty_reward(&bounty) == 1_000_000, 1);
        pg::award_app_bounty(&mut bounty, &app, &mut treasury, scen.ctx());
        // 2.5% fee to treasury; bounty closed; winner = BUILDER
        assert!(pg::treasury_balance(&treasury) == 25_000, 2);
        assert!(!pg::bounty_open(&bounty), 3);
        assert!(option::is_some(pg::bounty_winner(&bounty)), 4);
        assert!(*option::borrow(pg::bounty_winner(&bounty)) == BUILDER, 5);
        assert!(pg::bounty_reward(&bounty) == 0, 6);
        ts::return_shared(bounty);
        ts::return_shared(app);
        ts::return_shared(treasury);
    };
    scen.end();
}

#[test]
#[expected_failure(abort_code = walrusforge::playground::ENotPoster)]
fun test_non_poster_cannot_award() {
    let mut scen = setup();
    publish_one(&mut scen);
    post_bounty(&mut scen);
    scen.next_tx(VISITOR); // not the poster
    {
        let mut bounty = scen.take_shared<AppBounty>();
        let app = scen.take_shared<PublishedApp>();
        let mut treasury = scen.take_shared<Treasury>();
        pg::award_app_bounty(&mut bounty, &app, &mut treasury, scen.ctx());
        ts::return_shared(bounty);
        ts::return_shared(app);
        ts::return_shared(treasury);
    };
    scen.end();
}

#[test]
#[expected_failure(abort_code = walrusforge::playground::EBountyClosed)]
fun test_double_award_aborts() {
    let mut scen = setup();
    publish_one(&mut scen);
    post_bounty(&mut scen);
    scen.next_tx(TIPPER);
    {
        let mut bounty = scen.take_shared<AppBounty>();
        let app = scen.take_shared<PublishedApp>();
        let mut treasury = scen.take_shared<Treasury>();
        pg::award_app_bounty(&mut bounty, &app, &mut treasury, scen.ctx());
        pg::award_app_bounty(&mut bounty, &app, &mut treasury, scen.ctx()); // closed -> abort
        ts::return_shared(bounty);
        ts::return_shared(app);
        ts::return_shared(treasury);
    };
    scen.end();
}

#[test]
fun test_cancel_bounty_refunds() {
    let mut scen = setup();
    post_bounty(&mut scen);
    scen.next_tx(TIPPER);
    {
        let mut bounty = scen.take_shared<AppBounty>();
        pg::cancel_app_bounty(&mut bounty, scen.ctx());
        assert!(!pg::bounty_open(&bounty), 0);
        assert!(pg::bounty_reward(&bounty) == 0, 1);
        ts::return_shared(bounty);
    };
    scen.end();
}

#[test]
#[expected_failure(abort_code = walrusforge::playground::EZeroReward)]
fun test_zero_reward_bounty_aborts() {
    let mut scen = setup();
    scen.next_tx(TIPPER);
    {
        let clk = clock::create_for_testing(scen.ctx());
        let pay = coin::mint_for_testing<SUI>(0, scen.ctx());
        pg::post_app_bounty(s(b"free?"), pay, &clk, scen.ctx());
        clock::destroy_for_testing(clk);
    };
    scen.end();
}

// ===== Paid fork (licensed remix) =====

/// BUILDER sets a fork price on their app.
fun set_price(scen: &mut Scenario, price: u64) {
    scen.next_tx(BUILDER);
    {
        let app = scen.take_shared<PublishedApp>();
        let mut reg = scen.take_shared<ForkRegistry>();
        pg::set_fork_price(&mut reg, &app, price, scen.ctx());
        ts::return_shared(app);
        ts::return_shared(reg);
    };
}

#[test]
fun test_set_and_clear_fork_price() {
    let mut scen = setup();
    publish_one(&mut scen);
    set_price(&mut scen, 1_000_000);
    scen.next_tx(BUILDER);
    {
        let app = scen.take_shared<PublishedApp>();
        let reg = scen.take_shared<ForkRegistry>();
        assert!(pg::fork_price(&reg, object::id(&app)) == 1_000_000, 0);
        ts::return_shared(app);
        ts::return_shared(reg);
    };
    set_price(&mut scen, 0); // clear -> free to remix again
    scen.next_tx(BUILDER);
    {
        let app = scen.take_shared<PublishedApp>();
        let reg = scen.take_shared<ForkRegistry>();
        assert!(pg::fork_price(&reg, object::id(&app)) == 0, 1);
        ts::return_shared(app);
        ts::return_shared(reg);
    };
    scen.end();
}

#[test]
#[expected_failure(abort_code = walrusforge::playground::ENotBuilder)]
fun test_non_builder_cannot_set_price() {
    let mut scen = setup();
    publish_one(&mut scen);
    scen.next_tx(VISITOR); // not the builder
    {
        let app = scen.take_shared<PublishedApp>();
        let mut reg = scen.take_shared<ForkRegistry>();
        pg::set_fork_price(&mut reg, &app, 1_000_000, scen.ctx());
        ts::return_shared(app);
        ts::return_shared(reg);
    };
    scen.end();
}

#[test]
fun test_pay_to_fork_pays_builder_minus_fee_and_refunds_excess() {
    let mut scen = setup();
    publish_one(&mut scen);             // BUILDER's app
    set_price(&mut scen, 1_000_000);    // price = 1_000_000 MIST
    // VISITOR overpays 1_500_000 to license a fork.
    scen.next_tx(VISITOR);
    {
        let app = scen.take_shared<PublishedApp>();
        let reg = scen.take_shared<ForkRegistry>();
        let mut treasury = scen.take_shared<Treasury>();
        let pay = coin::mint_for_testing<SUI>(1_500_000, scen.ctx());
        pg::pay_to_fork(&reg, &app, &mut treasury, pay, scen.ctx());
        // fee = 2.5% of price = 25_000 → treasury
        assert!(pg::treasury_balance(&treasury) == 25_000, 0);
        ts::return_shared(app);
        ts::return_shared(reg);
        ts::return_shared(treasury);
    };
    // VISITOR was refunded the 500_000 overpayment.
    scen.next_tx(VISITOR);
    {
        let refund = ts::take_from_sender<coin::Coin<SUI>>(&scen);
        assert!(coin::value(&refund) == 500_000, 1);
        ts::return_to_sender(&scen, refund);
    };
    // BUILDER received price - fee = 975_000.
    scen.next_tx(BUILDER);
    {
        let paid = ts::take_from_sender<coin::Coin<SUI>>(&scen);
        assert!(coin::value(&paid) == 975_000, 2);
        ts::return_to_sender(&scen, paid);
    };
    scen.end();
}

#[test]
#[expected_failure(abort_code = walrusforge::playground::ENotForkable)]
fun test_pay_to_fork_unpriced_aborts() {
    let mut scen = setup();
    publish_one(&mut scen); // no fork price set
    scen.next_tx(VISITOR);
    {
        let app = scen.take_shared<PublishedApp>();
        let reg = scen.take_shared<ForkRegistry>();
        let mut treasury = scen.take_shared<Treasury>();
        let pay = coin::mint_for_testing<SUI>(1_000_000, scen.ctx());
        pg::pay_to_fork(&reg, &app, &mut treasury, pay, scen.ctx());
        ts::return_shared(app);
        ts::return_shared(reg);
        ts::return_shared(treasury);
    };
    scen.end();
}

#[test]
#[expected_failure(abort_code = walrusforge::playground::EUnderpaid)]
fun test_pay_to_fork_underpaid_aborts() {
    let mut scen = setup();
    publish_one(&mut scen);
    set_price(&mut scen, 1_000_000);
    scen.next_tx(VISITOR);
    {
        let app = scen.take_shared<PublishedApp>();
        let reg = scen.take_shared<ForkRegistry>();
        let mut treasury = scen.take_shared<Treasury>();
        let pay = coin::mint_for_testing<SUI>(500_000, scen.ctx()); // below price
        pg::pay_to_fork(&reg, &app, &mut treasury, pay, scen.ctx());
        ts::return_shared(app);
        ts::return_shared(reg);
        ts::return_shared(treasury);
    };
    scen.end();
}

// ===== Private apps (Seal owner-only) =====

#[test]
fun test_set_and_unset_private() {
    let mut scen = setup();
    publish_one(&mut scen);
    scen.next_tx(BUILDER);
    {
        let app = scen.take_shared<PublishedApp>();
        let mut reg = scen.take_shared<PrivacyRegistry>();
        let id = object::id(&app);
        assert!(!pg::is_private(&reg, id), 0); // public by default
        pg::set_private(&mut reg, &app, true, scen.ctx());
        assert!(pg::is_private(&reg, id), 1);
        pg::set_private(&mut reg, &app, false, scen.ctx());
        assert!(!pg::is_private(&reg, id), 2);
        ts::return_shared(app);
        ts::return_shared(reg);
    };
    scen.end();
}

#[test]
#[expected_failure(abort_code = walrusforge::playground::ENotBuilder)]
fun test_non_builder_cannot_set_private() {
    let mut scen = setup();
    publish_one(&mut scen);
    scen.next_tx(VISITOR); // not the builder
    {
        let app = scen.take_shared<PublishedApp>();
        let mut reg = scen.take_shared<PrivacyRegistry>();
        pg::set_private(&mut reg, &app, true, scen.ctx());
        ts::return_shared(app);
        ts::return_shared(reg);
    };
    scen.end();
}
