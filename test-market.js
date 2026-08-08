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
const { notify, loadSent } = require('./notify');
const { evaluate } = require('./verdict');
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
  grade: 10, exp: 4, age: 26, dynRank: 150, dynTrend30: 0, conviction: 1,
  alwaysAlert: false, askUsd: 300, landedAud: 460, compAud: 500, edge: 0.08,
  valueConfidence: 3, score: 0.05, ...over,
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

check('an ordinary card that is not a deal earns no email', () => {
  // Fourth year, unremarkable player, PSA 10, priced at what it is worth.
  assert.deepStrictEqual(reasonsFor({ exp: 4, askUsd: 300, edge: 0.02, landedAud: 490 }), [],
    'a card qualifying on nothing was still queued for the email');
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

    check('exactly three emails left the building', () => {
      assert.strictEqual(sends(), 3, `${sends()} emails sent, expected 3`);
    });
  });

  console.log(`\n${pass}/${pass + fail} assertions passing`);
  process.exit(fail ? 1 : 0);
})();
