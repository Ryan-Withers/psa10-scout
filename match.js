/**
 * Resolve a parsed listing to a comp row.
 *
 * Two things are treated as unforgivable rather than as deductions:
 *
 *   Parallel disagreement. A base card and a numbered colour from the same
 *   set can be ten times apart in price. Matching a silver listing to a base
 *   comp does not produce a slightly wrong number, it produces a fake bargain
 *   that looks great and loses money. Any disagreement is a hard fail.
 *
 *   Set disagreement. Same reason, larger magnitude.
 *
 * Everything else is scored, and the total has to clear the threshold in
 * config before the listing is allowed anywhere near the ranking.
 */

const CFG = require('./config');

/* ---------- vocabulary reconciliation ---------- */

// Sellers and price guides call the same subset different things. Without
// this, "RPA" and "Rookie Patch Autograph" are two different cards.
const INSERT_ALIAS = new Map(Object.entries({
  'rpa': 'rookie patch auto',
  'rookie patch auto': 'rookie patch auto',
  'rookie patch autograph': 'rookie patch auto',
  'patch autograph': 'rookie patch auto',
  'autograph patch': 'rookie patch auto',
  'rookie jersey autograph': 'rookie jersey auto',
  'rookie jersey auto': 'rookie jersey auto',
  'rookie autographs': 'rookie auto',
  'rookie signatures': 'rookie auto',
  'rookie signature': 'rookie auto',
  'rookie auto': 'rookie auto',
  'rookie ticket': 'rookie ticket',
  'rookie ticket swatches': 'rookie ticket swatches',
  'cracked ice ticket': 'cracked ice ticket',
  'draft picks': 'draft picks',
  'rated rookie': 'rated rookie',
  'rated rookies': 'rated rookie',
  'kaboom': 'kaboom',
  'downtown': 'downtown',
  'color blast': 'color blast',
  'colour blast': 'color blast',
}));

// The set name leaks into the parallel because the products are named that
// way: a "Silver Prizm" is the silver parallel of Prizm, not a separate
// finish. Strip the set word so "prizm silver" and "silver" are one thing.
const SET_WORDS_IN_PARALLEL = new Set(['prizm', 'prizms', 'mosaic', 'optic', 'select', 'chrome']);

function normParallel(p) {
  if (!p) return null;
  const parts = String(p).toLowerCase().split(/\s+/).filter((w) => w && !SET_WORDS_IN_PARALLEL.has(w));
  return parts.length ? parts.sort().join(' ') : null;
}

function normInserts(i) {
  if (!i) return new Set();
  return new Set(
    String(i).split('+').map((s) => s.trim().toLowerCase())
      .map((s) => INSERT_ALIAS.get(s) || s)
      .filter(Boolean)
  );
}

const normName = (s) => String(s || '').toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[.'`]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

const normSet = (s) => String(s || '').toLowerCase().trim();

/* ---------- index ---------- */

function buildIndex(compRows) {
  const byPlayerYear = new Map();
  for (const c of compRows) {
    const k = `${normName(c.player)}|${c.year}`;
    if (!byPlayerYear.has(k)) byPlayerYear.set(k, []);
    byPlayerYear.get(k).push(c);
  }
  return { byPlayerYear, rows: compRows };
}

/* ---------- scoring one candidate ---------- */

function scoreCandidate(parsed, comp) {
  // Set has to agree. No partial credit.
  if (normSet(parsed.set) !== normSet(comp.set)) return null;

  // Parallel has to agree, including base-versus-base. See the header.
  const lp = normParallel(parsed.parallel);
  const cp = normParallel(comp.parallel);
  if (lp !== cp) return null;

  let s = 20; // player, year and set already agreed to get here
  s += 30;    // parallel agreed

  const li = normInserts(parsed.insert);
  const ci = normInserts(comp.insert);
  if (li.size === 0 && ci.size === 0) s += 22;
  else if ([...li].some((x) => ci.has(x))) s += 25;
  else if (li.size === 0 || ci.size === 0) s += 12;
  else s += 6;

  if (parsed.cardNo && comp.cardNo) s += normName(parsed.cardNo) === normName(comp.cardNo) ? 15 : 2;
  else s += 10;

  const ls = parsed.serial?.of ?? null;
  const cs = comp.serialOf ?? null;
  if (ls != null && cs != null) s += ls === cs ? 10 : 0;
  else s += 7;

  return Math.min(100, s);
}

/* ---------- public ---------- */

function matchListing(parsed, index) {
  if (!parsed.player || !parsed.year) {
    return { comp: null, matchConfidence: 0, reason: 'no-player-or-year' };
  }

  const key = `${normName(parsed.player)}|${parsed.year}`;
  let candidates = index.byPlayerYear.get(key) || [];

  // Draft and season-dated products drift a year against the price guide.
  if (!candidates.length) {
    for (const d of [-1, 1]) {
      const alt = index.byPlayerYear.get(`${normName(parsed.player)}|${parsed.year + d}`);
      if (alt) { candidates = alt; break; }
    }
  }
  if (!candidates.length) return { comp: null, matchConfidence: 0, reason: 'no-comp-for-player-year' };

  let best = null;
  for (const c of candidates) {
    const s = scoreCandidate(parsed, c);
    if (s != null && (!best || s > best.matchConfidence)) best = { comp: c, matchConfidence: s };
  }

  if (!best) return { comp: null, matchConfidence: 0, reason: 'set-or-parallel-disagreement' };
  if (best.matchConfidence < CFG.gates.minMatchConfidence) {
    return { ...best, reason: 'below-match-threshold' };
  }
  return { ...best, reason: null };
}

module.exports = { buildIndex, matchListing, normParallel, normInserts };
