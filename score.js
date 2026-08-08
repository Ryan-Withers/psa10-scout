/**
 * The money maths.
 *
 *   landed_cost_aud = price + shipping in AUD, plus import GST and eBay's
 *                     import charge when the seller sits outside Australia
 *   edge            = (comp_aud - landed_cost_aud) / comp_aud
 *   score           = edge * liquidity * youth * seller_trust
 *
 * Every cost assumption lives in config.js with a note on how confident it
 * is. The import charge is the shakiest and it moves the answer, so the
 * breakdown is kept on every row rather than collapsed into a single number.
 */

const CFG = require('./config');
const compare = require('./compare');

/* ---------- landed cost ---------- */

function landedCost(listing, fx) {
  const L = CFG.landed;
  const rate = listing.currency === 'AUD' ? 1 : fx.usdToAud;
  const domestic = listing.country === 'AU';

  const priceAud = listing.price * rate;

  // Unknown shipping is estimated, never assumed to be zero. Treating it as
  // free is how a mediocre listing gets promoted to the top of the table.
  const shippingAud = listing.shippingUnknown
    ? (domestic ? L.estShippingDomesticAud : L.estShippingFromUsAud)
    : listing.shipping * rate;

  const goods = priceAud + shippingAud;
  const b = { priceAud, shippingAud, goodsAud: goods, gstAud: 0, ebayImportAud: 0, dutyAud: 0, customsAud: 0 };

  if (!domestic) {
    b.gstAud = goods * L.gstRate;
    b.ebayImportAud = goods * L.ebayImportFeeRate;
    b.dutyAud = goods * L.dutyRate;
    if (goods > L.lowValueThresholdAud) b.customsAud = L.customsProcessingAud;
  }

  b.totalAud = b.goodsAud + b.gstAud + b.ebayImportAud + b.dutyAud + b.customsAud;
  b.shippingEstimated = !!listing.shippingUnknown;
  b.domestic = domestic;
  return b;
}

/* ---------- gates and multipliers ---------- */

// Below the floor the comp is one person's anecdote. Between floor and
// comfort it ramps, because a hard cliff makes the whole ranking twitch
// every time a card records one extra sale.
function liquidity(volume, source = 'you') {
  // Two different units. A paid feed would give yearly sales; the observed
  // market gives distinct copies seen listed. Same idea, different scale,
  // so they get different thresholds.
  const [floor, comfort] = source === 'market'
    ? [CFG.market.liquidityFloorListings, CFG.market.liquidityComfortListings]
    : [CFG.gates.liquidityFloorSales, CFG.gates.liquidityComfortSales];
  const v = Number(volume || 0);
  if (v < floor) return 0;
  if (v >= comfort) return 1;
  return (v - floor) / (comfort - floor);
}

/**
 * How much we want this player, regardless of the card.
 *
 * Dynasty rank does the heavy lifting because it is a live market price for
 * the player himself, and card prices follow it. Experience and 30-day trend
 * adjust around that. The peak of this function is deliberately Ryan's stated
 * target: a second or third year player inside the dynasty top 24 whose value
 * is climbing.
 */
function youth(exp, age, dyn = {}) {
  const y = CFG.youth;
  const rank = dyn.dynRank ?? null;

  let m = rank == null
    ? y.unrankedMult
    : (y.byDynastyRank.find((b) => rank <= b.maxRank)?.mult ?? 1);

  const trend = dyn.dynTrend30 ?? 0;
  if (trend >= y.trendRisingAbove) m *= y.trendRisingMult;
  else if (trend <= y.trendFallingBelow) m *= y.trendFallingMult;

  m *= y.byExp.find((b) => (exp ?? 99) <= b.maxExp)?.mult ?? 1;

  return Math.round(m * 1000) / 1000;
}

/**
 * Your read on a player. Deliberately separate from the youth multiplier:
 * youth is driven off age and experience, this is driven off you. Kept as
 * its own factor so a row can show why it ranked where it did.
 */
let CONVICTION = new Map();
function setConviction(rows = []) {
  CONVICTION = new Map(
    rows.filter((r) => r.player)
      .map((r) => [normPlayer(r.player), {
        mult: Number(r.conviction) || 1,
        note: r.note || '',
        // Whether to email every listing of this man regardless of the call.
        // Kept apart from the multiplier on purpose: liking a player and
        // wanting to be interrupted about him are different questions.
        alwaysAlert: r.alwaysAlert === true,
      }])
  );
}
const normPlayer = (s) => String(s || '').toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[.'`]/g, '').replace(/\s+(jr|sr|ii|iii|iv|v)$/i, '')
  .replace(/[^a-z0-9]+/g, ' ').trim();

function conviction(player) {
  return CONVICTION.get(normPlayer(player)) || { mult: 1, note: '', alwaysAlert: false };
}

function sellerTrust(feedbackPct, feedbackScore) {
  const t = CFG.sellerTrust;
  const pct = feedbackPct == null ? 97 : Number(feedbackPct);
  let m = t.bands.find((b) => pct >= b.minPct)?.mult ?? 0.6;
  const n = Number(feedbackScore ?? 0);
  if (n < t.veryNewAccountScore) m *= t.veryNewAccountMult;
  else if (n < t.newAccountScore) m *= t.newAccountMult;
  return m;
}

/* ---------- one listing ---------- */

function scoreListing(listing, parsed, match, fx, comparePools = null) {
  const out = {
    itemId: listing.itemId, title: listing.title, url: listing.url,
    bestOffer: !!listing.bestOffer, country: listing.country,
    // Seller username deliberately not carried through. It is used to compute
    // seller trust and then dropped, so nothing eBay would consider user data
    // reaches ranked.json, the price history or the alert email. You can see
    // who the seller is on the listing itself, one click away.
    feedbackPct: listing.feedbackPct,
    image: listing.image || null,
    grade: parsed.grade || 10,
    player: parsed.player, year: parsed.year, set: parsed.set,
    insert: parsed.insert, parallel: parsed.parallel,
    // Carried through so the alert can say "2nd year WR" instead of a score.
    pos: parsed.pos, exp: parsed.exp, age: parsed.age,
    dynRank: parsed.dynRank, dynTrend30: parsed.dynTrend30,
    parseConfidence: parsed.confidence, matchConfidence: match.matchConfidence,
    warnings: [...(parsed.warnings || [])],
    dropped: null,
    // Set here rather than in one of the branches below, because both feed
    // alerting and scoreListing has five different exits. A card that cannot
    // be valued still has an asking price and can still be one of your men.
    alwaysAlert: conviction(parsed.player).alwaysAlert,
    askUsd: round2(listing.currency === 'AUD'
      ? listing.price / (fx.usdToAud || 1)
      : listing.price),
  };

  // Failed the gates. Not a card, or not readable. Genuinely thrown away.
  if (parsed.confidence < CFG.gates.minParseConfidence) {
    out.dropped = `parse-confidence-${parsed.confidence}`;
    return out;
  }

  // College and draft-prospect cards. If the card predates the player's NFL
  // debut it is not an NFL card, whatever the set is called.
  if (CFG.nfl.excludeCollege && parsed.year && parsed.debut != null
      && (!CFG.nfl.onlyWhenRostered || parsed.team)
      && parsed.year < parsed.debut - CFG.nfl.graceYears) {
    out.dropped = `college-card-${parsed.year}-vs-debut-${parsed.debut}`;
    return out;
  }

  const cost = landedCost(listing, fx);
  out.landedAud = round2(cost.totalAud);
  out.cost = cost;

  // Fall back to comparable cards when there is no exact-card value. This is
  // what lets nearly every listing carry an opinion on day one instead of
  // waiting weeks for the same card to be listed six times.
  if ((!match.comp || match.matchConfidence < CFG.gates.minMatchConfidence) && comparePools) {
    const est = compare.estimate(parsed, comparePools);
    if (est.estAud > 0) {
      out.valueSource = 'comparable';
      out.valueBasis = est.basis;
      out.valueN = est.n;
      out.valueConfidence = est.confidence;
      out.serialOf = parsed.serial?.of ?? null;
      out.compAud = round2(est.estAud);
      out.edge = round4((est.estAud - cost.totalAud) / est.estAud);
      out.liquidity = 1;               // pool size already stands in for this
      out.youth = round2(youth(parsed.exp, parsed.age, parsed));
      out.sellerTrust = round2(sellerTrust(listing.feedbackPct, listing.feedbackScore));
      out.valueTrust = est.confidence >= 3 ? 0.85 : 0.7;  // an estimate, not a comp
      const cv = conviction(parsed.player);
      out.conviction = cv.mult;
      out.score = round4(out.edge * out.youth * out.sellerTrust * out.valueTrust * cv.mult);
      if (out.edge > 0.55) out.warnings.push('implausible-edge-verify-match');
      if (cost.shippingEstimated) out.warnings.push('shipping-estimated');
      return out;
    }
    // Genuinely unpriceable, a one-of-one or nothing alike in the scan.
    out.valueBasis = est.basis;
  }

  // Read fine, but no idea what it is worth. This is a shortlist tool, so
  // these go to a "worth a look" pile rather than the bin. Judging them is
  // Ryan's job, surfacing them is this tool's.
  if (!match.comp || match.matchConfidence < CFG.gates.minMatchConfidence) {
    out.unpriced = match.comp ? `match-confidence-${match.matchConfidence}` : (match.reason || 'no-value-on-file');
    out.youth = round2(youth(parsed.exp, parsed.age, parsed));
    out.sellerTrust = round2(sellerTrust(listing.feedbackPct, listing.feedbackScore));
    out.conviction = conviction(parsed.player).mult;
    out.age = parsed.age;
    out.exp = parsed.exp;
    // No value to compute an edge from, so this is just "how much do we
    // like the player and the seller, and how cheap is it". Enough to sort
    // the worth-a-look pile so the interesting ones float up.
    out.interest = round4((out.youth * out.sellerTrust * out.conviction) / Math.max(1, out.landedAud / 100));
    return out;
  }

  const comp = match.comp;
  out.compId = comp.id;
  out.valueSource = comp.valueSource || 'you';
  out.salesVolumeYear = comp.salesVolumeYear;
  out.valueConfidence = 3;
  out.serialOf = parsed.serial?.of ?? null;
  out.observations = comp.observations ?? null;
  out.medianAskAud = comp.medianAskAud ?? null;
  out.basis = comp.basis ?? null;
  out.clearedCount = comp.clearedCount ?? null;
  out.stillListedCount = comp.stillListedCount ?? null;

  // Hand-entered values carry no volume signal and do not need one. Values
  // inferred from the market are gated on how many copies we have seen.
  const liq = comp.salesVolumeYear == null ? 1 : liquidity(comp.salesVolumeYear, out.valueSource);
  if (liq === 0) {
    out.unpriced = out.valueSource === 'market'
      ? `only-${comp.salesVolumeYear}-copies-seen`
      : `thin-volume-${comp.salesVolumeYear}-per-year`;
    out.youth = round2(youth(parsed.exp, parsed.age, parsed));
    out.sellerTrust = round2(sellerTrust(listing.feedbackPct, listing.feedbackScore));
    return out;
  }
  const compAud = (comp.psa10UsdCents / 100) * fx.usdToAud;

  out.compAud = round2(compAud);
  out.edge = round4((compAud - cost.totalAud) / compAud);

  out.liquidity = round2(liq);
  out.youth = round2(youth(parsed.exp, parsed.age, parsed));
  out.sellerTrust = round2(sellerTrust(listing.feedbackPct, listing.feedbackScore));
  // A value you wrote down outranks one guessed from other people's asking
  // prices, at the same edge.
  out.valueTrust = CFG.market.valueTrust[out.valueSource] ?? 0.75;
  const conv = conviction(parsed.player);
  out.conviction = conv.mult;
  if (conv.mult !== 1) out.convictionNote = conv.note;
  out.score = round4(out.edge * out.liquidity * out.youth * out.sellerTrust * out.valueTrust * conv.mult);

  // An edge this large is far more likely to be a bad match than a bargain.
  // Surfaced rather than suppressed, because when it is real it is the best
  // row in the table, and when it is not it tells you the matcher is broken.
  if (out.edge > 0.60) out.warnings.push('implausible-edge-verify-match');
  if (cost.shippingEstimated) out.warnings.push('shipping-estimated');
  if (out.bestOffer) out.warnings.push('best-offer-real-price-may-be-lower');

  return out;
}

const round2 = (n) => Math.round(n * 100) / 100;
const round4 = (n) => Math.round(n * 10000) / 10000;

module.exports = { scoreListing, landedCost, liquidity, youth, sellerTrust, setConviction, conviction };
