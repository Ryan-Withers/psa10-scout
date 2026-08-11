/**
 * The two sockets everything downstream plugs into.
 *
 * Nothing past this file knows or cares whether the data came from an API or
 * a file on disk. That is the whole point: the scorer, matcher, report and
 * alerting can be finished and tested before either credential exists, and
 * going live is a change to DATA_SOURCE rather than a rewrite.
 *
 *   DATA_SOURCE=seed  (default) read the placeholder files
 *   DATA_SOURCE=live            call the real APIs
 */

const fs = require('fs');
const path = require('path');
const CFG = require('./config');

const SOURCE = process.env.DATA_SOURCE || 'seed';
const readJson = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, f), 'utf8'));

/* ---------- player index ---------- *
 *
 * Lives here rather than in parse.js so the parser has no filesystem
 * dependency and its tests can inject a small fixture index instead.
 */
function loadPlayerIndexFromDisk(file = 'data/player-index.json') {
  const idx = readJson(file);
  require('./parse').setPlayerIndex(idx);
  return idx;
}

/* ---------- socket 1: what is for sale ---------- */

async function getListings(fx) {
  if (SOURCE === 'seed') {
    const d = readJson('data/listings-seed.json');
    return { rows: d.rows, source: 'seed', warning: d._README };
  }
  // Re-score the last live pull without spending any eBay quota.
  if (SOURCE === 'cached') {
    const d = readJson('data/listings-live.json');
    return { rows: d.rows, source: 'cached', discovery: d.discovery };
  }

  const { scanMarketplace, querySlice, QUERY_SET, chooseQueries } = require('./ebay');
  const id = process.env.EBAY_CLIENT_ID;
  const secret = process.env.EBAY_CLIENT_SECRET;
  if (!id || !secret) throw new Error('DATA_SOURCE=live needs EBAY_CLIENT_ID and EBAY_CLIENT_SECRET');

  const maxUsd = Number(process.env.MAX_PRICE_USD || CFG.budget.maxUsd);
  const marketplaces = (process.env.MARKETPLACES || 'EBAY_AU,EBAY_US').split(',').map((s) => s.trim());

  /**
   * A scheduled run searches for the watchlist by name, so a newly listed
   * card of one of Ryan's men is found on the very next scan rather than
   * whenever its slice next comes round.
   *
   * SCAN_ALL=1 swaps in the old set-based sweep, which is what you want for a
   * one-off run that rebuilds the comparable pools. It costs 146 searches.
   */
  const fullSweep = process.env.SCAN_ALL === '1';
  const querySource = chooseQueries(getConviction(), { fullSweep });

  const perRun = fullSweep
    ? QUERY_SET.length
    : Number(process.env.QUERIES_PER_RUN || CFG.scan.queriesPerRun);
  // On GitHub, SLICE_INDEX carries the run number so rotation survives the
  // scheduler starting runs late. Locally it is absent and the clock decides.
  const runNo = process.env.SLICE_INDEX === undefined || process.env.SLICE_INDEX === ''
    ? null : Number(process.env.SLICE_INDEX);
  const slice = querySlice(querySource, perRun, Date.now(), runNo);

  const seen = new Map();
  const discovery = {};
  let calls = 0, browse = 0;
  for (const marketplace of marketplaces) {
    // The ceiling is in USD, so the AU query has to be converted or you are
    // quietly shopping a different budget on each marketplace.
    const maxPrice = marketplace === 'EBAY_AU'
      ? Math.ceil(maxUsd * (fx?.usdToAud || CFG.fx.fallbackUsdToAud))
      : maxUsd;
    const r = await scanMarketplace({
      clientId: id, clientSecret: secret, marketplace, maxPrice, queries: slice.queries,
    });
    calls += r.calls || 0;
    browse += r.browse || 0;
    discovery[marketplace] = {
      catId: r.discovery.catId, catPath: r.discovery.catPath,
      resolved: r.discovery.resolved, passes: r.passes,
    };
    // Same card can surface on both marketplaces. Keep one.
    for (const l of r.listings) if (!seen.has(l.itemId)) seen.set(l.itemId, l);
  }
  discovery._slice = { ...slice, queries: slice.queries.length, calls, browse };

  const rows = [...seen.values()];
  // Saved the moment the API calls finish. Scoring happens after this and
  // can fail; the quota those calls cost cannot be got back. Re-run scoring
  // against the saved copy with DATA_SOURCE=cached.
  fs.writeFileSync(path.join(__dirname, 'data/listings-live.json'),
    JSON.stringify({ fetched: new Date().toISOString(), discovery, rows }));

  return { rows, source: 'live', discovery };
}

/* ---------- socket 2: what it is worth ---------- *
 *
 * Two sources, merged. Values you wrote down win. Where you have not
 * written a card down, the median of what other people are asking on eBay
 * fills the gap, discounted and scored down for being a guess.
 */

const market = require('./market');

function getMyValues() {
  try { return readJson('data/my-values.json'); }
  catch { return { rows: [] }; }
}

function getConviction() {
  try { return readJson('data/my-players.json').rows || []; }
  catch { return []; }
}

/**
 * Demo runs write to a separate store. Without this, running against the
 * placeholder listings would fold invented prices into the real price
 * history, and every median would be wrong from day one in a way that is
 * very hard to spot later.
 */
const marketStorePath = () =>
  SOURCE === 'live' ? 'data/market-store.json' : 'data/market-store-demo.json';

function loadMarketStore() {
  try { return readJson(marketStorePath()); }
  catch { return {}; }
}

function saveMarketStore(store) {
  fs.writeFileSync(path.join(__dirname, marketStorePath()), JSON.stringify(store));
}

async function getValues(fx, marketStore) {
  const hand = market.handValueRows(getMyValues());
  const observed = market.toValueRows(marketStore || {}, fx);
  return {
    rows: market.mergeValueRows(hand, observed),
    counts: { fromYou: hand.length, fromMarket: observed.length },
  };
}

/* ---------- socket 3: fx ---------- */

async function getFx() {
  try {
    const res = await fetch(CFG.fx.endpoint, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`fx ${res.status}`);
    const j = await res.json();
    const rate = j?.rates?.AUD;
    if (!rate || rate < 0.5 || rate > 3) throw new Error(`implausible rate ${rate}`);
    return { usdToAud: rate, asOf: j.time_last_update_utc, live: true };
  } catch (e) {
    // A stale rate is recoverable. A crashed scan at 3am is not.
    return { usdToAud: CFG.fx.fallbackUsdToAud, asOf: 'fallback', live: false, error: String(e.message) };
  }
}

module.exports = {
  getListings, getValues, getFx, getConviction,
  loadMarketStore, saveMarketStore, loadPlayerIndexFromDisk, SOURCE,
};
