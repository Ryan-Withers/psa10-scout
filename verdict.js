/**
 * The per-card take.
 *
 * Ryan's brief: treat every line like a quick second opinion, give an actual
 * call, and shout when something is either outstanding value or a boom
 * rookie. A score of 0.374 is not a second opinion. "Third year RB, dynasty
 * top 100 and climbing, 24% under what these go for, seller takes offers" is.
 *
 * Deliberately rules-based rather than a language model call. It runs over a
 * thousand-odd listings every 20 minutes, for free, offline, in milliseconds.
 * Everything it says is traceable to a number on the row, so a claim can
 * always be checked.
 */

const CFG = require('./config');

const money = (n) => '$' + Math.round(Number(n));
const pct = (n) => Math.round(Math.abs(n) * 100) + '%';

/* ---------- the profile checks ---------- */

// Ryan's stated target: early career, well rated, moving up.
function isBoomRookie(r) {
  return (r.exp ?? 99) <= 2
    && r.dynRank != null && r.dynRank <= 60
    && (r.dynTrend30 ?? 0) >= 0;
}

function isTarget(r) {
  return (r.conviction ?? 1) > 1;
}

/* ---------- why a card earns an email ---------- */

/**
 * A named target, flagged alwaysAlert in data/my-players.json. Ryan asked to
 * hear about these whatever the tool thinks, so this reason ignores the call,
 * the edge and whether the card could be valued at all.
 */
/**
 * A man on the watchlist, on a card Ryan would actually consider.
 *
 * The brief is "all notifications are PSA 10 autos of those players only", so
 * this carries the grade and price tests rather than leaving them to a
 * separate rule. The autograph half is structural: parse.js rejects any title
 * that does not claim one, so nothing without an auto reaches here at all.
 *
 * Everything else about the card is deliberately not tested. Whether it is
 * cheap, whether it can be valued, whether the tool likes the set: none of
 * that decides whether Ryan hears about it. He asked to be told when one
 * appears.
 */
function isAlwaysAlert(r) {
  if (CFG.alert.reasons.targetAnyCall !== true || r.alwaysAlert !== true) return false;
  const t = CFG.alert.reasons.target;
  if ((r.grade ?? 10) !== t.grade) return false;
  if (!(r.askUsd > 0) || r.askUsd > t.maxAskUsd) return false;
  return true;
}

/**
 * One of Ryan's men, for the purpose of what the email SAYS.
 *
 * my-players.json offers two independent switches and its own note calls them
 * deliberately separate: conviction is how much he rates a player, alwaysAlert
 * is whether he wants his phone to buzz. Setting alwaysAlert with conviction
 * left at 1.0 is therefore an invited configuration, and it used to produce a
 * card that earned the TARGET reason, arrived in the targets section, and then
 * carried no TARGET tag and no "one of yours" line, so the email never said
 * why it was there.
 *
 * Copy and tagging use this. The scoring multipliers deliberately still use
 * isTarget, because how much a card is worth having is a question about
 * conviction, not about notifications.
 */
function isNamed(r) {
  return isTarget(r) || isAlwaysAlert(r);
}

/**
 * The shape Ryan is hunting, judged on the card rather than on the market:
 * a first or second year man, PSA 10, asking under the ceiling.
 *
 * No discount test and no rank test, on purpose. "Is this the kind of card I
 * want at this price" is a different question from "is this cheap against its
 * comps", and answering it separately is what lets a card the tool cannot
 * value still reach the email. maxDynRank in config is the brake if this
 * turns out to be too loud.
 */
function fitsProfile(r) {
  const p = CFG.alert.reasons.profile;
  if (!p.enabled) return false;
  if ((r.grade ?? 10) !== p.grade) return false;
  if (!(r.askUsd > 0) || r.askUsd > p.maxAskUsd) return false;

  /**
   * "First or second year" cannot be read off experience alone.
   *
   * Sleeper reports years_exp 0 for a man who never played a down, and it
   * freezes at retirement rather than counting up. The index holds Kurt Warner
   * at age 47 exp 0 and Mike Vrabel at 44 exp 0, alongside 2,775 entries at
   * exp 0 or 1 in total. Age does not save it either, because plenty of the
   * never-played are in their twenties.
   *
   * isBoomRookie never had this problem because it also demands a dynasty rank
   * inside the top 60, which no retired player carries. This rule was written
   * without a rank test on purpose, so it needs its own proof of life: on a
   * current roster, and rated by the dynasty market at all.
   */
  if ((r.exp ?? 99) > p.maxExp) return false;
  if (p.requireRostered && !r.team) return false;
  if (p.requireRanked && r.dynRank == null) return false;
  if (p.maxDynRank != null && !(r.dynRank != null && r.dynRank <= p.maxDynRank)) return false;
  return true;
}

/**
 * Every reason this card is in the email, strongest first. Empty means it has
 * not earned one. notify.js and alert.js both read this, so the bar lives in
 * one place instead of being restated as a threshold in each.
 */
function alertReasons(r, { call, shout }) {
  const out = [];
  if (isAlwaysAlert(r)) out.push('TARGET');
  if (CFG.alert.reasons.deal.enabled && (shout || call === 'BUY')) out.push('DEAL');
  if (fitsProfile(r)) out.push('PROFILE');
  return out;
}

/**
 * A listing of one of your men that the parser could not read well enough to
 * price, but read well enough to be sure who is on it.
 *
 * Dropped rows never get a verdict, so "tell me about these every time" quietly
 * stopped at the parse gate. That gate fires on titles the tool understood only
 * partly: player and year resolved, set missing, so confidence is capped at 45.
 * A genuine Burden auto with an unusual set name lands there and is binned.
 *
 * Only the confidence gate qualifies. The other gates are correctness gates,
 * and their answers are right: a lot, a break, a raw card and a card whose
 * title denies an autograph are all genuinely not what Ryan asked for. A
 * college card is excluded by his own brief.
 *
 * The player still has to be trustworthy. parse.js resolves the player against
 * the Sleeper index independently of the overall score, and flags a collision
 * it could not settle with ambiguous-player. Without that warning, a low score
 * means "I could not read the card", not "I could not read the name".
 *
 * Returns a verdict carrying no call and no price, because there is neither.
 */
function unreadTarget(r) {
  if (!isAlwaysAlert(r)) return null;
  if (!/^parse-confidence/.test(String(r.dropped || ''))) return null;
  if (!r.player || (r.warnings || []).includes('ambiguous-player')) return null;
  return {
    call: 'UNREAD',
    tags: ['TARGET'],
    hook: 'One of your guys, but the title beat the parser',
    headline: `${r.player} - could not read the card`,
    take: 'One of your men by name, but the title did not give up enough to price it. Worth ten seconds of your own eyes.',
    shout: false,
    unread: true,
    reasons: ['TARGET'],
  };
}

// A discount this size on a card we can price is either the find of the week
// or, far more often, a bad comparison. Both are worth saying out loud.
function isSuspicious(r) {
  return r.edge != null && r.edge > 0.55;
}

/* ---------- the call ---------- */

/**
 * Is this a player worth owning at all?
 *
 * The first cut of this function ignored the question and 78 of its 104 top
 * calls were unranked players. Cheap, yes. But a card nobody is chasing being
 * cheap is not an opportunity, it is just the price. Discount alone cannot
 * earn a strong call.
 */
function playerQuality(r) {
  if (isTarget(r)) return 3;               // you named him
  if (isBoomRookie(r)) return 3;           // early career, well rated, not falling
  if (r.dynRank == null) return 0;         // outside the dynasty top 475
  if (r.dynRank <= 120) return 2;
  if (r.dynRank <= 250) return 1;
  return 0.5;
}

/**
 * Seven levels. Two things gate the call together: how big the discount is,
 * and whether the player is worth having. A big discount on a nobody tops out
 * at WATCH. The bar also moves with how much the valuation can be trusted, so
 * a number scraped from "same rarity, any set" cannot produce a confident buy.
 */
/**
 * A PSA 9 has to earn its place. It is a different asset from a 10, it is
 * priced against other 9s, and most of the time it is not what Ryan is
 * hunting. Two ways through: the player is elite and early career, or the
 * discount is large enough that the grade stops mattering.
 */
function nineEarnsItsPlace(r) {
  if ((r.grade ?? 10) !== 9) return true;
  const elite = (r.exp ?? 99) <= 3 && r.dynRank != null && r.dynRank <= 60;
  const insane = (r.edge ?? 0) >= 0.45;
  return elite || insane || isTarget(r);
}

function decide(r) {
  const e = r.edge;
  const conf = r.valueConfidence ?? 0;   // 3 tight, 1 loose, 0 none
  const q = playerQuality(r);

  if (!nineEarnsItsPlace(r)) return 'SKIP';
  if (e == null) return q >= 3 ? 'WATCH' : 'SKIP';
  if (isSuspicious(r)) return 'CHECK';

  const strongBar = conf >= 3 ? 0.30 : 0.40;
  const buyBar = conf >= 3 ? 0.15 : 0.25;

  // Player has to be worth owning before price makes it a strong call.
  if (e >= strongBar && q >= 2 && conf >= 2) return 'STRONG BUY';
  if (e >= buyBar && q >= 1) return 'BUY';
  if (e >= buyBar && q < 1) return 'WATCH';   // cheap, but nobody wants him
  if (e >= 0.05 && q >= 1) return 'WATCH';
  if (e >= -0.15) return 'FAIR';
  return 'PASS';
}

/* ---------- the write-up ---------- */

const ORDINAL = ['rookie', '2nd year', '3rd year', '4th year', '5th year',
  '6th year', '7th year', '8th year', '9th year'];

function playerLine(r) {
  const exp = r.exp ?? null;
  const pos = r.pos || 'player';
  const yr = exp === 0 ? 'rookie' : (exp != null && exp < ORDINAL.length) ? ORDINAL[exp]
    : (exp != null && exp >= 10) ? 'veteran' : '';
  const bits = [yr, pos].filter(Boolean).join(' ');
  if (r.dynRank == null) return `${bits}, not currently rated in dynasty`;
  const t = r.dynTrend30 ?? 0;
  const dir = t >= 150 ? ', climbing hard' : t >= 50 ? ' and climbing'
    : t <= -150 ? ', sliding hard' : t <= -50 ? ' and sliding' : '';
  return `${bits}, dynasty #${r.dynRank}${dir}`;
}

function cardLine(r) {
  const setWords = new Set(String(r.set || '').toLowerCase().split(/\s+/));
  const par = String(r.parallel || '').split(/\s+/)
    .filter((w) => w && !setWords.has(w.toLowerCase())).join(' ');
  const tc = (s) => String(s || '').replace(/\b[a-z]/g, (c) => c.toUpperCase());
  const ser = r.serialOf ? ` /${r.serialOf}` : '';
  return `${r.year} ${tc(r.set)}${par ? ' ' + tc(par) : ''}${ser} auto`;
}

/**
 * Two or three sentences. What it is, what it costs against what these go
 * for, and the one thing that most changes the decision.
 */
function reasoning(r) {
  const out = [];

  out.push(`${r.player}, ${playerLine(r)}.`);

  if (r.edge != null && r.compAud) {
    const dir = r.edge >= 0 ? 'under' : 'over';
    out.push(`${cardLine(r)} at ${money(r.landedAud)} landed, ${pct(r.edge)} ${dir} the ${money(r.compAud)} comparable cards are going for.`);
  } else {
    out.push(`${cardLine(r)} at ${money(r.landedAud)} landed. Nothing comparable to price it against.`);
  }

  // The single most decision-relevant caveat, not a list of every flag.
  if (isSuspicious(r)) {
    out.push('A gap that big is usually a mismatched comparison rather than a find. Check the card before acting.');
  } else if (r.valueBasis === 'one-of-one') {
    out.push('One of one, so there is no comparable and no way to value it from data. Your call entirely.');
  } else if (r.valueConfidence === 1) {
    out.push(`Thin evidence though, priced off ${r.valueN} cards of similar rarity from other sets.`);
  } else if (isNamed(r)) {
    out.push('One of your named targets.');
  } else if (isBoomRookie(r) && r.edge != null && r.edge >= 0.15) {
    out.push('Early career, well rated and not falling, which is the profile you are hunting.');
  } else if (r.dynRank == null && r.edge != null && r.edge >= 0.2) {
    out.push('Cheap, but nobody is rating this player in dynasty right now, so cheap may simply be the price.');
  } else if (r.bestOffer && r.edge != null && r.edge > 0) {
    out.push('Seller takes offers, so there may be more in it.');
  }

  return out.join(' ');
}

/* ---------- public ---------- */

/**
 * One line, six words or so, that says why this is on screen. This is what
 * gets read; the paragraph underneath is for when it lands.
 */
function hook(r) {
  // Every line below this point claimed the card was cheap, which was safe
  // while only BUYs and better were emailed. Named targets and profile cards
  // now arrive at any call, so a card at or above the going rate reaches this
  // function and has to be described honestly. Telling Ryan a card is cheap
  // when it is 9% over the market is how he stops believing the other lines.
  const priced = r.edge != null && Number.isFinite(r.edge) && r.compAud > 0;
  if (priced && r.edge < 0.10) {
    if (r.edge < -0.02) return isNamed(r) ? 'One of your guys, but you are paying up' : 'Above what comparable cards ask';
    if (r.edge < 0.02) return isNamed(r) ? 'One of your guys, at about the going rate' : 'About what these go for';
    return isNamed(r) ? 'One of your guys, a little under the going rate' : 'A little under what these go for';
  }
  if (!priced) {
    if (isNamed(r)) return 'One of your guys, and nothing to price it against';
    return 'Nothing comparable in this scan to price it against';
  }

  if (isNamed(r)) return 'One of your guys, and it is cheap';
  if (isSuspicious(r)) return 'Looks too good, worth eyeballing';
  const t = r.dynTrend30 ?? 0;
  if (isBoomRookie(r) && t >= 150) return 'Young, top-60, and the market is moving to him';
  if (isBoomRookie(r)) return 'Exactly the profile you are hunting';
  if (r.dynRank != null && r.dynRank <= 24) return 'Top-24 dynasty asset, well under the going rate';
  if ((r.edge ?? 0) >= 0.45) return 'Priced miles below anything comparable';
  if (t >= 150) return 'Market is moving toward him right now';
  if ((r.grade ?? 10) === 9) return 'A nine, but the discount makes up for it';
  return 'Solidly under what these go for';
}

function evaluate(r) {
  const call = decide(r);
  const tags = [];
  if (isNamed(r)) tags.push('TARGET');
  if (isBoomRookie(r)) tags.push('BOOM ROOKIE');
  if ((r.grade ?? 10) === 9) tags.push('PSA 9');
  if (r.bestOffer) tags.push('OFFERS');
  if (r.country && r.country !== 'AU') tags.push('IMPORT');

  // Shout-worthy: the two things Ryan asked to be told about.
  const shout = call === 'STRONG BUY' || (isNamed(r) && ['BUY', 'STRONG BUY'].includes(call));
  const reasons = alertReasons(r, { call, shout });
  if (reasons.includes('PROFILE') && !tags.includes('BOOM ROOKIE')) tags.push('PROFILE');

  return {
    call,
    tags,
    hook: hook(r),
    headline: `${r.player} ${cardLine(r)} - ${call}`,
    take: reasoning(r),
    shout,
    // Why this card is in the email, strongest reason first. Empty means it
    // is not. Read by notify.js and alert.js so the bar is defined once.
    reasons,
  };
}

const RANK = { 'STRONG BUY': 0, 'BUY': 1, 'CHECK': 2, 'WATCH': 3, 'FAIR': 4, 'PASS': 5, 'SKIP': 6 };
const byCall = (a, b) => (RANK[a.verdict?.call] ?? 9) - (RANK[b.verdict?.call] ?? 9) || (b.score ?? 0) - (a.score ?? 0);

module.exports = {
  evaluate, decide, isBoomRookie, isTarget, byCall, RANK,
  isAlwaysAlert, isNamed, fitsProfile, alertReasons, unreadTarget,
};
