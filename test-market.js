/**
 * Guards the three things that have actually broken, all of which were silent.
 *
 *   The sold signal. A scheduled run carries a quarter of the keyword
 *   queries, so a card whose query did not run is invisible while still
 *   listed. Read as "vanished", it becomes a fake sale, and fake sales drag
 *   every cleared-price median toward whatever was on the shelf. Nothing
 *   about that failure looks like a failure from outside.
 *
 *   Alert dedupe. The email is capped at ten cards. Marking only those ten as
 *   sent turns the cap into a queue that pours the rest of the list into your
 *   inbox over the following runs.
 *
 *   Blank hand-entered values. The worksheet ships 30 cards with no prices, to
 *   be filled a few at a time. A blank row that reaches the value index prices
 *   its card at $0 and suppresses it, and the suppression looks like ordinary
 *   PASS traffic.
 *
 * Run: node test-market.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const market = require('./market');
const compare = require('./compare');
const { buildIndex, matchListing } = require('./match');
const { scoreListing } = require('./score');
const { notify, loadSent, alertPopulation } = require('./notify');
const { evaluate, unreadTarget } = require('./verdict');
const { watchQueries, chooseQueries } = require('./ebay');
const { selectAlerts, buildAlert } = require('./alert');
const { setConviction } = require('./score');
const CFG = require('./config');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fail++; }
}

const H = 3600000, M = 60000;
const fx = { usdToAud: 1.44 };
const card = { player: 'Test Man', set: 'prizm', year: 2024, parallel: null, insert: null };
const listing = (id) => ({ itemId: id, price: 100, currency: 'USD', shipping: 10, shippingUnknown: false, seller: 's1' });
const only = (store) => Object.values(store)[0];

/* ---------- the sold signal under query rotation ---------- */

check('a still-listed card is never counted as sold', () => {
  const store = {};
  let t = Date.now() - 10 * 24 * H;
  market.record(store, card, listing('A'), fx, t);
  // Twelve runs, 20 minutes apart. The card's query is in one slice of four,
  // so it is seen once every fourth run and invisible the rest of the time.
  for (let run = 0; run < 12; run++) {
    t += 20 * M;
    const inThisSlice = run % 4 === 1;
    if (inThisSlice) market.record(store, card, listing('A'), fx, t);
    market.reconcile(store, new Set(inThisSlice ? ['A'] : []), t);
  }
  assert.strictEqual(market.statsFor(only(store), t).clearedCount, 0,
    'a card seen 20 minutes ago was counted as a completed sale');
});

check('a card that genuinely goes is detected', () => {
  const store = {};
  let t = Date.now() - 5 * 24 * H;
  market.record(store, card, listing('B'), fx, t);
  for (let run = 0; run < 15; run++) { t += 20 * M; market.reconcile(store, new Set(), t); }
  assert.strictEqual(market.statsFor(only(store), t).clearedCount, 1,
    'the sold signal stopped detecting genuine sales');
});

check('reappearing withdraws the sale claim', () => {
  const store = {};
  let t = Date.now() - 5 * 24 * H;
  market.record(store, card, listing('C'), fx, t);
  t += 4 * H; market.reconcile(store, new Set(), t);      // absent long enough to be marked
  t += 20 * M; market.record(store, card, listing('C'), fx, t);  // but it is back
  assert.strictEqual(market.statsFor(only(store), t).clearedCount, 0,
    'a card marked gone then seen again is still counted as sold');
});

check('the grace period outlasts a full rotation cycle', () => {
  const cycleMinutes = Math.ceil(35 / CFG.scan.queriesPerRun) * 20;
  assert.ok(CFG.market.goneGraceHours * 60 > cycleMinutes,
    `grace ${CFG.market.goneGraceHours}h does not cover a ${cycleMinutes} minute cycle, ` +
    'so cards will be marked sold purely for being outside the current slice');
});

/* ---------- hand-entered values ---------- */

// my-values-TOFILL.json is a worksheet of 30 cards with the prices blank, to
// be filled a few at a time. A blank row used to survive into the value index
// at $0, match the real card at high confidence, and price it at nothing. The
// card was then binned with a NaN score, and because a comp had matched, it
// never reached the comparable-pool fallback that would have valued it. A
// half-filled worksheet blinded the tool on its own 30 most-listed cards.

const blank = { year: 2021, set: 'prizm', insert: null, parallel: null, player: 'Kyle Pitts', cardNo: '108', serialOf: null, psa10Usd: null };
const priced = { year: 2023, set: 'prizm', insert: 'rookie auto', parallel: 'silver', player: 'Bryce Young', cardNo: 'RA-BY', serialOf: null, psa10Usd: 180 };

check('a row with no price never becomes a value', () => {
  const rows = market.handValueRows({ rows: [blank, priced, { ...blank, player: 'Bad Number', psa10Usd: 'n/a' }, { ...blank, player: 'Negative', psa10Usd: -5 }] });
  assert.deepStrictEqual(rows.map((r) => r.player), ['Bryce Young'],
    'a priceless row reached the value index, where it prices its card at $0');
  assert.ok(rows.every((r) => r.psa10UsdCents > 0), 'a value row carries a non-positive price');
});

check('a card left blank on the worksheet still gets a comparable estimate', () => {
  const parsed = {
    player: 'Kyle Pitts', year: 2021, set: 'prizm', insert: null, parallel: null,
    cardNo: '108', serial: null, grade: 10, confidence: 90,
    pos: 'TE', exp: 4, age: 24, dynRank: 40, dynTrend30: 0, team: 'ATL', debut: 2021,
    warnings: [],
  };
  const listing = {
    itemId: 'P1', title: '2021 Prizm Kyle Pitts 108 PSA 10', url: 'https://example.invalid',
    price: 60, currency: 'USD', shipping: 15, shippingUnknown: false,
    country: 'US', feedbackPct: 99, feedbackScore: 500,
  };
  // Five alike cards, which is what compare.js needs before it will price one.
  const pools = compare.buildPools(
    Array.from({ length: compare.MIN_POOL }, () => ({ parsed, askAud: 300 }))
  );

  const index = buildIndex(market.handValueRows({ rows: [blank] }));
  const m = matchListing(parsed, index);
  assert.strictEqual(m.comp, null, 'a blank worksheet row was matched as if it were a value');

  const scored = scoreListing(listing, parsed, m, fx, pools);
  assert.strictEqual(scored.valueSource, 'comparable',
    'the card did not fall through to the comparable pool');
  assert.ok(Number.isFinite(scored.score) && Number.isFinite(scored.edge),
    `blank price produced a non-finite score: edge ${scored.edge}, score ${scored.score}`);
  assert.ok(scored.compAud > 0, `card valued at ${scored.compAud}`);
});

/* ---------- what earns an email ---------- */

/**
 * The tool is a watchlist now, not a bargain hunter. One rule decides
 * everything: is this a PSA 10 autograph, of a man named in
 * data/my-players.json, asking under the ceiling.
 *
 * Nothing else earns an email. Not a 60% discount, not a top-24 dynasty
 * asset, not a rookie of the exact profile Ryan used to hunt. That is the
 * point of the change and the assertion that guards it is the one below
 * called "a screaming bargain of a player you never named earns nothing",
 * because without it the old behaviour creeps straight back in.
 */

const row = (over = {}) => ({
  itemId: 'R1', player: 'Some Guy', year: 2024, set: 'prizm', parallel: null,
  grade: 10, exp: 4, age: 26, team: 'CHI', dynRank: 150, dynTrend30: 0, conviction: 1,
  alwaysAlert: false, askUsd: 150, landedAud: 260, compAud: 300, edge: 0.13,
  valueConfidence: 3, score: 0.05, url: 'https://example.invalid', ...over,
});
// A man on the watchlist, on a card that qualifies.
const watched = (over = {}) => row({ player: 'Emeka Egbuka', conviction: 1.5, alwaysAlert: true, ...over });
const reasonsFor = (over) => evaluate(row(over)).reasons;
const emailFor = (rows) => {
  const sel = selectAlerts(rows);
  return { sel, mail: buildAlert(sel, {}) };
};

check('a watchlist player on a PSA 10 auto under the ceiling is emailed', () => {
  assert.deepStrictEqual(evaluate(watched()).reasons, ['TARGET'],
    'the one thing the tool is for did not fire');
});

check('the card has to be a PSA 10', () => {
  assert.deepStrictEqual(evaluate(watched({ grade: 9 })).reasons, [],
    'a PSA 9 was emailed, and the brief says PSA 10 only');
});

check('the card has to be under the asking ceiling', () => {
  const max = CFG.alert.reasons.target.maxAskUsd;
  assert.deepStrictEqual(evaluate(watched({ askUsd: max + 1 })).reasons, [],
    `a card asking over $${max} was emailed`);
  assert.deepStrictEqual(evaluate(watched({ askUsd: max })).reasons, ['TARGET'],
    'a card asking exactly the ceiling was rejected, so the bound is off by one');
  assert.deepStrictEqual(evaluate(watched({ askUsd: 0 })).reasons, [],
    'a card with no asking price was emailed, so the ceiling is not being applied');
});

check('a screaming bargain of a player you never named earns nothing', () => {
  // Top-24 dynasty, first year, PSA 10, cheap, 60% under the going rate.
  // Every one of the old rules would have fired. None of them exist now.
  const bargain = row({
    player: 'Nobody You Named', exp: 0, dynRank: 8, dynTrend30: 300,
    askUsd: 90, landedAud: 160, compAud: 400, edge: 0.6, score: 3,
  });
  const v = evaluate(bargain);
  assert.deepStrictEqual(v.reasons, [],
    `a card qualifying on nothing but being cheap was queued for the email as ${v.call}`);
  // And it must not be rendered either. A card shown but never marked sent
  // comes back every single scan, forever.
  bargain.verdict = v;
  const { sel } = emailFor([bargain]);
  const shown = [...sel.act, ...sel.also, ...sel.targets, ...sel.profile, ...sel.unread];
  assert.strictEqual(shown.length, 0,
    `a card with no reason was rendered into the email as a ${v.call}, so it will be resent on every scan`);
});

check('a watchlist card is emailed however bad the price is', () => {
  const dear = watched({ edge: -0.4, landedAud: 700, compAud: 500, score: -1 });
  const v = evaluate(dear);
  assert.ok(['PASS', 'SKIP', 'FAIR', 'WATCH'].includes(v.call), `expected a weak call, got ${v.call}`);
  assert.ok(v.reasons.includes('TARGET'), 'a watchlist card was dropped for being expensive, and the brief is to hear every time');
});

check('a watchlist card the tool cannot value at all is still emailed', () => {
  assert.ok(evaluate(watched({ edge: undefined, compAud: undefined, unpriced: 'no-comp-for-player-year' })).reasons.includes('TARGET'),
    'an unpriced card of a named man was dropped, and that is the one Ryan most needs to look at himself');
});

check('bargain hunting is off', () => {
  assert.strictEqual(CFG.alert.reasons.deal.enabled, false, 'DEAL is switched on again');
  assert.strictEqual(CFG.alert.reasons.profile.enabled, false, 'PROFILE is switched on again');
  assert.ok(!reasonsFor({ edge: 0.6, dynRank: 5, score: 3 }).includes('DEAL'),
    'a deal earned an email while dealing is switched off');
  assert.ok(!reasonsFor({ exp: 0, dynRank: 20, askUsd: 120 }).includes('PROFILE'),
    'the profile rule fired while it is switched off');
});

/* ---------- the watchlist file itself ---------- */

/**
 * These run against the real data/my-players.json and data/player-index.json,
 * because the failure they guard is silent: a name that does not resolve is a
 * player Ryan simply never hears about, and nothing anywhere says so. This is
 * the test that catches a typo when the 2026 rookies get added.
 */
check('every name on the watchlist resolves to a real player', () => {
  const players = require('./data/my-players.json').rows;
  const idx = require('./data/player-index.json').byName;
  const norm = (s) => String(s || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[.'`]/g, '').replace(/\s+(jr|sr|ii|iii|iv|v)$/i, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();

  assert.ok(players.length, 'the watchlist is empty, so the tool has nothing to look for');
  const missing = players.filter((p) => !idx[norm(p.player)]).map((p) => p.player);
  assert.deepStrictEqual(missing, [],
    `these names match nobody in the player index, so their cards can never be recognised: ${missing.join(', ')}`);
});

check('every watchlist player is set to alert', () => {
  const players = require('./data/my-players.json').rows;
  const silent = players.filter((p) => p.alwaysAlert !== true).map((p) => p.player);
  assert.deepStrictEqual(silent, [],
    `on the watchlist but will never be emailed: ${silent.join(', ')}`);
});

check('the watchlist drives the eBay queries', () => {
  // A rotation means two runs in three are not looking for a given player,
  // which is the opposite of noticing when one is listed.
  const players = require('./data/my-players.json').rows;
  const qs = watchQueries(players);
  assert.strictEqual(qs.length, players.length, 'some watchlist players get no eBay query of their own');
  assert.ok(qs.every((q) => /^psa 10 .+ auto$/.test(q)), `a query is malformed: ${qs.find((q) => !/^psa 10 .+ auto$/.test(q))}`);
  assert.ok(qs.some((q) => /burden/i.test(q)), 'the primary target has no query');
  // Suffixes come off, because sellers do not type them consistently.
  assert.ok(!qs.some((q) => /\biii\b/i.test(q)), 'a suffix survived into a query and will narrow it wrongly');

  // And the whole list has to fit inside one run, or the rotation is back.
  assert.ok(CFG.scan.queriesPerRun >= players.length,
    `queriesPerRun is ${CFG.scan.queriesPerRun} against ${players.length} players, so some are searched only every other run`);
});

check('a scheduled run searches the watchlist, not the old set sweep', () => {
  const players = require('./data/my-players.json').rows;
  const scheduled = chooseQueries(players, {});
  assert.strictEqual(scheduled.length, players.length,
    'a scheduled run is using the old set-based sweep, which searches for products rather than for your men');
  assert.ok(scheduled.every((q) => players.some((p) => q.includes(p.player.replace(/\s+III$/, '')))),
    'the queries are not derived from the watchlist');

  // A full sweep still gets the wide net, for rebuilding comparable pools.
  assert.ok(chooseQueries(players, { fullSweep: true }).length > players.length,
    'SCAN_ALL no longer widens the sweep');
  // And an empty watchlist must not mean an empty scan.
  assert.ok(chooseQueries([], {}).length > 0, 'an empty watchlist produced a scan that searches for nothing');
});

check('the watchlist fits inside the eBay budget', () => {
  const players = require('./data/my-players.json').rows;
  // 2 marketplaces * (3 aspect pages + queries * 2), at the six-hourly schedule.
  const perRun = 2 * (3 + players.length * 2);
  const perDay = perRun * 4;
  assert.ok(perDay < CFG.scan.dailyBrowseCeiling * 0.5,
    `${players.length} players costs ${perDay} searches a day against a ${CFG.scan.dailyBrowseCeiling} ceiling. Rotate, or trim the list.`);
});

/* ---------- the email ---------- */

check('a watchlist card reaches the rendered email', () => {
  const r = watched({ itemId: 'T1', player: 'Luther Burden III', edge: -0.25, landedAud: 600, compAud: 480 });
  r.verdict = evaluate(r);
  const { sel, mail } = emailFor([r]);
  assert.strictEqual(sel.targets.length, 1, 'it earned a reason but reached no section of the email');
  assert.ok(mail.text.includes('Luther Burden III'), 'the player is not in the email body');
  assert.ok(mail.html.includes('Your targets'), 'the section did not render');
  assert.ok(!/Nothing worth flagging/.test(mail.subject), `subject says nothing was found: "${mail.subject}"`);
});

check('primaries sort above secondaries', () => {
  const secondary = watched({ itemId: 'S1', player: 'Mac Jones', conviction: 1.25 });
  const primary = watched({ itemId: 'P1', player: 'Emeka Egbuka', conviction: 1.5, edge: -0.3, landedAud: 700, compAud: 540 });
  [secondary, primary].forEach((r) => { r.verdict = evaluate(r); });
  const { sel } = emailFor([secondary, primary]);
  assert.strictEqual(sel.targets[0].player, 'Emeka Egbuka',
    'a secondary outranked a primary, even though the primary is who Ryan actually wants');
});

check('a section cap never swallows a card that another section would show', () => {
  const filler = Array.from({ length: 12 }, (_, i) =>
    watched({ itemId: `F${i}`, player: `Filler ${i}`, edge: 0.5, score: 1 - i * 0.01 }));
  const target = watched({ itemId: 'TGT', player: 'Emeka Egbuka', edge: 0.25, score: 0.001 });
  const all = [...filler, target].map((r) => { r.verdict = evaluate(r); return r; });
  const { sel } = emailFor(all);
  const displayed = [...sel.act, ...sel.also, ...sel.targets, ...sel.profile].map((r) => r.itemId);
  assert.ok(displayed.includes('TGT'),
    'a card was cut by one section cap and then excluded from the next section for being "already shown"');
});

check('a card appears in exactly one section of the email', () => {
  const cards = [
    watched({ itemId: 'X1', player: 'Emeka Egbuka', edge: 0.5, landedAud: 200, compAud: 400, score: 2 }),
    watched({ itemId: 'X2', player: 'Quinshon Judkins', conviction: 1.25, edge: 0.5, landedAud: 200, compAud: 400, score: 1.5 }),
    watched({ itemId: 'X3', player: 'Luther Burden III', edge: -0.1, landedAud: 500, compAud: 455, score: -1 }),
  ];
  cards.forEach((r) => { r.verdict = evaluate(r); });
  const { sel } = emailFor(cards);
  const ids = [...sel.act, ...sel.also, ...sel.targets, ...sel.profile].map((r) => r.itemId);
  assert.strictEqual(ids.length, new Set(ids).size, `a card was rendered twice: ${ids.join(', ')}`);
  assert.strictEqual(new Set(ids).size, cards.length, `${cards.length - new Set(ids).size} card(s) vanished entirely`);
});

check('the email never prints a negative discount as a discount', () => {
  const r = watched({ itemId: 'O1', edge: -0.25, landedAud: 600, compAud: 480 });
  r.verdict = evaluate(r);
  const { mail } = emailFor([r]);
  assert.ok(!/-\d+% under/.test(mail.text), `printed a negative discount as a discount: ${mail.text.match(/.*under.*/)?.[0]}`);
  assert.ok(/25% over/.test(mail.text), 'an over-market card is not described as over market');
});

check('a card priced above the market is never described as cheap', () => {
  const over = evaluate(watched({ landedAud: 600, compAud: 500, edge: -0.2 }));
  assert.ok(!/cheap|under|below/i.test(over.hook), `hook called a dear card cheap: "${over.hook}"`);
  assert.ok(!/cheap|under|below/i.test(over.take), `take called a dear card cheap: "${over.take}"`);
  const level = evaluate(watched({ landedAud: 500, compAud: 500, edge: 0 }));
  assert.ok(!/cheap/i.test(level.hook), `hook called a fairly priced card cheap: "${level.hook}"`);
  const cheap = evaluate(watched({ edge: 0.4, landedAud: 300, compAud: 500 }));
  assert.ok(/one of your/i.test(cheap.hook), `the cheap-card hook does not name him as one of yours: "${cheap.hook}"`);
});

check('the strapline does not claim everything is under market when it is not', () => {
  const t = watched({ itemId: 'T2', edge: -0.3, landedAud: 700, compAud: 540 });
  t.verdict = evaluate(t);
  const { mail } = emailFor([t]);
  assert.ok(!/under what comparable cards ask/.test(mail.html),
    'the header tells Ryan every card below is under market, on an email whose only card is over it');
});

check('the subject counts your men, not their listings', () => {
  const cards = Array.from({ length: 6 }, (_, i) =>
    watched({ itemId: `M${i}`, player: i % 2 ? 'Luther Burden III' : 'Emeka Egbuka', edge: -0.1, landedAud: 400 + i, compAud: 440, score: -1 }));
  cards.forEach((r) => { r.verdict = evaluate(r); });
  const { mail } = emailFor(cards);
  assert.ok(!/[3-9]\d* of your guys/.test(mail.subject), `subject counted listings as people: "${mail.subject}"`);
  const h1 = (mail.html.match(/font-size:20px[^>]*>([^<]*)</) || [])[1] || '';
  assert.ok(!/[3-9]\d* of your guys/.test(h1), `the email heading counted listings as people: "${h1}"`);
});

check('the same man spelled with and without a suffix is one player, not two', () => {
  const a = watched({ itemId: 'S1', player: 'Luther Burden Jr.', edge: 0.2, score: 1 });
  const b = watched({ itemId: 'S2', player: 'Luther Burden', edge: 0.19, score: 0.9 });
  [a, b].forEach((r) => { r.verdict = evaluate(r); });
  const { sel } = emailFor([a, b]);
  const displayed = [...sel.act, ...sel.also, ...sel.profile];
  assert.strictEqual(displayed.length, 0, 'the deal sections rendered something while dealing is off');
  // The targets section deliberately shows every listing, so it is the
  // one-card-per-player sections that must collapse the two spellings.
  assert.strictEqual(new Set(sel.targets.map((r) => r.player)).size, 2, 'fixture is wrong');
});

check('a numbered card says so in the email, even when it cannot be valued', () => {
  const parsed = {
    player: 'Emeka Egbuka', year: 2025, set: 'prizm', insert: 'rookie auto', parallel: 'gold',
    cardNo: null, serial: { num: 3, of: 25 }, grade: 10, confidence: 90,
    pos: 'WR', exp: 1, age: 23, team: 'TB', debut: 2025, dynRank: 27, dynTrend30: 100, warnings: [],
  };
  const l = {
    itemId: 'SER', title: 't', url: 'https://example.invalid',
    price: 190, currency: 'USD', shipping: 15, shippingUnknown: false,
    country: 'US', feedbackPct: 99, feedbackScore: 500,
  };
  setConviction(require('./data/my-players.json').rows);
  const scored = scoreListing(l, parsed, { comp: null, matchConfidence: 0, reason: 'x' }, fx, null);
  assert.strictEqual(scored.serialOf, 25, 'scoreListing did not carry the print run onto an unvalued card');
  scored.verdict = evaluate(scored);
  const { mail } = emailFor([scored]);
  assert.ok(/\/25/.test(mail.text), 'the email does not mention the print run');
});

/* ---------- the trip from the real files to a scored listing ---------- */

check('a watchlist player survives from my-players.json to a scored listing', () => {
  const players = require('./data/my-players.json').rows;
  setConviction(players);
  const max = CFG.alert.reasons.target.maxAskUsd;

  for (const p of players.filter((x) => x.alwaysAlert)) {
    const parsed = {
      player: p.player, year: 2025, set: 'prizm', insert: 'rookie auto', parallel: null,
      cardNo: null, serial: null, grade: 10, confidence: 90,
      pos: 'WR', exp: 1, age: 22, team: 'CHI', debut: 2025, dynRank: 47, dynTrend30: 100, warnings: [],
    };
    const listing = {
      itemId: `L-${p.player}`, title: 't', url: 'https://example.invalid',
      price: max - 10, currency: 'USD', shipping: 15, shippingUnknown: false,
      country: 'US', feedbackPct: 99, feedbackScore: 500,
    };
    const scored = scoreListing(listing, parsed, { comp: null, matchConfidence: 0, reason: 'x' }, fx, null);
    assert.strictEqual(scored.alwaysAlert, true, `alwaysAlert did not reach the scored row for ${p.player}`);
    assert.ok(scored.askUsd > 0, `no asking price derived for ${p.player}`);
    scored.verdict = evaluate(scored);
    assert.ok(scored.verdict.reasons.includes('TARGET'),
      `${p.player} is on the watchlist but earns no email`);
  }

  // An AUD listing has to be converted before it meets a USD ceiling.
  const parsed = {
    player: players[0].player, year: 2025, set: 'prizm', insert: 'rookie auto', parallel: null,
    cardNo: null, serial: null, grade: 10, confidence: 90,
    pos: 'WR', exp: 1, age: 22, team: 'TB', debut: 2025, dynRank: 27, dynTrend30: 100, warnings: [],
  };
  const au = scoreListing(
    { itemId: 'AU', title: 't', url: 'u', price: 150 * fx.usdToAud, currency: 'AUD', shipping: 10, shippingUnknown: false, country: 'AU', feedbackPct: 99, feedbackScore: 500 },
    parsed, { comp: null, matchConfidence: 0, reason: 'x' }, fx, null);
  assert.ok(Math.abs(au.askUsd - 150) < 1, `an AUD listing was not converted to USD: askUsd ${au.askUsd}`);
  assert.ok(evaluate(au).reasons.includes('TARGET'), 'an Australian listing of a watchlist player was not emailed');
});

check('an unpriced watchlist card is forwarded to the notifier, an unpriced nobody is not', () => {
  const target = watched({ itemId: 'U1', unpriced: 'no-comp-for-player-year', edge: undefined, compAud: undefined });
  const nobody = row({ itemId: 'U2', player: 'Nobody', unpriced: 'no-comp-for-player-year', edge: undefined, compAud: undefined });
  [target, nobody].forEach((r) => { r.verdict = evaluate(r); });
  const priced = [watched({ itemId: 'B1' })];
  priced.forEach((r) => { r.verdict = evaluate(r); });

  const pop = alertPopulation(priced, [target, nobody]).map((r) => r.itemId);
  assert.ok(pop.includes('U1'), 'an unpriced watchlist card never reaches the notifier');
  assert.ok(!pop.includes('U2'), 'the whole unpriced pile is being forwarded, so the email becomes the report');
  assert.ok(pop.includes('B1'), 'priced rows stopped being forwarded');
});

/* ---------- named men the parser could not read ---------- */

// Dropped rows never get a verdict, so "tell me every time" used to stop at
// the parse gate. Only the confidence gate qualifies: the others are
// correctness gates and their answers are right.
const dropped = (over = {}) => ({
  itemId: 'D1', title: '2025 Odd Set Luther Burden III RC Auto PSA 10 GEM MINT',
  url: 'https://example.invalid', player: 'Luther Burden',
  grade: 10, askUsd: 150, alwaysAlert: true, warnings: [], dropped: 'parse-confidence-45', ...over,
});

check('only the confidence gate produces an unreadable target', () => {
  assert.ok(unreadTarget(dropped()), 'a watchlist card the parser half-read was binned silently');
  assert.ok(!unreadTarget(dropped({ dropped: 'college-card-2024-vs-debut-2025' })), 'a college card was surfaced');
  assert.ok(!unreadTarget(dropped({ dropped: 'gate:no-psa-grade-claim' })), 'a raw card was surfaced as a PSA auto');
  assert.ok(!unreadTarget(dropped({ dropped: 'gate:auto-explicitly-denied' })), 'a card whose title denies an autograph was surfaced');
  assert.ok(!unreadTarget(dropped({ dropped: 'gate:junk:lot' })), 'a card lot was surfaced');
  assert.ok(!unreadTarget(dropped({ warnings: ['ambiguous-player'] })), 'a name the parser could not settle was claimed as one of yours');
  assert.ok(!unreadTarget(dropped({ alwaysAlert: false })), 'an unreadable card for a player you never named was surfaced');
  assert.ok(!unreadTarget(dropped({ grade: 9 })), 'a PSA 9 was surfaced');
  assert.ok(!unreadTarget(dropped({ askUsd: CFG.alert.reasons.target.maxAskUsd + 50 })), 'a card over the ceiling was surfaced');
});

check('an unreadable target reaches the email carrying no price and no call', () => {
  const r = dropped();
  r.verdict = unreadTarget(r);
  const pop = alertPopulation([], [], [r]);
  assert.strictEqual(pop.length, 1, 'an unreadable target never reached the notifier');

  const sel = selectAlerts(pop);
  assert.strictEqual(sel.unread.length, 1, 'it reached the notifier but no section of the email');
  const mail = buildAlert(sel, {});
  assert.ok(mail.text.includes('https://example.invalid'), 'the link is missing, which is the only actionable thing on the row');
  assert.ok(!/\$/.test(mail.text.split('COULD NOT READ THESE')[1] || ''), 'a card with no valuation printed a price');
  assert.ok(!/NaN|undefined/.test(mail.html), 'the rendered card carries NaN or undefined');
  assert.ok(!/Nothing worth flagging/.test(mail.subject), `subject says nothing was found: "${mail.subject}"`);
});


/* ---------- alert dedupe ---------- */

const SENT = path.join(__dirname, 'data/alerted.json');
const withStubbedResend = async (fn) => {
  const realFetch = global.fetch;
  let sends = 0;
  global.fetch = async () => { sends++; return { ok: true, status: 200, text: async () => '{"id":"stub"}' }; };
  const prevKey = process.env.RESEND_API_KEY, prevTo = process.env.ALERT_TO;
  process.env.RESEND_API_KEY = 'stub';
  process.env.ALERT_TO = 'test@example.invalid';
  const backup = fs.existsSync(SENT) ? fs.readFileSync(SENT) : null;
  fs.rmSync(SENT, { force: true });
  try { return await fn(() => sends); }
  finally {
    global.fetch = realFetch;
    if (prevKey === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = prevKey;
    if (prevTo === undefined) delete process.env.ALERT_TO; else process.env.ALERT_TO = prevTo;
    if (backup) fs.writeFileSync(SENT, backup); else fs.rmSync(SENT, { force: true });
  }
};

// reasons is what notify and selectAlerts both read to decide whether a card
// belongs in the email. These are all BUY or better, so they qualify on DEAL.
const buy = (id, call) => ({
  itemId: id, player: `Player ${id}`, edge: 0.3, score: 1, landedAud: 150, compAud: 250,
  year: 2024, set: 'prizm', exp: 2, dynRank: 30, grade: 10, askUsd: 120,
  verdict: { call, shout: call === 'STRONG BUY', take: 'test', tags: [], reasons: ['DEAL'] },
});

(async () => {
  // Fifteen qualifying cards against a cap of ten, so the cap has to trim.
  const many = Array.from({ length: 15 }, (_, i) => buy(`X${i}`, i < 3 ? 'STRONG BUY' : 'BUY'));

  await withStubbedResend(async (sends) => {
    const first = await notify(many, {});
    check('the first run emails', () => assert.ok(first.sent > 0, 'nothing was sent'));
    check('trimmed cards are remembered, not queued for later', () => {
      assert.strictEqual(Object.keys(loadSent()).length, many.length,
        'only the displayed cards were marked, so the cap will drip-feed the rest');
    });

    const second = await notify(many, {});
    check('a second run over the same listings sends nothing', () => {
      assert.strictEqual(second.sent, 0, `sent ${second.sent} duplicate alerts`);
    });

    // A target-only run. Nothing here is a deal, so this passes only while
    // notify reads verdict.reasons. Reverting worthEmailing to the old
    // shout-or-BUY bar used to leave the whole suite green.
    const targetOnly = [
      { ...buy('TGT-ONLY', 'PASS'), player: 'Luther Burden III', conviction: 1.4, alwaysAlert: true,
        edge: -0.2, landedAud: 600, compAud: 500,
        verdict: { call: 'PASS', shout: false, take: 'test', tags: ['TARGET'], hook: 'one of yours', reasons: ['TARGET'] } },
      { ...buy('PROF-ONLY', 'WATCH'), player: 'Cam Ward', exp: 0, team: 'TEN', askUsd: 150,
        verdict: { call: 'WATCH', shout: false, take: 'test', tags: ['PROFILE'], hook: 'your shape', reasons: ['PROFILE'] } },
    ];
    const targetRun = await notify(targetOnly, {});
    check('a run carrying only targets and profile cards still sends', () => {
      assert.strictEqual(targetRun.sent, 2,
        `expected both non-deal cards to be emailed, got ${targetRun.sent}. notify is not reading verdict.reasons.`);
    });
    // Displayed and marked-as-sent are computed from two different filters, so
    // a card can be shown by one and missed by the other. When that happens the
    // same card is emailed again every 20 minutes forever.
    const targetRepeat = await notify(targetOnly, {});
    check('a target already emailed does not come round again', () => {
      assert.strictEqual(targetRepeat.sent, 0,
        `a target-only card was displayed but never marked sent, so it repeats every scan (${targetRepeat.sent} resent)`);
    });

    const improved = many.map((r, i) => i === 5
      ? { ...r, verdict: { ...r.verdict, call: 'STRONG BUY', shout: true } } : r);
    const third = await notify(improved, {});
    check('a card whose call improves comes round again', () => {
      assert.strictEqual(third.sent, 1, `expected 1 alert for the improved card, got ${third.sent}`);
    });

    const withNew = [buy('BRAND-NEW', 'STRONG BUY'), ...many];
    const fourth = await notify(withNew, {});
    check('a genuinely new listing still gets through', () => {
      assert.strictEqual(fourth.sent, 1, `expected 1 alert for the new card, got ${fourth.sent}`);
    });

    // One per run that had something new: the first, the target-only run, the
    // improved card, the brand new listing. The runs that found nothing new
    // must not have sent anything, which is what this number pins.
    check('exactly four emails left the building', () => {
      assert.strictEqual(sends(), 4, `${sends()} emails sent, expected 4`);
    });
  });

  console.log(`\n${pass}/${pass + fail} assertions passing`);
  process.exit(fail ? 1 : 0);
})();
