/**
 * Guards the two things that have actually broken, both of which were silent.
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
 * Run: node test-market.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const market = require('./market');
const { notify, loadSent } = require('./notify');
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

const buy = (id, call) => ({
  itemId: id, player: `Player ${id}`, edge: 0.3, score: 1, landedAud: 150, compAud: 250,
  year: 2024, set: 'prizm', exp: 2, dynRank: 30,
  verdict: { call, shout: call === 'STRONG BUY', take: 'test', tags: [] },
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
