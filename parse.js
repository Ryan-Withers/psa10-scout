/**
 * eBay title parser for graded football autograph cards.
 *
 * parseTitle(title) -> {
 *   ok, reject, year, brand, set, insert, parallel, player, cardNo,
 *   serial:{num,of}, cert, confidence, blockers, residual, matchKey, hash
 * }
 *
 * Design notes that matter:
 *
 * 1. Players are extracted BEFORE parallels. Half the parallel vocabulary is
 *    also a common surname (Green, Brown, White, Black). Matching parallels
 *    first would eat "A.J. Green" and report a green parallel of nobody.
 *    Player token spans are consumed, so the colour matcher never sees them.
 *
 * 2. Structured fields (cert, serial, card number) are pulled off the string
 *    before hyphens are flattened, because card numbers look like RPS-JJ and
 *    would otherwise be split into two tokens.
 *
 * 3. Anything missing a player, a set or a year is capped below threshold and
 *    routed to review rather than scored. A fake bargain costs more than a
 *    missed one.
 */

const V = require('./vocab');

/* ---------- player index ---------- *
 *
 * Injected rather than read from disk, so this file stays pure and testable:
 * the parser tests hand it a small fixture index instead of loading 1.2MB.
 * providers.js is what actually reads it off disk.
 */

let INDEX = null;
function setPlayerIndex(idx) { INDEX = idx; }
function loadIndex() {
  if (!INDEX) {
    throw new Error('Player index not set. Call setPlayerIndex() before parsing.');
  }
  return INDEX;
}

/* ---------- hashing ---------- *
 *
 * FNV-1a, not a crypto hash. This is a cache key for "have I already parsed
 * this exact title", and a way to reduce a seller name to "same or different"
 * without storing it. Nothing adversarial depends on it.
 */
function hashTitle(s) {
  let h = 0x811c9dc5;
  const str = String(s);
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0') + str.length.toString(36);
}

/* ---------- normalisation ---------- */

function stripAccents(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// "2023-24 Prizm" and "2023/24 Prizm" both mean the 2023 product.
function collapseSeason(s) {
  return s.replace(/\b((?:19|20)\d{2})\s*[-/]\s*\d{2}\b/g, '$1');
}

function baseNorm(s) {
  return collapseSeason(stripAccents(String(s || '')))
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[.'`’"“”()\[\]{},!?:;*_+~^]/g, '')
    // Emoji and other seller decoration. Left in, they survive as residual
    // tokens and push clean listings over the high-residual blocker.
    .replace(/[^\x20-\x7e]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ---------- longest-phrase vocabulary matcher ---------- */

// Pre-split each vocab entry into tokens once, longest first, so multi-word
// entries always beat their own substrings.
function compile(list) {
  return list
    .map((phrase) => ({ phrase, toks: phrase.split(/\s+/) }))
    .sort((a, b) => b.toks.length - a.toks.length || b.phrase.length - a.phrase.length);
}
const C = {
  brands: compile(V.BRANDS),
  sets: compile(V.SETS),
  inserts: compile(V.INSERTS),
  parallels: compile(V.PARALLELS),
};

// Scan the token array for the first unconsumed run matching any phrase.
// Marks the matched span consumed so later matchers cannot reuse it.
function takePhrase(tokens, used, compiled) {
  for (const { phrase, toks } of compiled) {
    for (let i = 0; i + toks.length <= tokens.length; i++) {
      let hit = true;
      for (let j = 0; j < toks.length; j++) {
        if (used[i + j] || tokens[i + j] !== toks[j]) { hit = false; break; }
      }
      if (hit) {
        for (let j = 0; j < toks.length; j++) used[i + j] = true;
        return phrase;
      }
    }
  }
  return null;
}

// Same as above but collects every match, for parallels like "gold shimmer".
function takeAllPhrases(tokens, used, compiled, limit = 3) {
  const out = [];
  while (out.length < limit) {
    const hit = takePhrase(tokens, used, compiled);
    if (!hit) break;
    out.push(hit);
  }
  return out;
}

/* ---------- player matching ---------- */

// NFL league year rolls over in March.
const now = new Date();
const CURRENT_SEASON = now.getMonth() >= 2 ? now.getFullYear() : now.getFullYear() - 1;

// Autographs are overwhelmingly printed for skill positions.
const POS_PRIOR = { QB: 8, WR: 7, RB: 7, TE: 6, K: 2, DEF: 1 };

/**
 * Resolve a same-name collision using the card itself.
 *
 * The decisive signal is debut season: years_exp gives an implied debut of
 * CURRENT_SEASON - exp, and a rookie card's year should sit on top of it.
 * This is what separates the 2011 Topps Chrome A.J. Green (Bengals WR,
 * implied debut 2014, off by 3) from the current Dolphins A.J. Green
 * (cornerback, implied debut 2020, off by 9). Sorting by "has a team" alone
 * picks the cornerback and prices the wrong card.
 *
 * Retired players freeze at their final years_exp, so the implied debut
 * drifts late by however long they have been gone. Tolerance is wide enough
 * to absorb that and still separate players a draft class apart.
 */
function pickPlayer(bucket, ctx) {
  const scored = bucket.map((r) => {
    let s = 0;
    const exp = Number.isFinite(r.exp) ? r.exp : 0;
    const debut = CURRENT_SEASON - exp;

    if (ctx.year) {
      if (ctx.isRookie) {
        s += Math.max(0, 24 - Math.abs(ctx.year - debut) * 4);
      } else {
        const lo = debut - 1;
        const hi = debut + exp + 2;
        const dist = ctx.year < lo ? lo - ctx.year : ctx.year > hi ? ctx.year - hi : 0;
        s += Math.max(0, 12 - dist * 2);
      }
    }
    s += POS_PRIOR[r.pos] ?? 2;
    if (r.team) s += 4;
    return { rec: r, s };
  });

  scored.sort((a, b) => b.s - a.s || b.rec.seen - a.rec.seen);
  const top = scored[0];
  const gap = scored.length > 1 ? top.s - scored[1].s : Infinity;
  return { rec: top.rec, ambiguous: gap < 6, candidates: bucket.length };
}

// Longest n-gram wins, so "Marvin Harrison Jr" beats "Marvin Harrison".
function takePlayer(tokens, used, ctx) {
  const idx = loadIndex().byName;
  for (let n = 4; n >= 2; n--) {
    for (let i = 0; i + n <= tokens.length; i++) {
      let free = true;
      for (let j = 0; j < n; j++) if (used[i + j]) { free = false; break; }
      if (!free) continue;
      const key = tokens.slice(i, i + n).join(' ');
      const bucket = idx[key];
      if (!bucket || !bucket.length) continue;

      for (let j = 0; j < n; j++) used[i + j] = true;
      // Swallow a trailing suffix so "iii" does not survive into the residual
      // and trip the high-residual blocker.
      let suffix = null;
      if (i + n < tokens.length && V.SUFFIXES.has(tokens[i + n]) && !used[i + n]) {
        suffix = tokens[i + n];
        used[i + n] = true;
      }

      const { rec, ambiguous, candidates } = pickPlayer(bucket, ctx);
      // Roman numerals go uppercase, Jr/Sr title case. "Mahomes Ii" is wrong.
      const suf = suffix
        ? (/^(ii|iii|iv|v)$/.test(suffix)
            ? suffix.toUpperCase()
            : suffix[0].toUpperCase() + suffix.slice(1) + '.')
        : null;
      return {
        player: rec.name + (suf ? ` ${suf}` : ''),
        playerId: rec.id, pos: rec.pos, team: rec.team, age: rec.age, exp: rec.exp,
        debut: CURRENT_SEASON - (rec.exp ?? 0),
        // Dynasty standing, carried through so the scorer can weight by what
        // the market pays for the player rather than just his age.
        dynRank: rec.dynRank ?? null, dynPosRank: rec.dynPosRank ?? null,
        dynValue: rec.dynValue ?? null, dynTrend30: rec.dynTrend30 ?? null,
        ambiguous, candidates,
      };
    }
  }
  return null;
}

/* ---------- main ---------- */

function parseTitle(rawTitle) {
  const hash = hashTitle(rawTitle);
  const out = {
    title: rawTitle, hash, ok: false, reject: null,
    year: null, brand: null, set: null, insert: null, parallel: null,
    player: null, playerId: null, pos: null, team: null, age: null, exp: null,
    debut: null, isRookie: false, ambiguousPlayer: false, candidates: 0,
    dynRank: null, dynPosRank: null, dynValue: null, dynTrend30: null,
    grade: null,
    cardNo: null, serial: null, cert: null,
    confidence: 0, blockers: [], warnings: [], residual: [], matchKey: null,
  };

  const raw = String(rawTitle || '');

  /* gates, cheapest first */
  for (const j of V.JUNK) {
    if (j.test(raw)) { out.reject = `junk:${j.source.slice(0, 24)}`; return out; }
  }
  // Order matters: NOT_AUTO must run first, see the note in vocab.js.
  if (V.NOT_AUTO.test(raw)) { out.reject = 'auto-explicitly-denied'; return out; }
  if (!V.AUTO.test(raw)) { out.reject = 'no-auto-claim'; return out; }
  // Grade gate. PSA 10 always welcome, PSA 9 allowed through here and judged
  // much harder later. A 9.5 is not a PSA grade and is rejected outright.
  if (V.PSA10.test(raw)) out.grade = 10;
  else if (V.PSA9.test(raw) && !V.HALF_GRADE.test(raw)) out.grade = 9;
  else {
    out.reject = V.OTHER_GRADER.test(raw) ? 'other-grader' : 'no-psa-grade-claim';
    return out;
  }

  let s = baseNorm(raw);

  /* structured fields, pulled before hyphens are flattened */

  // PSA certs are 8-9 digits. Remove so they cannot be read as a card number.
  const certM = s.match(/\b(\d{8,9})\b/);
  if (certM) { out.cert = certM[1]; s = s.replace(certM[0], ' '); }

  // Serial numbering: 25/99, /99, 1/1. Denominator caps at 9999.
  const serM = s.match(/(?:^|\s)#?\s*(\d{1,4})?\s*\/\s*(\d{1,4})\b/);
  if (serM && Number(serM[2]) <= 9999) {
    out.serial = { num: serM[1] ? Number(serM[1]) : null, of: Number(serM[2]) };
    s = s.replace(serM[0], ' ');
  }

  // Card number: #201, #RPS-JJ, no 45, card 45.
  const cardM =
    s.match(/#\s*([a-z]{1,4}[a-z0-9]*(?:-[a-z0-9]+)*|\d{1,4})\b/) ||
    s.match(/\b(?:card|no)\s*#?\s*([a-z]{0,4}-?\d{1,4})\b/);
  if (cardM) { out.cardNo = cardM[1].toUpperCase(); s = s.replace(cardM[0], ' '); }

  // Year. Take the earliest plausible card year present.
  const years = [...s.matchAll(/\b(19[5-9]\d|20[0-4]\d)\b/g)].map((m) => Number(m[1]));
  if (years.length) {
    out.year = Math.min(...years);
    s = s.replace(new RegExp(`\\b${out.year}\\b`, 'g'), ' ');
  }

  // Grade phrasing has done its job at the gate. Drop it so "10" and "gem"
  // cannot be mistaken for a card number or a parallel.
  s = s.replace(/\bpsa\s*(10|9)\b|\bgem\s*(mt|mint)\s*10\b|\bmint\s*9\b|\bgem\s*(mt|mint)\b|\bpsa\b|\bgraded\b|\bslab(bed)?\b|\bpop\s*\d+\b/g, ' ');

  /* token stage */
  const tokens = s.replace(/-/g, ' ').replace(/[#/]/g, ' ').split(/\s+/).filter(Boolean);
  const used = new Array(tokens.length).fill(false);

  // Player first. See design note 1.
  out.isRookie = V.ROOKIE_HINT.test(raw);
  const p = takePlayer(tokens, used, { year: out.year, isRookie: out.isRookie });
  if (p) {
    out.player = p.player; out.playerId = p.playerId; out.pos = p.pos;
    out.team = p.team; out.age = p.age; out.exp = p.exp; out.debut = p.debut;
    out.dynRank = p.dynRank; out.dynPosRank = p.dynPosRank;
    out.dynValue = p.dynValue; out.dynTrend30 = p.dynTrend30;
    out.ambiguousPlayer = p.ambiguous; out.candidates = p.candidates;
  }

  // Inserts can stack ("Rated Rookie" + "Rookie Signatures"), so collect
  // rather than taking the single longest and orphaning the rest.
  const ins = takeAllPhrases(tokens, used, C.inserts, 2);
  out.insert = ins.length ? ins.sort().join(' + ') : null;

  out.set = takePhrase(tokens, used, C.sets);
  out.brand = takePhrase(tokens, used, C.brands);

  // Sorted so "Green Prizm" and "Prizm Green" produce one cache key, not two.
  const par = takeAllPhrases(tokens, used, C.parallels, 3);
  out.parallel = par.length ? par.sort().join(' ') : null;

  out.residual = tokens.filter(
    (t, i) => !used[i] && t.length > 1 && !V.STOPWORDS.has(t) && !/^\d+$/.test(t)
      // Seller SKU codes. Real titles end with things like "Auto 8d2",
      // "PSA 10 ez6", "Auto 0y2q". Short mixed letter-and-digit tokens are
      // inventory references, not card attributes, and they were tripping
      // the high-residual blocker on otherwise clean listings. Card numbers
      // are pulled off the string well before this point, so nothing real
      // is at risk here.
      && !(t.length <= 4 && /[a-z]/.test(t) && /\d/.test(t))
  );

  /* confidence */
  // The three critical fields sum to 74, deliberately above the 70 threshold:
  // year + set + player is enough to identify a base rookie auto, which is a
  // large and legitimate slice of the market with nothing else in the title.
  const weights = [
    ['player', out.player, 32],
    ['set', out.set, 24],
    ['year', out.year, 18],
    ['insert', out.insert, 10],
    ['parallel', out.parallel, 8],
    ['cardNo', out.cardNo, 8],
    ['serial', out.serial, 6],
  ];
  let conf = weights.reduce((a, [, v, w]) => a + (v ? w : 0), 0);

  // Critical fields. Without these the comp lookup is a guess, so these are
  // hard caps rather than deductions.
  for (const [name, v] of [['player', out.player], ['set', out.set], ['year', out.year]]) {
    if (!v) out.blockers.push(`missing-${name}`);
  }
  // Leftover meaningful tokens mean the parser did not understand the title.
  if (out.residual.length >= 3) out.blockers.push('high-residual');

  if (out.blockers.length) conf = Math.min(conf, 45);

  // A same-name collision the tiebreaker could not settle is a soft penalty,
  // not a cap. It usually still resolves correctly, it just should not clear
  // threshold on its own without the other fields agreeing.
  if (out.ambiguousPlayer) { conf -= 25; out.warnings.push('ambiguous-player'); }
  // No parallel named almost always means base, but base and a colour can be
  // an order of magnitude apart in price, so say so out loud.
  if (!out.parallel) out.warnings.push('assumed-base-parallel');
  out.confidence = Math.max(0, Math.min(100, conf));
  out.ok = out.confidence >= 70;

  out.matchKey = [
    out.year || '?', out.brand || '', out.set || '?', out.insert || '',
    out.parallel || 'base', out.player || '?', out.cardNo || '',
    out.serial ? `of${out.serial.of}` : '',
  ].join('|');

  return out;
}

module.exports = { parseTitle, baseNorm, setPlayerIndex, hashTitle, CURRENT_SEASON };
