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
const { evaluate } = require('./verdict');
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

// Three reasons, and they are not interchangeable. A named target is emailed
// at any call, including the ones the tool rates badly and the ones it cannot
// value at all, because Ryan asked to hear about those men every time. A
// profile card is judged on age, grade and asking price with no reference to
// discount. Everything else still has to be a deal. The fourth assertion is
// the one that matters most: without it these rules quietly become "email
// everything", and the shortlist stops being a shortlist.

const row = (over = {}) => ({
  itemId: 'R1', player: 'Some Guy', year: 2024, set: 'prizm', parallel: null,
  grade: 10, exp: 4, age: 26, team: 'CHI', dynRank: 150, dynTrend30: 0, conviction: 1,
  alwaysAlert: false, askUsd: 300, landedAud: 460, compAud: 500, edge: 0.08,
  valueConfidence: 3, score: 0.05, url: 'https://example.invalid', ...over,
});
const reasonsFor = (over) => { const r = row(over); return evaluate(r).reasons; };

check('a named target is emailed even when the call is bad', () => {
  const r = row({ player: 'Luther Burden III', conviction: 1.4, alwaysAlert: true, edge: -0.2, landedAud: 600 });
  const v = evaluate(r);
  assert.ok(['PASS', 'SKIP', 'FAIR', 'WATCH'].includes(v.call), `expected a weak call, got ${v.call}`);
  assert.ok(v.reasons.includes('TARGET'), 'a named target at a bad price was not flagged for the email');
});

check('a named target the tool cannot value is still emailed', () => {
  // No edge, no comp: this is what a row in the "worth a look" pile looks like.
  const r = row({ player: 'Emeka Egbuka', conviction: 1.4, alwaysAlert: true, edge: undefined, compAud: undefined, unpriced: 'no-comp-for-player-year' });
  assert.ok(evaluate(r).reasons.includes('TARGET'),
    'an unpriced target was dropped, which is the one Ryan most needs to see himself');
});

check('the profile is first or second year, PSA 10, under the asking ceiling', () => {
  const P = CFG.alert.reasons.profile;
  assert.ok(reasonsFor({ exp: 0, grade: 10, askUsd: P.maxAskUsd - 1 }).includes('PROFILE'), 'a rookie PSA 10 under the ceiling did not qualify');
  assert.ok(reasonsFor({ exp: 1, grade: 10, askUsd: P.maxAskUsd - 1 }).includes('PROFILE'), 'a second year PSA 10 under the ceiling did not qualify');
  assert.ok(!reasonsFor({ exp: 2, grade: 10, askUsd: 100 }).includes('PROFILE'), 'a third year man qualified on profile');
  assert.ok(!reasonsFor({ exp: 0, grade: 9, askUsd: 100 }).includes('PROFILE'), 'a PSA 9 qualified on profile');
  assert.ok(!reasonsFor({ exp: 0, grade: 10, askUsd: P.maxAskUsd + 1 }).includes('PROFILE'), 'a card over the asking ceiling qualified on profile');
});

check('the profile never fires on a retired player', () => {
  // Sleeper reports years_exp 0 for a man who never played and freezes it at
  // retirement, so data/player-index.json holds Kurt Warner at age 47 exp 0
  // and 2,775 entries at exp 0 or 1 in total. Experience alone cannot answer
  // "first or second year", and isBoomRookie only escaped this by also
  // demanding a dynasty rank inside the top 60.
  assert.ok(!reasonsFor({ player: 'Kurt Warner', exp: 0, age: 47, team: null, dynRank: null, askUsd: 150 }).includes('PROFILE'),
    'a retired player qualified as a first or second year man');
  assert.ok(!reasonsFor({ exp: 1, team: null, dynRank: 40, askUsd: 150 }).includes('PROFILE'),
    'a player on no roster qualified on profile');
  assert.ok(!reasonsFor({ exp: 1, team: 'CHI', dynRank: null, askUsd: 150 }).includes('PROFILE'),
    'a player the dynasty market does not rate at all qualified on profile');
  assert.ok(reasonsFor({ exp: 1, team: 'CHI', dynRank: 400, askUsd: 150 }).includes('PROFILE'),
    'a rostered, ranked second year man was rejected, so the guard is too tight');
});

// The index really does hold these. If Sleeper ever changes shape this fails
// loudly rather than the profile rule quietly widening again.
check('the player index still contains the retired men this guard exists for', () => {
  const idx = require('./data/player-index.json').byName;
  const warner = (idx['kurt warner'] || [])[0];
  assert.ok(warner, 'Kurt Warner is missing from the index, so this guard is untested against real data');
  assert.strictEqual(warner.exp, 0, `expected Sleeper to report exp 0 for a retired player, got ${warner.exp}`);
  assert.strictEqual(warner.team, null, 'expected no roster for a retired player');
});

check('an ordinary card that is not a deal earns no email', () => {
  // Fourth year, unremarkable player, PSA 10, priced at what it is worth.
  assert.deepStrictEqual(reasonsFor({ exp: 4, askUsd: 300, edge: 0.02, landedAud: 490 }), [],
    'a card qualifying on nothing was still queued for the email');
});

check('a genuine deal still earns DEAL on its own', () => {
  // The oldest of the three reasons, and the one every other test takes for
  // granted by hardcoding reasons: ['DEAL'] into its fixture.
  assert.ok(reasonsFor({ exp: 4, askUsd: 300, edge: 0.5, landedAud: 250, dynRank: 20 }).includes('DEAL'),
    'a deep discount on a top-24 player no longer earns an email at all');
});

check('a card priced above the market is never described as cheap', () => {
  // The hook used to assume everything reaching the email was a bargain,
  // which was true while only buys were emailed. Targets and profile cards
  // now arrive at any call. One line claiming a dear card is cheap costs the
  // credibility of every other line in the email.
  const over = evaluate(row({ player: 'Luther Burden III', conviction: 1.4, alwaysAlert: true, landedAud: 600, compAud: 500, edge: -0.2 }));
  assert.ok(!/cheap|under|below/i.test(over.hook), `hook called a dear card cheap: "${over.hook}"`);
  assert.ok(!/cheap|under|below/i.test(over.take), `take called a dear card cheap: "${over.take}"`);

  const level = evaluate(row({ conviction: 1.4, alwaysAlert: true, landedAud: 500, compAud: 500, edge: 0 }));
  assert.ok(!/cheap/i.test(level.hook), `hook called a fairly priced card cheap: "${level.hook}"`);
});

check('the profile does not need a valuation', () => {
  assert.ok(reasonsFor({ exp: 1, grade: 10, askUsd: 150, edge: undefined, compAud: undefined }).includes('PROFILE'),
    'a profile card was gated on having a value, which is the opposite of the point');
});

/* ---------- targets and profile actually reach the email ---------- */

/**
 * Everything above stops at evaluate() and only inspects verdict.reasons.
 * That left the delivery path untested, and it showed: five separate mutations
 * that each destroy the feature all passed a green suite. run.js could stop
 * forwarding unpriced targets, selectAlerts could return empty target and
 * profile buckets, notify could revert to the old bar, score.js could stop
 * carrying alwaysAlert, and alert.js could go back to printing "-9% under".
 *
 * These assertions run a card the whole way to rendered email text.
 */

const emailFor = (rows) => {
  const sel = selectAlerts(rows);
  return { sel, mail: buildAlert(sel, {}) };
};

check('a named target at a bad call reaches the rendered email', () => {
  const r = row({ itemId: 'T1', player: 'Luther Burden III', conviction: 1.4, alwaysAlert: true, edge: -0.25, landedAud: 600, compAud: 480 });
  r.verdict = evaluate(r);
  const { sel, mail } = emailFor([r]);
  assert.strictEqual(sel.targets.length, 1, 'the target never reached a section of the email');
  assert.ok(mail.text.includes('Luther Burden III'), 'the target is not in the email body');
  assert.ok(mail.html.includes('Your targets'), 'the targets section did not render');
});

check('a profile card reaches the rendered email', () => {
  const r = row({ itemId: 'P1', player: 'Cam Ward', exp: 0, team: 'TEN', dynRank: 90, askUsd: 150, edge: 0.03, landedAud: 250, compAud: 258 });
  r.verdict = evaluate(r);
  const { sel, mail } = emailFor([r]);
  assert.strictEqual(sel.profile.length, 1, 'the profile card never reached a section of the email');
  assert.ok(mail.html.includes('Fits your profile'), 'the profile section did not render');
});

check('a section cap never swallows a card that another section would show', () => {
  // The exclusion set was built from the uncapped act list and act was then
  // sliced, so a named target sitting at act position 11 was cut from act,
  // barred from the targets section for being "already shown", displayed
  // nowhere, and marked as emailed. The one card the feature exists for.
  const rows = Array.from({ length: 12 }, (_, i) =>
    row({ itemId: `S${i}`, player: `Filler ${i}`, edge: 0.5, score: 1 - i * 0.01 }));
  const target = row({ itemId: 'TGT', player: 'Emeka Egbuka', conviction: 1.4, alwaysAlert: true, edge: 0.25, score: 0.001 });
  const all = [...rows, target].map((r) => { r.verdict = evaluate(r); return r; });

  const { sel } = emailFor(all);
  const displayed = [...sel.act, ...sel.also, ...sel.targets, ...sel.profile].map((r) => r.itemId);
  assert.ok(displayed.includes('TGT'),
    'a named target was cut by the act cap and then excluded from the targets section, so it is marked sent without ever being shown');
});

check('the email never prints a negative discount as a discount', () => {
  // verdict.hook is guarded by its own assertion above. This one guards the
  // other half, the price line built in alert.js, which CLAUDE.md names as the
  // second place the word "under" was hardcoded next to the edge.
  const r = row({ itemId: 'O1', player: 'Emeka Egbuka', conviction: 1.4, alwaysAlert: true, edge: -0.25, landedAud: 600, compAud: 480 });
  r.verdict = evaluate(r);
  const { mail } = emailFor([r]);
  assert.ok(!/-\d+% under/.test(mail.text), `email printed a negative discount as a discount: ${mail.text.match(/.*under.*/)?.[0]}`);
  assert.ok(/25% over/.test(mail.text), 'an over-market card is not described as over market');
});

check('the strapline does not claim everything is under market when it is not', () => {
  const t = row({ itemId: 'T2', player: 'Luther Burden III', conviction: 1.4, alwaysAlert: true, edge: -0.3, landedAud: 700, compAud: 540 });
  t.verdict = evaluate(t);
  const { mail } = emailFor([t]);
  assert.ok(!/under what comparable cards ask/.test(mail.html),
    'the header still tells Ryan every card below is under market, on an email whose only card is over it');
});

check('the subject leads with the deals, not with a target at a weak call', () => {
  const deals = ['Zay Flowers', 'Drake London', 'Bucky Irving'].map((p, i) =>
    row({ itemId: `D${i}`, player: p, edge: 0.55, score: 2 - i * 0.1 }));
  const weakTarget = row({ itemId: 'T3', player: 'Luther Burden III', conviction: 1.4, alwaysAlert: true, edge: -0.25, landedAud: 600, compAud: 480, score: -1 });
  const all = [...deals, weakTarget].map((r) => { r.verdict = evaluate(r); return r; });
  const { mail } = emailFor(all);
  assert.ok(!/^Luther Burden III listed/.test(mail.subject),
    `a target the tool rated badly took the subject line off three strong buys: "${mail.subject}"`);
});

check('an unpriced target is forwarded to the notifier, an unpriced nobody is not', () => {
  // run.js used to build this population inline, where it was deletable
  // without a single assertion noticing.
  const target = row({ itemId: 'U1', player: 'Emeka Egbuka', conviction: 1.4, alwaysAlert: true, unpriced: 'no-comp-for-player-year', edge: undefined, compAud: undefined });
  const nobody = row({ itemId: 'U2', player: 'Nobody', exp: 7, dynRank: null, unpriced: 'no-comp-for-player-year', edge: undefined, compAud: undefined });
  [target, nobody].forEach((r) => { r.verdict = evaluate(r); });
  const priced = [row({ itemId: 'B1' })];
  priced.forEach((r) => { r.verdict = evaluate(r); });

  const pop = alertPopulation(priced, [target, nobody]).map((r) => r.itemId);
  assert.ok(pop.includes('U1'), 'an unpriced named target never reaches the notifier');
  assert.ok(!pop.includes('U2'), 'the whole unpriced pile is being forwarded, so the email becomes the report');
  assert.ok(pop.includes('B1'), 'priced rows stopped being forwarded');
});

/**
 * The one test that touches real files rather than hand-built rows. It proves
 * the chain data/my-players.json -> setConviction -> normPlayer -> scoreListing
 * -> evaluate actually connects, which matters because my-players.json spells
 * him "Luther Burden III" while the Sleeper index stores "Luther Burden", and
 * normPlayer strips the suffix from both ends to make them meet.
 */
check('alwaysAlert survives the trip from my-players.json to a scored listing', () => {
  const players = require('./data/my-players.json').rows;
  setConviction(players);
  const flagged = players.filter((p) => p.alwaysAlert);
  assert.ok(flagged.length, 'no player in my-players.json is flagged alwaysAlert');

  for (const p of flagged) {
    const parsed = {
      player: p.player, year: 2025, set: 'prizm', insert: 'rookie auto', parallel: null,
      cardNo: null, serial: null, grade: 10, confidence: 90,
      pos: 'WR', exp: 1, age: 22, team: 'CHI', debut: 2025, dynRank: 47, dynTrend30: 100,
      warnings: [],
    };
    const listing = {
      itemId: `L-${p.player}`, title: 't', url: 'https://example.invalid',
      price: 300, currency: 'USD', shipping: 20, shippingUnknown: false,
      country: 'US', feedbackPct: 99, feedbackScore: 500,
    };
    const scored = scoreListing(listing, parsed, { comp: null, matchConfidence: 0, reason: 'no-comp-for-player-year' }, fx, null);
    assert.strictEqual(scored.alwaysAlert, true, `alwaysAlert did not reach the scored row for ${p.player}`);
    scored.verdict = evaluate(scored);
    assert.ok(scored.verdict.reasons.includes('TARGET'),
      `${p.player} is flagged alwaysAlert but earns no TARGET reason, so he would never be emailed`);
  }

  // Same trip for the profile rule, which needs three fields scoreListing has
  // to carry onto the row: grade, exp and team, plus askUsd which it derives.
  // Drop any one of them and PROFILE silently never fires again.
  const rookie = {
    player: 'Cam Ward', year: 2025, set: 'prizm', insert: 'rookie auto', parallel: null,
    cardNo: null, serial: null, grade: 10, confidence: 90,
    pos: 'QB', exp: 0, age: 23, team: 'TEN', debut: 2025, dynRank: 90, dynTrend30: 20,
    warnings: [],
  };
  const cheap = {
    itemId: 'PROF', title: 't', url: 'https://example.invalid',
    price: 150, currency: 'USD', shipping: 15, shippingUnknown: false,
    country: 'US', feedbackPct: 99, feedbackScore: 500,
  };
  const p = scoreListing(cheap, rookie, { comp: null, matchConfidence: 0, reason: 'no-comp-for-player-year' }, fx, null);
  assert.ok(p.askUsd > 0, `scoreListing did not derive an asking price in USD, got ${p.askUsd}`);
  assert.strictEqual(p.team, 'TEN', 'scoreListing is not carrying team, so the rostered guard rejects everyone');
  p.verdict = evaluate(p);
  assert.ok(p.verdict.reasons.includes('PROFILE'),
    'a rostered, ranked, first year PSA 10 asking under the ceiling earned no PROFILE reason');

  // An AU listing priced in AUD has to convert before it is compared with a
  // USD ceiling, or every Australian card is judged against the wrong number.
  const auListing = { ...cheap, itemId: 'AU', price: 150 * fx.usdToAud, currency: 'AUD', country: 'AU' };
  const au = scoreListing(auListing, rookie, { comp: null, matchConfidence: 0, reason: 'x' }, fx, null);
  assert.ok(Math.abs(au.askUsd - 150) < 1, `an AUD listing was not converted to USD: askUsd ${au.askUsd}`);

  // Sleeper stores him without the suffix, my-players.json with it. If that
  // ever stops matching, the whole feature silently does nothing.
  const idx = require('./data/player-index.json').byName;
  for (const p of flagged) {
    const bare = String(p.player).replace(/\s+(jr|sr|ii|iii|iv|v)$/i, '').toLowerCase();
    assert.ok(idx[bare] || idx[String(p.player).toLowerCase()],
      `${p.player} is in my-players.json but the player index has neither that name nor "${bare}", so no listing will ever resolve to him`);
  }
});

check('the subject counts your men, not their listings', () => {
  const cards = Array.from({ length: 6 }, (_, i) =>
    row({ itemId: `M${i}`, player: i % 2 ? 'Luther Burden III' : 'Emeka Egbuka', conviction: 1.4, alwaysAlert: true, edge: -0.1, landedAud: 400 + i, compAud: 440, score: -1 }));
  cards.forEach((r) => { r.verdict = evaluate(r); });
  const { mail } = emailFor(cards);
  assert.ok(!/[3-9]\d* of your guys/.test(mail.subject),
    `subject counted listings as people: "${mail.subject}" (only 2 men are named)`);
  // The email's own heading counts too, and it is a separate line of code.
  const h1 = (mail.html.match(/font-size:20px[^>]*>([^<]*)</) || [])[1] || '';
  assert.ok(!/[3-9]\d* of your guys/.test(h1),
    `the email heading counted listings as people: "${h1}"`);
});

check('a card appears in exactly one section of the email', () => {
  // Every section is a different claim about the card. Showing the same
  // listing under two of them reads as two finds and wastes the cap twice.
  const cards = [
    row({ itemId: 'X1', player: 'Emeka Egbuka', conviction: 1.4, alwaysAlert: true, exp: 0, team: 'TB', dynRank: 27, askUsd: 150, edge: 0.5, landedAud: 200, compAud: 400, score: 2 }),
    row({ itemId: 'X2', player: 'Cam Ward', exp: 0, team: 'TEN', dynRank: 90, askUsd: 150, edge: 0.5, landedAud: 200, compAud: 400, score: 1.5 }),
    row({ itemId: 'X3', player: 'Luther Burden III', conviction: 1.4, alwaysAlert: true, exp: 1, team: 'CHI', dynRank: 47, askUsd: 190, edge: -0.1, landedAud: 500, compAud: 455, score: -1 }),
  ];
  cards.forEach((r) => { r.verdict = evaluate(r); });
  const { sel } = emailFor(cards);
  const ids = [...sel.act, ...sel.also, ...sel.targets, ...sel.profile].map((r) => r.itemId);
  assert.strictEqual(ids.length, new Set(ids).size,
    `a card was rendered in more than one section: ${ids.join(', ')}`);
  // And every one of them still got shown somewhere.
  assert.strictEqual(new Set(ids).size, cards.length, `${cards.length - new Set(ids).size} card(s) vanished entirely`);
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
