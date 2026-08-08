/**
 * Comparable-cards valuation.
 *
 * The problem this solves: comparing a card only against other copies of
 * itself needs weeks of scanning. A single sweep of 2,765 real listings held
 * 1,207 distinct cards and exactly one of them had six copies. So on day one
 * the tool could price almost nothing.
 *
 * This values a card the way an appraiser does when there is no exact comp:
 * find cards that are alike in the ways that drive price, and use those.
 *
 * Three things define "alike", measured against real data:
 *
 *   set        a National Treasures RPA and a Score auto are not the same
 *              market, whoever is on the card
 *   rarity     base, a colour, /99, /25. This is the biggest single lever
 *              inside a set
 *   player     dynasty standing. Measured on the live scan, asking prices
 *              ran $347 median for a top-24 player down to $177 for someone
 *              unranked, cleanly monotonic through the bands
 *
 * It widens the net in steps when a pool is too thin, and reports which step
 * it used so the confidence in the number is visible rather than implied.
 */

const CFG = require('./config');

/* ---------- how a card is classified ---------- */

// Rarity drives price harder than anything except the set itself.
function rarityTier(p) {
  const of = p.serial?.of ?? null;
  if (of === 1) return 'one-of-one';
  if (of != null && of <= 25) return 'ultra';       // /25 and under
  if (of != null && of <= 99) return 'rare';        // /26 to /99
  if (of != null) return 'numbered';                // /100 and up
  return p.parallel ? 'colour' : 'base';
}

/**
 * Licensed or not. Leaf, Wild Card, Sage and the rest carry no NFL logos,
 * and the hobby prices them well below Panini and Topps for the same player.
 * Measured on the live scan: for top-60 dynasty players, licensed cards asked
 * a $307 median against $245 unlicensed. Pooling them together quietly
 * inflates every unlicensed card's estimated value and manufactures a
 * discount that is not there.
 */
const UNLICENSED_SETS = new Set([
  'leaf', 'leaf pro set', 'pro set', 'metal', 'metal draft', 'valiant',
  'trinity', 'flash', 'sage', 'sage hit', 'super break', 'wild card',
  'wild card matte', 'signature class', 'press pass', 'army all american',
]);
const licensing = (set) => (UNLICENSED_SETS.has(String(set || '').toLowerCase()) ? 'unlic' : 'lic');

// Where the hobby rates the player. Bands chosen to match the price steps
// actually observed in the scan rather than round numbers for their own sake.
function playerBand(dynRank) {
  if (dynRank == null) return 'unranked';
  if (dynRank <= 24) return 'elite';
  if (dynRank <= 60) return 'high';
  if (dynRank <= 200) return 'mid';
  return 'low';
}

const median = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/* ---------- building the pools ---------- */

/**
 * Called once per scan with every listing that parsed cleanly. Asking price
 * in AUD, before import costs: import is Ryan's problem, not the market's,
 * and folding it in would make US and AU listings look like different cards.
 */
function buildPools(entries) {
  const pools = { setTierBand: {}, tierBand: {}, tier: {} };
  const push = (obj, key, v) => { (obj[key] = obj[key] || []).push(v); };

  for (const { parsed, askAud } of entries) {
    if (!parsed?.set || !(askAud > 0)) continue;
    const t = rarityTier(parsed);
    const b = playerBand(parsed.dynRank);
    // Grade is part of every key. A PSA 9 and a PSA 10 of the same card are
    // different assets at different prices, and pooling them would make every
    // 9 look like a bargain and every 10 look expensive.
    const g = parsed.grade || 10;
    const lc = licensing(parsed.set);
    push(pools.setTierBand, `${g}|${parsed.set}|${t}|${b}`, askAud);
    push(pools.tierBand, `${g}|${lc}|${t}|${b}`, askAud);
    push(pools.tier, `${g}|${lc}|${t}`, askAud);
  }
  return pools;
}

/* ---------- valuing one card ---------- */

const MIN_POOL = 5;

/**
 * Returns an estimated market asking level for this card, plus how it was
 * arrived at. Null when there is genuinely nothing comparable, which is the
 * honest answer for a one-of-one.
 */
function estimate(parsed, pools) {
  const t = rarityTier(parsed);
  const b = playerBand(parsed.dynRank);

  // A true one-of-one has no comparable. Saying so is better than pricing it
  // against /25s and calling the difference an edge.
  if (t === 'one-of-one') {
    return { estAud: null, n: 0, basis: 'one-of-one', tier: t, band: b, confidence: 0 };
  }

  const g = parsed.grade || 10;
  const lc = licensing(parsed.set);
  const steps = [
    { key: `${g}|${parsed.set}|${t}|${b}`, pool: pools.setTierBand, basis: 'same grade, set, rarity and player tier', confidence: 3 },
    { key: `${g}|${lc}|${t}|${b}`, pool: pools.tierBand, basis: 'same grade, licensing, rarity and player tier', confidence: 2 },
    { key: `${g}|${lc}|${t}`, pool: pools.tier, basis: 'same grade, licensing and rarity', confidence: 1 },
  ];

  for (const s of steps) {
    const v = s.pool[s.key];
    if (v && v.length >= MIN_POOL) {
      return { estAud: median(v), n: v.length, basis: s.basis, tier: t, band: b, confidence: s.confidence };
    }
  }
  return { estAud: null, n: 0, basis: 'no comparable pool', tier: t, band: b, confidence: 0 };
}

module.exports = { buildPools, estimate, rarityTier, playerBand, licensing, median, MIN_POOL, UNLICENSED_SETS };
