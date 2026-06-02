/// Playground apps for WalrusForge — agent-built apps published on-chain.
///
/// A builder (human or AI agent) describes an app, an LLM generates it, and it is
/// published here: the app bytes live in Walrus (referenced by `manifest_blob` /
/// `archive_blob`), and this object anchors the verifiable metadata on Sui — the
/// prompt, the content tree hash, the builder, the remix lineage, and the
/// tamper-proof usage metrics (visits, stars, tips). Unlike a centralized gallery,
/// every number here is on-chain and unfakeable, and `parent` forms a verifiable
/// fork graph.
module walrusforge::playground;

use std::string::String;
use sui::balance::{Self, Balance};
use sui::coin::{Self, Coin};
use sui::sui::SUI;
use sui::clock::{Self, Clock};
use sui::table::{Self, Table};
use sui::vec_set::{Self, VecSet};
use sui::event;

// ===== Errors =====
const EAlreadyStarred: u64 = 0;
const ECannotStarOwn: u64 = 1;
const EZeroTip: u64 = 2;
const EAlreadyFlagged: u64 = 3;
const ENotBuilder: u64 = 4;
const ENameTaken: u64 = 5;
const ENameNotOwned: u64 = 6;
const ENotAdmin: u64 = 7;
const ENotPoster: u64 = 8;
const EBountyClosed: u64 = 9;
const EZeroReward: u64 = 10;
const ENotForkable: u64 = 11;  // app has no fork price set (free to remix, or not for sale)
const EUnderpaid: u64 = 12;    // payment below the builder-set fork price
const ENotAppOwner: u64 = 13;  // Seal: requester is not the app's builder
const ESealIdMismatch: u64 = 14; // Seal: identity not namespaced to this app

/// Protocol fee on tips, basis points (2.5%) — mirrors bounty.move.
const FEE_BPS: u64 = 250;

// ===== Objects =====

/// A published Playground app. Shared so the gallery and visitors can interact.
public struct PublishedApp has key {
    id: UID,
    builder: address,
    name: String,
    prompt: String,
    manifest_blob: String,   // Walrus manifest blobId (verifiable snapshot)
    archive_blob: String,    // Walrus archive blobId (the app bytes)
    tree_hash: String,       // sha256 tree hash, anchored on-chain
    parent: Option<ID>,      // lineage: the app this was remixed from
    category: String,
    visits: u64,
    stars: u64,
    tips_total: u64,         // cumulative tips received (MIST)
    created_at_ms: u64,
}

/// One-per-address star ledger so stars are a credible, unfakeable metric.
/// Shared singleton created at publish (module init).
public struct StarRegistry has key {
    id: UID,
    starred: Table<ID, VecSet<address>>,
}

/// Per-builder on-chain reputation, earned from verifiable Playground activity.
public struct BuilderProfile has store, copy, drop {
    apps_published: u64,
    stars_received: u64,
    remixes_received: u64,
    score: u64,            // apps*5 + stars*3 + remixes*4 (earned, not self-reported)
}

/// Shared ledger of builder profiles (separate object so it can be added in an
/// upgrade without altering the already-deployed StarRegistry).
public struct BuilderBoard has key {
    id: UID,
    builders: Table<address, BuilderProfile>,
}

/// Lightweight moderation ledger (separate shared object, upgrade-safe):
/// community flags (one-per-address) + a builder-set hidden flag per app.
public struct FlagRegistry has key {
    id: UID,
    flags: Table<ID, VecSet<address>>,  // app_id -> set of flaggers
    hidden: Table<ID, bool>,            // app_id -> hidden by its builder
}

/// Unique human handle registry (separate shared object, upgrade-safe). Gives
/// builders a claimable name (e.g. `@alice`) for real, human-readable profile
/// URLs — a scarce namespace with on-chain ownership. One handle per address.
public struct NameRegistry has key {
    id: UID,
    owner_of: Table<String, address>,  // handle -> owner
    name_of: Table<address, String>,   // owner -> handle (one per address)
}

/// Protocol treasury (separate shared object, upgrade-safe). Accrues the real
/// tip fee (vs the original `tip_app`, which refunded the fee). Admin-withdrawable.
public struct Treasury has key {
    id: UID,
    admin: address,
    balance: Balance<SUI>,
}

/// An app bounty: "build an app that does X, get Y SUI". The poster escrows the
/// reward; a builder publishes an app; the poster awards the bounty to that app
/// (releasing the reward, minus the protocol fee, to its builder). Shared object.
public struct AppBounty has key {
    id: UID,
    poster: address,
    description: String,
    reward: Balance<SUI>,
    fulfilled_app: Option<ID>,  // the PublishedApp that was awarded the bounty
    winner: Option<address>,    // its builder
    open: bool,
    created_at_ms: u64,
}

/// Paid-fork price book (separate shared object, upgrade-safe). A builder can set a
/// price on their app; remixing it then requires an on-chain license payment
/// (`pay_to_fork`) that pays the builder minus the protocol fee. Absent / 0 = the
/// app is free to remix (the default). Prices live in a side Table so this could be
/// added in an upgrade without touching the already-deployed PublishedApp layout.
public struct ForkRegistry has key {
    id: UID,
    prices: Table<ID, u64>,  // app_id -> fork price in MIST (absent/0 = free to remix)
}

/// Privacy flag book (separate shared object, upgrade-safe). A builder can mark
/// their app private: the app's Walrus archive is then Seal-encrypted client-side,
/// and only the builder can decrypt it (policy `seal_approve_app_owner`). The flag
/// lets the gallery/viewer know to run the decrypt gate. Absent / false = public.
public struct PrivacyRegistry has key {
    id: UID,
    private: Table<ID, bool>,  // app_id -> private (Seal-encrypted, owner-only)
}

// ===== Events =====
public struct AppPublished has copy, drop {
    app_id: ID,
    builder: address,
    name: String,
    parent: Option<ID>,
    manifest_blob: String,
    created_at_ms: u64,
}
public struct AppVisited has copy, drop { app_id: ID, visits: u64 }
public struct AppStarred has copy, drop { app_id: ID, by: address, stars: u64 }
public struct AppRemixed has copy, drop { parent: ID, child: ID, builder: address }
public struct AppTipped has copy, drop { app_id: ID, from: address, amount: u64, fee: u64 }
public struct AppFlagged has copy, drop { app_id: ID, by: address, flags: u64 }
public struct AppHidden has copy, drop { app_id: ID, hidden: bool }
public struct AppUpdated has copy, drop { app_id: ID, tree_hash: String, updated_at_ms: u64 }
public struct NameClaimed has copy, drop { name: String, owner: address }
public struct NameReleased has copy, drop { name: String, owner: address }
public struct TreasuryWithdrawn has copy, drop { to: address, amount: u64 }
public struct AppBountyPosted has copy, drop { bounty_id: ID, poster: address, reward: u64, created_at_ms: u64 }
public struct AppBountyAwarded has copy, drop { bounty_id: ID, app_id: ID, winner: address, amount: u64, fee: u64 }
public struct AppBountyCancelled has copy, drop { bounty_id: ID, poster: address, refund: u64 }
public struct ForkPriceSet has copy, drop { app_id: ID, builder: address, price: u64 }
public struct AppForkPaid has copy, drop { app_id: ID, payer: address, builder: address, price: u64, fee: u64 }
public struct AppPrivacySet has copy, drop { app_id: ID, builder: address, private: bool }

// ===== Registry bootstrap =====
// NOTE: Sui forbids an `init` in a module that is ADDED during a package upgrade
// ("init in new modules on upgrade is not yet supported"). So instead of a module
// `init`, the StarRegistry is created once by an explicit call after the upgrade.

/// Create the shared StarRegistry. Call exactly once after publishing/upgrading.
public fun create_registry(ctx: &mut TxContext) {
    transfer::share_object(StarRegistry { id: object::new(ctx), starred: table::new(ctx) });
}

/// Create the shared BuilderBoard. Call exactly once after the upgrade.
public fun create_builder_board(ctx: &mut TxContext) {
    transfer::share_object(BuilderBoard { id: object::new(ctx), builders: table::new(ctx) });
}

/// Create the shared FlagRegistry. Call exactly once after the upgrade.
public fun create_flag_registry(ctx: &mut TxContext) {
    transfer::share_object(FlagRegistry {
        id: object::new(ctx), flags: table::new(ctx), hidden: table::new(ctx),
    });
}

/// Create the shared NameRegistry. Call exactly once after the upgrade.
public fun create_name_registry(ctx: &mut TxContext) {
    transfer::share_object(NameRegistry {
        id: object::new(ctx), owner_of: table::new(ctx), name_of: table::new(ctx),
    });
}

/// Create the shared Treasury with the given admin. Call exactly once after the upgrade.
public fun create_treasury(admin: address, ctx: &mut TxContext) {
    transfer::share_object(Treasury { id: object::new(ctx), admin, balance: balance::zero<SUI>() });
}

/// Create the shared ForkRegistry. Call exactly once after the upgrade.
public fun create_fork_registry(ctx: &mut TxContext) {
    transfer::share_object(ForkRegistry { id: object::new(ctx), prices: table::new(ctx) });
}

/// Create the shared PrivacyRegistry. Call exactly once after the upgrade.
public fun create_privacy_registry(ctx: &mut TxContext) {
    transfer::share_object(PrivacyRegistry { id: object::new(ctx), private: table::new(ctx) });
}

// ===== Moderation =====

/// Community flag — at most once per address. Lets the UI surface/auto-hide
/// abusive apps without a central admin.
public fun flag_app(app: &PublishedApp, reg: &mut FlagRegistry, ctx: &TxContext) {
    let who = ctx.sender();
    let app_id = object::id(app);
    if (!table::contains(&reg.flags, app_id)) {
        table::add(&mut reg.flags, app_id, vec_set::empty<address>());
    };
    let set = table::borrow_mut(&mut reg.flags, app_id);
    assert!(!vec_set::contains(set, &who), EAlreadyFlagged);
    vec_set::insert(set, who);
    event::emit(AppFlagged { app_id, by: who, flags: vec_set::length(set) });
}

/// The builder hides (or unhides) their own app from the gallery.
public fun set_hidden(app: &PublishedApp, reg: &mut FlagRegistry, hidden: bool, ctx: &TxContext) {
    assert!(ctx.sender() == app.builder, ENotBuilder);
    let app_id = object::id(app);
    if (table::contains(&reg.hidden, app_id)) {
        *table::borrow_mut(&mut reg.hidden, app_id) = hidden;
    } else {
        table::add(&mut reg.hidden, app_id, hidden);
    };
    event::emit(AppHidden { app_id, hidden });
}

/// Read: number of community flags on an app.
public fun flag_count(reg: &FlagRegistry, app_id: ID): u64 {
    if (table::contains(&reg.flags, app_id)) { vec_set::length(table::borrow(&reg.flags, app_id)) } else { 0 }
}
/// Read: whether the builder hid the app.
public fun is_hidden(reg: &FlagRegistry, app_id: ID): bool {
    if (table::contains(&reg.hidden, app_id)) { *table::borrow(&reg.hidden, app_id) } else { false }
}

const W_APP: u64 = 5;
const W_STAR_RECV: u64 = 3;
const W_REMIX_RECV: u64 = 4;

/// Ensure a builder profile exists and return a mutable ref.
fun profile_mut(board: &mut BuilderBoard, who: address): &mut BuilderProfile {
    if (!table::contains(&board.builders, who)) {
        table::add(&mut board.builders, who, BuilderProfile {
            apps_published: 0, stars_received: 0, remixes_received: 0, score: 0,
        });
    };
    table::borrow_mut(&mut board.builders, who)
}

fun recompute(p: &mut BuilderProfile) {
    p.score = p.apps_published * W_APP + p.stars_received * W_STAR_RECV + p.remixes_received * W_REMIX_RECV;
}

public struct BuilderScored has copy, drop { builder: address, score: u64, apps: u64, stars: u64, remixes: u64 }

#[test_only]
public fun init_for_testing(ctx: &mut TxContext) {
    create_registry(ctx);
    create_builder_board(ctx);
    create_flag_registry(ctx);
    create_name_registry(ctx);
    create_treasury(ctx.sender(), ctx);
    create_fork_registry(ctx);
    create_privacy_registry(ctx);
}

// ===== Publish / remix =====

/// Shared core: create + share a PublishedApp, emit events. Returns (app id, builder).
fun do_publish(
    name: String, prompt: String, manifest_blob: String, archive_blob: String,
    tree_hash: String, category: String, parent: Option<ID>, now: u64, ctx: &mut TxContext,
): (ID, address) {
    let app = PublishedApp {
        id: object::new(ctx), builder: ctx.sender(),
        name, prompt, manifest_blob, archive_blob, tree_hash, parent, category,
        visits: 0, stars: 0, tips_total: 0, created_at_ms: now,
    };
    let app_id = object::id(&app);
    let builder = app.builder;
    event::emit(AppPublished { app_id, builder, name: app.name, parent: app.parent, manifest_blob: app.manifest_blob, created_at_ms: now });
    if (option::is_some(&parent)) {
        event::emit(AppRemixed { parent: *option::borrow(&parent), child: app_id, builder });
    };
    transfer::share_object(app);
    (app_id, builder)
}

/// ORIGINAL signature — kept for on-chain upgrade compatibility (no reputation).
public fun publish_app(
    name: String, prompt: String, manifest_blob: String, archive_blob: String,
    tree_hash: String, category: String, parent: Option<ID>, clock: &Clock, ctx: &mut TxContext,
) {
    do_publish(name, prompt, manifest_blob, archive_blob, tree_hash, category, parent, clock::timestamp_ms(clock), ctx);
}

/// Publish + bump the builder's earned on-chain reputation. New entrypoint.
public fun publish_app_v2(
    name: String, prompt: String, manifest_blob: String, archive_blob: String,
    tree_hash: String, category: String, parent: Option<ID>,
    board: &mut BuilderBoard, clock: &Clock, ctx: &mut TxContext,
) {
    let (_id, who) = do_publish(name, prompt, manifest_blob, archive_blob, tree_hash, category, parent, clock::timestamp_ms(clock), ctx);
    let p = profile_mut(board, who);
    p.apps_published = p.apps_published + 1;
    recompute(p);
    event::emit(BuilderScored { builder: who, score: p.score, apps: p.apps_published, stars: p.stars_received, remixes: p.remixes_received });
}

/// Publish a remix and wire the remix component of reputation: bumps the child
/// builder's `apps_published` AND credits the PARENT app builder's `remixes_received`.
/// Takes the parent app by reference to read its builder authoritatively. Self-remix
/// (remixing your own app) does NOT credit a remix, so a builder cannot farm score.
public fun publish_remix_v3(
    name: String, prompt: String, manifest_blob: String, archive_blob: String,
    tree_hash: String, category: String,
    parent_app: &PublishedApp,
    board: &mut BuilderBoard, clock: &Clock, ctx: &mut TxContext,
) {
    let parent_id = object::id(parent_app);
    let parent_builder = parent_app.builder;
    let (_id, who) = do_publish(name, prompt, manifest_blob, archive_blob, tree_hash, category, option::some(parent_id), clock::timestamp_ms(clock), ctx);
    let p = profile_mut(board, who);
    p.apps_published = p.apps_published + 1;
    recompute(p);
    event::emit(BuilderScored { builder: who, score: p.score, apps: p.apps_published, stars: p.stars_received, remixes: p.remixes_received });
    if (parent_builder != who) {
        let pp = profile_mut(board, parent_builder);
        pp.remixes_received = pp.remixes_received + 1;
        recompute(pp);
        event::emit(BuilderScored { builder: parent_builder, score: pp.score, apps: pp.apps_published, stars: pp.stars_received, remixes: pp.remixes_received });
    };
}

// ===== Metrics =====

/// Record a visit. Permissionless (gas-gated) — a "signed visit" that cannot be
/// faked by an off-chain counter.
public fun record_visit(app: &mut PublishedApp) {
    app.visits = app.visits + 1;
    event::emit(AppVisited { app_id: object::id(app), visits: app.visits });
}

/// Star an app — at most once per address. Builders cannot star their own app.
/// Shared core: record one star (one-per-address). Aborts on self/duplicate.
fun do_star(app: &mut PublishedApp, reg: &mut StarRegistry, who: address) {
    assert!(who != app.builder, ECannotStarOwn);
    let app_id = object::id(app);
    if (!table::contains(&reg.starred, app_id)) {
        table::add(&mut reg.starred, app_id, vec_set::empty<address>());
    };
    let set = table::borrow_mut(&mut reg.starred, app_id);
    assert!(!vec_set::contains(set, &who), EAlreadyStarred);
    vec_set::insert(set, who);
    app.stars = app.stars + 1;
    event::emit(AppStarred { app_id, by: who, stars: app.stars });
}

/// ORIGINAL signature — kept for on-chain upgrade compatibility (no reputation).
public fun star(app: &mut PublishedApp, reg: &mut StarRegistry, ctx: &TxContext) {
    do_star(app, reg, ctx.sender());
}

/// Star + credit the app builder's earned reputation (stars_received). New entrypoint.
public fun star_v2(app: &mut PublishedApp, reg: &mut StarRegistry, board: &mut BuilderBoard, ctx: &TxContext) {
    let owner = app.builder;
    do_star(app, reg, ctx.sender());
    let p = profile_mut(board, owner);
    p.stars_received = p.stars_received + 1;
    recompute(p);
    event::emit(BuilderScored { builder: owner, score: p.score, apps: p.apps_published, stars: p.stars_received, remixes: p.remixes_received });
}

/// Tip an app's builder in SUI (minus a small protocol fee). For simplicity this
/// version has no treasury: only `amount - fee` is forwarded to the builder and
/// the `fee` portion is returned to the tipper.
public fun tip_app(app: &mut PublishedApp, payment: Coin<SUI>, ctx: &mut TxContext) {
    let amount = coin::value(&payment);
    assert!(amount > 0, EZeroTip);
    let fee = amount * FEE_BPS / 10000;
    let mut bal = coin::into_balance(payment);
    let fee_coin = coin::from_balance(balance::split(&mut bal, fee), ctx);
    transfer::public_transfer(fee_coin, ctx.sender());
    let pay_coin = coin::from_balance(bal, ctx);
    transfer::public_transfer(pay_coin, app.builder);
    app.tips_total = app.tips_total + (amount - fee);
    event::emit(AppTipped { app_id: object::id(app), from: ctx.sender(), amount: amount - fee, fee });
}

// ===== Versioning =====

/// The builder publishes a NEW version of their app in place: re-anchors the
/// manifest/archive/treeHash on the same PublishedApp object. The previous blobs
/// remain in Walrus and the `AppUpdated` event log forms an immutable, verifiable
/// version history. Builder-only — nobody else can mutate an app's content.
public fun update_app(
    app: &mut PublishedApp,
    manifest_blob: String, archive_blob: String, tree_hash: String,
    clock: &Clock, ctx: &TxContext,
) {
    assert!(ctx.sender() == app.builder, ENotBuilder);
    app.manifest_blob = manifest_blob;
    app.archive_blob = archive_blob;
    app.tree_hash = tree_hash;
    event::emit(AppUpdated { app_id: object::id(app), tree_hash: app.tree_hash, updated_at_ms: clock::timestamp_ms(clock) });
}

// ===== Namespace (handles) =====

/// Claim a unique handle (e.g. "alice"). Aborts if the name is taken. One handle
/// per address — claiming a new one releases the caller's previous handle.
public fun claim_name(reg: &mut NameRegistry, name: String, ctx: &TxContext) {
    let who = ctx.sender();
    assert!(!table::contains(&reg.owner_of, name), ENameTaken);
    if (table::contains(&reg.name_of, who)) {
        let old = table::remove(&mut reg.name_of, who);
        if (table::contains(&reg.owner_of, old)) { table::remove(&mut reg.owner_of, old); };
    };
    table::add(&mut reg.owner_of, name, who);
    table::add(&mut reg.name_of, who, name);
    event::emit(NameClaimed { name, owner: who });
}

/// Release the caller's handle, freeing it for others.
public fun release_name(reg: &mut NameRegistry, ctx: &TxContext) {
    let who = ctx.sender();
    assert!(table::contains(&reg.name_of, who), ENameNotOwned);
    let name = table::remove(&mut reg.name_of, who);
    table::remove(&mut reg.owner_of, name);
    event::emit(NameReleased { name, owner: who });
}

// ===== Treasury / real-fee tipping =====

/// Tip an app's builder in SUI; the protocol fee accrues to the shared Treasury
/// (a real fee, unlike `tip_app` which refunds it). Builder receives amount - fee.
public fun tip_app_v2(app: &mut PublishedApp, treasury: &mut Treasury, payment: Coin<SUI>, ctx: &mut TxContext) {
    let amount = coin::value(&payment);
    assert!(amount > 0, EZeroTip);
    let fee = amount * FEE_BPS / 10000;
    let mut bal = coin::into_balance(payment);
    balance::join(&mut treasury.balance, balance::split(&mut bal, fee));
    let pay_coin = coin::from_balance(bal, ctx);
    transfer::public_transfer(pay_coin, app.builder);
    app.tips_total = app.tips_total + (amount - fee);
    event::emit(AppTipped { app_id: object::id(app), from: ctx.sender(), amount: amount - fee, fee });
}

/// Admin withdraws accrued protocol fees from the Treasury.
public fun withdraw_treasury(treasury: &mut Treasury, amount: u64, ctx: &mut TxContext) {
    assert!(ctx.sender() == treasury.admin, ENotAdmin);
    let payout = coin::from_balance(balance::split(&mut treasury.balance, amount), ctx);
    transfer::public_transfer(payout, treasury.admin);
    event::emit(TreasuryWithdrawn { to: treasury.admin, amount });
}

// ===== App bounties =====

/// Post an app bounty, escrowing the reward. "Build an app that does X for Y SUI."
public fun post_app_bounty(description: String, payment: Coin<SUI>, clock: &Clock, ctx: &mut TxContext) {
    let amount = coin::value(&payment);
    assert!(amount > 0, EZeroReward);
    let now = clock::timestamp_ms(clock);
    let bounty = AppBounty {
        id: object::new(ctx), poster: ctx.sender(), description,
        reward: coin::into_balance(payment),
        fulfilled_app: option::none(), winner: option::none(), open: true, created_at_ms: now,
    };
    event::emit(AppBountyPosted { bounty_id: object::id(&bounty), poster: bounty.poster, reward: amount, created_at_ms: now });
    transfer::share_object(bounty);
}

/// Poster awards the bounty to a published app: releases the reward (minus the
/// protocol fee, which accrues to the Treasury) to that app's builder.
public fun award_app_bounty(bounty: &mut AppBounty, app: &PublishedApp, treasury: &mut Treasury, ctx: &mut TxContext) {
    assert!(ctx.sender() == bounty.poster, ENotPoster);
    assert!(bounty.open, EBountyClosed);
    let amount = balance::value(&bounty.reward);
    let fee = amount * FEE_BPS / 10000;
    let mut payout = balance::withdraw_all(&mut bounty.reward);
    balance::join(&mut treasury.balance, balance::split(&mut payout, fee));
    transfer::public_transfer(coin::from_balance(payout, ctx), app.builder);
    bounty.fulfilled_app = option::some(object::id(app));
    bounty.winner = option::some(app.builder);
    bounty.open = false;
    event::emit(AppBountyAwarded { bounty_id: object::id(bounty), app_id: object::id(app), winner: app.builder, amount: amount - fee, fee });
}

/// Poster cancels an unfulfilled bounty and reclaims the escrowed reward.
public fun cancel_app_bounty(bounty: &mut AppBounty, ctx: &mut TxContext) {
    assert!(ctx.sender() == bounty.poster, ENotPoster);
    assert!(bounty.open, EBountyClosed);
    let amount = balance::value(&bounty.reward);
    let refund = balance::withdraw_all(&mut bounty.reward);
    transfer::public_transfer(coin::from_balance(refund, ctx), bounty.poster);
    bounty.open = false;
    event::emit(AppBountyCancelled { bounty_id: object::id(bounty), poster: bounty.poster, refund: amount });
}

// ===== Paid fork (licensed remix) =====

/// The builder sets (or clears) the fork price on their app, in MIST. A price > 0
/// means remixing requires an on-chain license payment via `pay_to_fork`; price 0
/// clears it (the app becomes free to remix again — the default). Builder-only.
public fun set_fork_price(reg: &mut ForkRegistry, app: &PublishedApp, price: u64, ctx: &TxContext) {
    assert!(ctx.sender() == app.builder, ENotBuilder);
    let app_id = object::id(app);
    if (price == 0) {
        if (table::contains(&reg.prices, app_id)) { table::remove(&mut reg.prices, app_id); };
    } else if (table::contains(&reg.prices, app_id)) {
        *table::borrow_mut(&mut reg.prices, app_id) = price;
    } else {
        table::add(&mut reg.prices, app_id, price);
    };
    event::emit(ForkPriceSet { app_id, builder: app.builder, price });
}

/// Pay the builder-set fork price to license a remix of `app`. Pays the builder
/// `price - fee` (the protocol fee accrues to the Treasury) and refunds any excess
/// to the payer. Aborts if no price is set (`ENotForkable`) or the payment is below
/// the price (`EUnderpaid`). The actual remix is published separately
/// (`publish_remix_v3`); the client bundles both calls in one transaction so the
/// payment and the fork are atomic, and `AppForkPaid` is the verifiable license receipt.
public fun pay_to_fork(reg: &ForkRegistry, app: &PublishedApp, treasury: &mut Treasury, payment: Coin<SUI>, ctx: &mut TxContext) {
    let app_id = object::id(app);
    assert!(table::contains(&reg.prices, app_id), ENotForkable);
    let price = *table::borrow(&reg.prices, app_id);
    assert!(price > 0, ENotForkable);
    let amount = coin::value(&payment);
    assert!(amount >= price, EUnderpaid);
    let mut bal = coin::into_balance(payment);
    // Refund any overpayment to the payer.
    if (amount > price) {
        transfer::public_transfer(coin::from_balance(balance::split(&mut bal, amount - price), ctx), ctx.sender());
    };
    // `bal` now holds exactly `price`. Fee → Treasury, remainder → builder.
    let fee = price * FEE_BPS / 10000;
    balance::join(&mut treasury.balance, balance::split(&mut bal, fee));
    transfer::public_transfer(coin::from_balance(bal, ctx), app.builder);
    event::emit(AppForkPaid { app_id, payer: ctx.sender(), builder: app.builder, price, fee });
}

// ===== Private apps (Seal owner-only) =====
//
// A private app's Walrus archive is Seal-encrypted client-side under an identity
// namespaced to the app's object id (`app_id_bytes || suffix`). Seal key servers
// call `seal_approve_app_owner` with that identity; the call aborts unless the
// requester is the app's builder, so only the builder can decrypt. The flag in
// PrivacyRegistry just tells the viewer to run the decrypt gate.

/// The builder marks (or unmarks) their app private. Builder-only.
public fun set_private(reg: &mut PrivacyRegistry, app: &PublishedApp, private: bool, ctx: &TxContext) {
    assert!(ctx.sender() == app.builder, ENotBuilder);
    let app_id = object::id(app);
    if (table::contains(&reg.private, app_id)) {
        *table::borrow_mut(&mut reg.private, app_id) = private;
    } else {
        table::add(&mut reg.private, app_id, private);
    };
    event::emit(AppPrivacySet { app_id, builder: app.builder, private });
}

/// Read: whether an app is marked private (Seal-encrypted, owner-only).
public fun is_private(reg: &PrivacyRegistry, app_id: ID): bool {
    if (table::contains(&reg.private, app_id)) { *table::borrow(&reg.private, app_id) } else { false }
}

/// True if `id` begins with `app`'s object-id bytes (the Seal namespace check).
fun id_in_app(app: &PublishedApp, id: &vector<u8>): bool {
    let prefix = object::id_bytes(app);
    let plen = vector::length(&prefix);
    if (vector::length(id) < plen) return false;
    let mut i = 0;
    while (i < plen) {
        if (*vector::borrow(id, i) != *vector::borrow(&prefix, i)) return false;
        i = i + 1;
    };
    true
}

/// Seal policy: only the app's builder may decrypt content namespaced to their app.
entry fun seal_approve_app_owner(id: vector<u8>, app: &PublishedApp, ctx: &TxContext) {
    assert!(ctx.sender() == app.builder, ENotAppOwner);
    assert!(id_in_app(app, &id), ESealIdMismatch);
}

// ===== Read accessors =====
public fun builder(app: &PublishedApp): address { app.builder }
public fun visits(app: &PublishedApp): u64 { app.visits }
public fun stars(app: &PublishedApp): u64 { app.stars }
public fun tips_total(app: &PublishedApp): u64 { app.tips_total }
public fun parent(app: &PublishedApp): &Option<ID> { &app.parent }
public fun tree_hash(app: &PublishedApp): String { app.tree_hash }

/// Read a builder's earned on-chain reputation score (0 if none yet).
public fun builder_score(board: &BuilderBoard, who: address): u64 {
    if (table::contains(&board.builders, who)) { table::borrow(&board.builders, who).score } else { 0 }
}
public fun builder_apps(board: &BuilderBoard, who: address): u64 {
    if (table::contains(&board.builders, who)) { table::borrow(&board.builders, who).apps_published } else { 0 }
}
public fun builder_remixes(board: &BuilderBoard, who: address): u64 {
    if (table::contains(&board.builders, who)) { table::borrow(&board.builders, who).remixes_received } else { 0 }
}
/// Read: owner of a handle, if claimed.
public fun name_owner(reg: &NameRegistry, name: String): Option<address> {
    if (table::contains(&reg.owner_of, name)) { option::some(*table::borrow(&reg.owner_of, name)) } else { option::none() }
}
/// Read: the handle owned by an address, if any.
public fun name_of_owner(reg: &NameRegistry, who: address): Option<String> {
    if (table::contains(&reg.name_of, who)) { option::some(*table::borrow(&reg.name_of, who)) } else { option::none() }
}
/// Read: current Treasury balance (accrued fees, MIST).
public fun treasury_balance(t: &Treasury): u64 { balance::value(&t.balance) }
public fun treasury_admin(t: &Treasury): address { t.admin }
public fun bounty_poster(b: &AppBounty): address { b.poster }
public fun bounty_reward(b: &AppBounty): u64 { balance::value(&b.reward) }
public fun bounty_open(b: &AppBounty): bool { b.open }
public fun bounty_winner(b: &AppBounty): &Option<address> { &b.winner }
/// Read: an app's fork price in MIST (0 = free to remix / not for sale).
public fun fork_price(reg: &ForkRegistry, app_id: ID): u64 {
    if (table::contains(&reg.prices, app_id)) { *table::borrow(&reg.prices, app_id) } else { 0 }
}
