/**
 * Observed market. Builds a price picture for each card out of what people
 * are actually asking on eBay, since there is no paid sold-price feed.
 *
 * Two things make this honest rather than junk:
 *
 *   Observations are keyed on itemId, not on sighting. Scanning every 30
 *   minutes means the same listing is seen 48 times a day. Counting those
 *   as 48 observations would turn one stubborn seller into a whole market.
 *   Re-seeing a listing updates it, it does not add to the sample.
 *
 *   Asking prices are not selling prices. The median ask is discounted by
 *   config.market.askToSoldRatio before it is used as a value. That ratio
 *   is a guess and it is the biggest error term in the whole no-paid-data
 *   setup, so it is a single named knob rather than something buried.
 *
 * What this cannot do: if every copy of a card on eBay is overpriced, the
 * median is overpriced too, and a slightly-less-overpriced listing will look
 * like a find. Relative pricing spots outliers within a market. It cannot
 * tell you the market itself is wrong.
 */

const CFG = require('./config');
const { hashTitle } = require('./parse');

/**
 * Seller identity is reduced to a one-way hash before anything is written.
 *
 * The only thing the seller field is used for is counting distinct sellers,
 * because six listings from one shop is one opinion about price, not six. A
 * hash answers "same seller or different" without persisting an eBay user
 * identifier, which keeps this store free of eBay user data and keeps the
 * account-deletion exemption honest.
 */
const sellerKey = (s) => (s ? 'h' + hashTitle(String(s).toLowerCase()) : null);

/* ---------- key ---------- */

// Same card, same key. Deliberately includes parallel, because base and a
// numbered colour are different cards with different prices.
function cardKey(p) {
  return [
    p.year || '?',
    (p.set || '?').toLowerCase(),
    (p.parallel || 'base').toLowerCase(),
    (p.insert || '').toLowerCase(),
    (p.player || '?').toLowerCase(),
  ].join('|');
}

/* ---------- recording ---------- */

// What the seller is asking, in AUD, before any import cost. Import is
// Ryan's problem not the market's, and folding it in here would make US
// listings look like a different card to AU ones.
function askAud(listing, fx) {
  const rate = listing.currency === 'AUD' ? 1 : fx.usdToAud;
  const ship = listing.shippingUnknown ? 0 : (listing.shipping || 0);
  return (listing.price + ship) * rate;
}

function record(store, parsed, listing, fx, now = Date.now()) {
  if (!parsed.player || !parsed.set || !parsed.year) return null;
  const key = cardKey(parsed);
  const bucket = (store[key] ||= { obs: {} });
  // Key is lowercased for stability. Keep the printed name for display.
  bucket.display = { player: parsed.player, set: parsed.set, parallel: parsed.parallel, insert: parsed.insert };

  const prev = bucket.obs[listing.itemId];
  bucket.obs[listing.itemId] = {
    aud: Math.round(askAud(listing, fx) * 100) / 100,
    at: prev?.at ?? now,   // first time we saw it
    last: now,             // most recent time we saw it
    // Being seen refutes having sold. A listing marked gone by an earlier
    // run that shows up again did not sell, whatever the earlier run
    // concluded, so the flag is cleared rather than preserved.
    gone: null,
    s: sellerKey(listing.seller),
  };
  return key;
}

/**
 * Mark listings that were here last time and are not here now.
 *
 * This is the closest thing to sold-price evidence available without paid
 * data. eBay's own sold API is a limited release and is not accepting new
 * applicants, so the alternative is to watch the shelf: a card that is gone
 * a day after listing went at roughly its asking price, one that sits for a
 * month did not.
 *
 * It cannot tell a sale from a seller pulling the listing. At the scale this
 * runs, a competitively priced card vanishing is far more often a sale than
 * a withdrawal, and the disappeared-fast set is used as a price signal
 * rather than as a claim about any single card.
 *
 * The grace period exists because a scheduled run only carries a third of
 * the keyword queries. A card whose query did not run this time is invisible
 * this run while still sitting on eBay, and without the grace it would be
 * marked sold by the very next scan. Caught by test before it shipped: every
 * keyword-found card was being counted as a fast sale, which would have
 * quietly inflated every cleared-price median. Three hours spans a full
 * rotation cycle plus a couple of dropped runs, and costs nothing against a
 * sold-within-14-days signal.
 */
function reconcile(store, seenItemIds, now = Date.now(), graceMs = CFG.market.goneGraceHours * 3600000) {
  let marked = 0;
  for (const bucket of Object.values(store)) {
    for (const [id, o] of Object.entries(bucket.obs || {})) {
      if (!o.gone && !seenItemIds.has(id) && o.last && o.last < now - graceMs) {
        o.gone = now;
        marked++;
      }
    }
  }
  return marked;
}

/* ---------- stats ---------- */

const median = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const quantile = (a, q) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))];
};

function statsFor(bucket, now = Date.now()) {
  const ttl = CFG.market.observationTtlDays * 86400000;
  const all = Object.values(bucket.obs || {}).filter((o) => now - o.at <= ttl);
  const prices = all.map((o) => o.aud);
  // Distinct sellers matters: six listings from one shop is one opinion.
  const sellers = new Set(all.map((o) => o.s).filter(Boolean));

  // Listings that disappeared quickly. These are the ones that most likely
  // sold, and their asking prices are the best free evidence of what the
  // card actually fetches.
  const fastMs = CFG.market.soldWithinDays * 86400000;
  const cleared = all.filter((o) => o.gone && (o.gone - o.at) <= fastMs);
  const stillUp = all.filter((o) => !o.gone);

  return {
    n: all.length,
    distinctSellers: sellers.size,
    medianAskAud: median(prices),
    p25AskAud: quantile(prices, 0.25),
    clearedCount: cleared.length,
    medianClearedAud: median(cleared.map((o) => o.aud)),
    stillListedCount: stillUp.length,
    lastSeen: all.length ? Math.max(...all.map((o) => o.last || o.at)) : null,
  };
}

/* ---------- prune ---------- */

// Keeps the stored blob from growing forever. Runs against the same TTL the
// stats use, so nothing that would have counted gets thrown away.
function prune(store, now = Date.now()) {
  const ttl = CFG.market.observationTtlDays * 86400000;
  let dropped = 0;
  for (const key of Object.keys(store)) {
    const obs = store[key].obs || {};
    for (const id of Object.keys(obs)) {
      if (now - obs[id].at > ttl) { delete obs[id]; dropped++; }
    }
    if (!Object.keys(obs).length) delete store[key];
  }
  return dropped;
}

/* ---------- derive comp rows ---------- */

/**
 * Turns the observation store into value rows the matcher can use, in the
 * same shape as hand-entered values so nothing downstream has to care where
 * a number came from.
 */
function toValueRows(store, fx, now = Date.now()) {
  const rows = [];
  for (const [key, bucket] of Object.entries(store)) {
    const s = statsFor(bucket, now);
    if (s.n < CFG.market.minObservations) continue;
    if (!s.medianAskAud) continue;

    const [year, set, parallel, insert] = key.split('|');
    const player = bucket.display?.player || key.split('|')[4];

    // Prefer what actually cleared the shelf. That is close to a real sale
    // price and needs no fudge factor. Only fall back to discounting the
    // asking price when not enough listings have moved yet.
    const useCleared = s.clearedCount >= CFG.market.minClearedForPrice && s.medianClearedAud;
    const estAud = useCleared
      ? s.medianClearedAud
      : s.medianAskAud * CFG.market.askToSoldRatio;

    rows.push({
      id: `market:${key}`,
      valueSource: 'market',
      year: Number(year),
      set,
      parallel: parallel === 'base' ? null : parallel,
      insert: insert || null,
      player,
      cardNo: null,
      serialOf: null,
      psa10UsdCents: Math.round((estAud / fx.usdToAud) * 100),
      // Liquidity stand-in: how many distinct copies we have seen listed.
      salesVolumeYear: s.n,
      observations: s.n,
      distinctSellers: s.distinctSellers,
      medianAskAud: Math.round(s.medianAskAud * 100) / 100,
      // How the number was arrived at, so the alert can say so out loud.
      basis: useCleared ? 'cleared' : 'asking',
      clearedCount: s.clearedCount,
      stillListedCount: s.stillListedCount,
    });
  }
  return rows;
}

/* ---------- hand-entered values ---------- */

function handValueRows(myValues) {
  return (myValues.rows || [])
    .filter((r) => !/^_/.test(String(r.player || '')))
    .map((r, i) => ({
      id: `you:${i}`,
      valueSource: 'you',
      year: r.year,
      set: (r.set || '').toLowerCase(),
      parallel: r.parallel ? String(r.parallel).toLowerCase() : null,
      insert: r.insert || null,
      player: r.player,
      cardNo: r.cardNo || null,
      serialOf: r.serialOf ?? null,
      psa10UsdCents: Math.round(Number(r.psa10Usd) * 100),
      // Hand-entered values carry no volume signal, so liquidity is not
      // gated on them. You would not have written it down if you did not
      // care about the card.
      salesVolumeYear: null,
      reviewed: r.reviewed || null,
    }));
}

/**
 * Your values win. Where you have not written a card down, the observed
 * market fills in. Never the other way round.
 */
function mergeValueRows(handRows, marketRows) {
  const seen = new Set(handRows.map((r) =>
    [r.year, r.set, r.parallel || 'base', r.player.toLowerCase()].join('|')));
  const extra = marketRows.filter((r) =>
    !seen.has([r.year, r.set, r.parallel || 'base', r.player.toLowerCase()].join('|')));
  return [...handRows, ...extra];
}

module.exports = {
  cardKey, askAud, record, reconcile, statsFor, prune,
  toValueRows, handValueRows, mergeValueRows, median,
};
