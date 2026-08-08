/**
 * The reality check.
 *
 * Takes cards Ryan already knows the market on, runs each one through the
 * full pipeline, and reports where the tool agrees with him and where it
 * does not. Three separate things can go wrong and they need separating,
 * because the fix for each is completely different:
 *
 *   1. It could not read the title           -> parser problem, fix vocab.js
 *   2. It read it but tied it to the wrong
 *      card, or could not find the card      -> matcher or comp coverage
 *   3. It found the right card but the value
 *      disagrees with Ryan                   -> the price data is wrong, or
 *                                               Ryan is, and that is the
 *                                               conversation worth having
 *
 * Run: npm run backtest
 */

const fs = require('fs');
const path = require('path');
require('./providers').loadPlayerIndexFromDisk();
const { parseTitle } = require('./parse');
const { buildIndex, matchListing } = require('./match');
const P = require('./providers');

const TOL = { good: 0.15, ok: 0.30 };   // within 15% is agreement, 30% is close

(async () => {
  const known = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'known-cards.json'), 'utf8'));
  const fx = await P.getFx();
  // Same two sources the live scan uses: your values first, market fill-in.
  const values = await P.getValues(fx, P.loadMarketStore());
  const index = buildIndex(values.rows);

  const usingExamples = known.cards.every((c) => /EXAMPLE/i.test(c.note || ''));
  const rows = [];

  for (const card of known.cards) {
    const r = {
      title: card.title, note: card.note,
      knownUsd: card.currency === 'AUD' ? card.knownValue / fx.usdToAud : card.knownValue,
      stage: null, toolUsd: null, diff: null, verdict: null, detail: '',
    };

    const parsed = parseTitle(card.title);

    if (parsed.reject) {
      r.stage = 'could not read'; r.verdict = 'PARSER'; r.detail = parsed.reject;
    } else if (parsed.confidence < 70) {
      r.stage = 'could not read'; r.verdict = 'PARSER';
      r.detail = `confidence ${parsed.confidence}, ${parsed.blockers.join(' ') || 'thin title'}`;
    } else {
      const m = matchListing(parsed, index);
      if (!m.comp) {
        r.stage = 'could not find the card'; r.verdict = 'MATCHER';
        r.detail = m.reason || 'no comp';
      } else {
        r.stage = 'priced it';
        r.matchedTo = `${m.comp.year} ${m.comp.player} ${m.comp.parallel || 'base'}`;
        r.matchConfidence = m.matchConfidence;
        r.toolUsd = m.comp.psa10UsdCents / 100;
        r.diff = (r.toolUsd - r.knownUsd) / r.knownUsd;
        const a = Math.abs(r.diff);
        r.verdict = a <= TOL.good ? 'AGREES' : a <= TOL.ok ? 'CLOSE' : 'DISAGREES';
        r.detail = `matched ${m.matchConfidence}%`;
      }
    }
    rows.push(r);
  }

  /* ---------- report ---------- */

  const pad = (s, n) => String(s ?? '').padEnd(n).slice(0, n);
  const pc = (n) => (n >= 0 ? '+' : '') + (n * 100).toFixed(0) + '%';

  console.log('\n' + '='.repeat(104));
  console.log('REALITY CHECK'.padEnd(60) + `${rows.length} cards  ·  fx ${fx.usdToAud.toFixed(4)}`);
  console.log('='.repeat(104));

  if (usingExamples) {
    console.log('\n  >> These are the example rows I wrote, checked against invented prices.');
    console.log('  >> All this proves today is that the machinery runs. Put your own cards');
    console.log('  >> in data/known-cards.json for a result that means something.\n');
  }

  console.log(pad('verdict', 11) + pad('you', 10) + pad('tool', 10) + pad('gap', 7) + 'card');
  console.log('-'.repeat(104));
  for (const r of rows) {
    console.log(
      pad(r.verdict, 11) +
      pad('$' + r.knownUsd.toFixed(0), 10) +
      pad(r.toolUsd == null ? '-' : '$' + r.toolUsd.toFixed(0), 10) +
      pad(r.diff == null ? '-' : pc(r.diff), 7) +
      pad(r.title, 60)
    );
    if (r.verdict !== 'AGREES') console.log(' '.repeat(11) + `${r.stage}: ${r.detail}`);
  }

  /* ---------- summary ---------- */

  const priced = rows.filter((r) => r.toolUsd != null);
  const agrees = rows.filter((r) => r.verdict === 'AGREES').length;
  const close = rows.filter((r) => r.verdict === 'CLOSE').length;
  const parserFails = rows.filter((r) => r.verdict === 'PARSER').length;
  const matcherFails = rows.filter((r) => r.verdict === 'MATCHER').length;
  const disagrees = rows.filter((r) => r.verdict === 'DISAGREES').length;

  const errs = priced.map((r) => Math.abs(r.diff)).sort((a, b) => a - b);
  const median = errs.length ? errs[Math.floor(errs.length / 2)] : null;

  console.log('\n' + '-'.repeat(104));
  console.log(`priced ${priced.length}/${rows.length}   agrees ${agrees}   close ${close}   disagrees ${disagrees}   ` +
    `could not read ${parserFails}   could not find ${matcherFails}`);
  if (median != null) console.log(`typical gap between you and the tool: ${(median * 100).toFixed(0)}%`);

  /* ---------- verdict ---------- */

  console.log('\nWHERE THAT LEAVES YOU');
  if (usingExamples) {
    console.log('  The pipeline runs end to end. Nothing here says anything about accuracy');
    console.log('  yet, because both the prices and the cards are mine.');
  } else if (parserFails + matcherFails > rows.length * 0.3) {
    console.log('  Too many cards never got priced at all. That is a coverage problem, not');
    console.log('  an accuracy one. Worth fixing before you look at the value gaps.');
  } else if (median != null && median <= TOL.good) {
    console.log('  The tool broadly agrees with you on cards you know. That is the result');
    console.log('  you want before trusting it with money on cards you do not.');
  } else if (median != null && median <= TOL.ok) {
    console.log('  Close but loose. Fine for shortlisting what to look at, not tight enough');
    console.log('  to buy off without checking the card yourself first.');
  } else {
    console.log('  The tool and you disagree more than you agree. Do not buy off these');
    console.log('  scores. Look at the DISAGREES rows above and work out which of you is');
    console.log('  wrong before going further.');
  }

  console.log('\n  Reminder: this only checks card values. It does not check whether the');
  console.log('  import cost estimate is right. That one needs a real eBay invoice.\n');

  fs.writeFileSync(path.join(__dirname, 'backtest-result.json'),
    JSON.stringify({ ranAt: new Date().toISOString(), usingExamples, fx, rows }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
