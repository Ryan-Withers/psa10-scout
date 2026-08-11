/**
 * Live eBay Browse provider. Uses fetch and nothing else, so there is no
 * dependency to install, audit or keep up to date.
 *
 * This is ebay-scan.js rebuilt with the four problems fixed:
 *
 * 1. Aspect filters alone lose listings. "Professional Grader", "Grade" and
 *    "Autographed" are filled in by the seller, and the sloppy sellers who
 *    leave them blank are exactly the ones underpricing cards. So we run an
 *    aspect-filtered pass AND several keyword passes, dedupe on itemId, and
 *    let the title parser do the real gating.
 *
 * 2. Category discovery trusted the first suggestion. Now the ancestor path
 *    is checked for a trading-card node before the id is used.
 *
 * 3. Absent shipping was scored as free. Now flagged as unknown so the cost
 *    model estimates it instead of treating it as a discount.
 *
 * 4. No retry or 429 handling. Now exponential backoff honouring Retry-After.
 */

const BASE = 'https://api.ebay.com';

/**
 * The watchlist queries: one per man in data/my-players.json.
 *
 * The set-based list below was built for bargain hunting, where the job was to
 * see as much of the market as possible and the rotation was the price of
 * that breadth. The job now is narrower and harder: notice within one cycle
 * when a named player's card is listed. A rotation is exactly wrong for that,
 * because two runs in three a given slice is not being looked at.
 *
 * Searching by name instead is both more thorough and cheaper. Seventeen
 * names cost 2 marketplaces * (3 aspect pages + 17 * 2) = 74 searches a run.
 * At the six-hourly schedule that is 296 a day, 6% of eBay's 5,000, and every
 * player is searched every single run.
 *
 * If the Cloudflare 20 minute trigger is ever deployed, redo this: 74 a run at
 * 72 runs a day is 5,328, over the ceiling. Twelve names a run rotates inside
 * budget at 78%, with a full cycle every other run.
 */
function watchQueries(players = []) {
  return players
    .filter((p) => p && p.player)
    .map((p) => `psa 10 ${String(p.player).replace(/\s+(jr|sr|ii|iii|iv|v)\.?$/i, '').trim()} auto`);
}

/**
 * Which list a run searches. Watchlist normally, the old set-based sweep for
 * a deliberate full sweep or if the watchlist is somehow empty, because a
 * scan that searches for nothing is worse than one that searches too widely.
 *
 * Its own function so the choice can be tested. Inline in providers.js it was
 * one edit away from silently reverting to the set-based sweep, which still
 * returns plenty of listings and so looks entirely healthy from outside.
 */
function chooseQueries(players = [], { fullSweep = false } = {}) {
  const watch = watchQueries(players);
  return fullSweep || !watch.length ? QUERY_SET : watch;
}

/**
 * Kept for a manual full sweep and for rebuilding the comparable pools, which
 * still want breadth. Not used by a scheduled run any more.
 *
 * The reason it is per-set rather than generic: the first live run made 9
 * searches and saw 2,765 AU listings, of which the most-listed single card
 * appeared 5 times, below the threshold to price it. Querying per set forces
 * eBay to show different slices instead of the same popular results over and
 * over, and the comparable pools are built out of that breadth.
 */
const QUERY_SET = [
  // broad
  'psa 10 rookie autograph football card',
  'psa 10 auto rc football',
  'psa 10 rookie patch autograph',
  'psa 10 football autograph gem mint',

  // per set, the products that actually carry NFL autographs
  'psa 10 contenders rookie ticket auto',
  'psa 10 prizm rookie auto football',
  'psa 10 select rookie signatures football',
  'psa 10 national treasures rpa football',
  'psa 10 optic rated rookie auto football',
  'psa 10 mosaic rookie auto football',
  'psa 10 immaculate rookie patch auto football',
  'psa 10 phoenix rookie auto football',
  'psa 10 absolute rookie auto football',
  'psa 10 spectra rookie auto football',
  'psa 10 origins rookie auto football',
  'psa 10 zenith rookie auto football',
  'psa 10 certified rookie auto football',
  'psa 10 chronicles rookie auto football',
  'psa 10 donruss rookie auto football',
  'psa 10 score rookie auto football',
  'psa 10 illusions rookie auto football',
  'psa 10 obsidian rookie auto football',
  'psa 10 flawless rookie auto football',
  'psa 10 topps chrome rookie auto football',
  'psa 10 bowman chrome rookie auto football',
  'psa 10 gold standard rookie auto football',
  'psa 10 limited rookie auto football',
  'psa 10 prestige rookie auto football',
  'psa 10 legacy rookie auto football',
  'psa 10 playbook rookie auto football',

  // PSA 9. Deliberately few and aimed at the top of the market: a 9 only
  // earns a mention if the player is elite and early career or the discount
  // is extreme, so there is no point dredging the whole 9 population.
  'psa 9 rookie autograph football rc',
  'psa 9 prizm rookie auto football',
  'psa 9 contenders rookie ticket auto',
  'psa 9 select rookie signatures football',
  'psa 9 national treasures rpa football',
];

/**
 * Which slice of the query set this run gets.
 *
 * eBay allows 5,000 Browse calls a day. The full query set costs 147, which
 * is comfortable hourly and impossible every 20 minutes. So the set is split
 * into thirds and rotated: three consecutive runs cover the same ground an
 * hourly run used to, and the tool still gets to look at eBay three times as
 * often.
 *
 * Alert speed does not suffer, because the broad aspect-filtered pass is not
 * part of this rotation. That one runs every time and is what actually
 * catches a new listing. The rotation only affects how quickly the price
 * picture fills out, and that was never a 20-minute question.
 *
 * Which slice: a run counter when one exists, the clock otherwise.
 *
 * GitHub numbers every run, and SLICE_INDEX carries that number in. A
 * counter cannot drift: consecutive runs always take consecutive slices, no
 * matter how late GitHub starts them, and a dropped run's slice is simply
 * picked up by the next run instead of skipped. The clock fallback covers
 * running by hand, where it is fine, but on a delayed schedule it would
 * repeat a slice whenever a run started more than 13 minutes late, which on
 * GitHub is a normal Tuesday.
 */
function querySlice(all = QUERY_SET, perRun = 12, now = Date.now(), runNumber = null) {
  const slices = Math.max(1, Math.ceil(all.length / perRun));
  const index = runNumber != null && Number.isFinite(runNumber)
    ? ((runNumber % slices) + slices) % slices
    : Math.floor(now / (20 * 60 * 1000)) % slices;
  const size = Math.ceil(all.length / slices);
  return { queries: all.slice(index * size, index * size + size), index, slices };
}

/* ---------- transport ---------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Every request that actually leaves the machine, retries included.
 *
 * Counted inside fetchWithRetry rather than at the call sites, because a
 * retry storm is precisely when usage runs away, and a counter that only saw
 * successful calls would report the quota as comfortable right up until eBay
 * cut it off for the day.
 *
 * Browse is counted separately because eBay meters each API family against
 * its own daily allowance. Searches are the scarce one at 5,000 a day.
 * Taxonomy has its own 5,000 and we spend six per run on it, and the OAuth
 * token endpoint is metered differently again. Lumping them together
 * overstates search usage by about 13% and would push us into throttling the
 * schedule down for no reason.
 */
let CALLS = 0;
let BROWSE = 0;
const isBrowse = (url) => String(url).includes('/buy/browse/');

/**
 * eBay rate limits are per-app per-day and will 429 you without warning if a
 * scan runs hot. Anything transient is retried; a 4xx that is not 429 is a
 * bug in the request and retrying it just burns quota.
 */
async function fetchWithRetry(url, opts, { tries = 5, label = '' } = {}) {
  let wait = 500;
  for (let attempt = 1; attempt <= tries; attempt++) {
    let res;
    try {
      CALLS++;
      if (isBrowse(url)) BROWSE++;
      res = await fetch(url, { ...opts, signal: AbortSignal.timeout(20000) });
    } catch (e) {
      if (attempt === tries) throw new Error(`${label} network failure after ${tries}: ${e.message}`);
      await sleep(wait); wait *= 2; continue;
    }
    if (res.ok) return res;

    const retryable = res.status === 429 || res.status >= 500;
    const body = await res.text().catch(() => '');
    if (!retryable || attempt === tries) {
      throw new Error(`${label} ${res.status}: ${body.slice(0, 300)}`);
    }
    const ra = Number(res.headers.get('retry-after'));
    await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : wait);
    wait *= 2;
  }
}

/* ---------- auth ---------- */

let tokenCache = { token: null, expiresAt: 0 };

async function getToken(clientId, clientSecret) {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt - 60000) return tokenCache.token;

  const basic = btoa(`${clientId}:${clientSecret}`);
  // The path is /identity/v1/oauth2/token. Without the v1 eBay's proxy
  // returns a bare 404 with an empty body before it ever looks at the
  // credentials, which reads exactly like a bad-key problem and is not.
  const res = await fetchWithRetry(`${BASE}/identity/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials&scope=' + encodeURIComponent('https://api.ebay.com/oauth/api_scope'),
  }, { label: 'token' });

  const j = await res.json();
  tokenCache = { token: j.access_token, expiresAt: Date.now() + (j.expires_in || 7200) * 1000 };
  return tokenCache.token;
}

const headers = (token, marketplace) => ({
  Authorization: `Bearer ${token}`,
  'X-EBAY-C-MARKETPLACE-ID': marketplace,
  'Content-Type': 'application/json',
});

const getJson = async (url, token, marketplace, label) =>
  (await fetchWithRetry(url, { headers: headers(token, marketplace) }, { label })).json();

/* ---------- discovery ---------- */

// Words that should appear somewhere in the ancestor path of a real
// football-singles leaf. Guards against the suggestion API handing back a
// memorabilia or lot category that would silently return the wrong universe.
const PATH_MUST_MATCH = /(trading card|cards)/i;

async function discoverCategory(token, marketplace) {
  const tree = await getJson(
    `${BASE}/commerce/taxonomy/v1/get_default_category_tree_id?marketplace_id=${marketplace}`,
    token, marketplace, 'tree'
  );
  const treeId = tree.categoryTreeId;

  const sugg = await getJson(
    `${BASE}/commerce/taxonomy/v1/category_tree/${treeId}/get_category_suggestions` +
    `?q=${encodeURIComponent('football trading card single')}`,
    token, marketplace, 'suggestions'
  );

  const candidates = (sugg.categorySuggestions || []).map((s) => ({
    id: s.category.categoryId,
    name: s.category.categoryName,
    path: (s.categoryTreeNodeAncestors || []).map((a) => a.categoryName).reverse().join(' > '),
  }));

  // Take the first candidate whose path actually looks like trading cards,
  // not just whatever came back first.
  const chosen = candidates.find((c) => PATH_MUST_MATCH.test(`${c.path} > ${c.name}`)) || candidates[0];
  if (!chosen) throw new Error(`No category suggestions for ${marketplace}`);

  const aspects = await getJson(
    `${BASE}/commerce/taxonomy/v1/category_tree/${treeId}/get_item_aspects_for_category` +
    `?category_id=${chosen.id}`,
    token, marketplace, 'aspects'
  );

  const names = (aspects.aspects || []).map((a) => a.localizedAspectName);
  // Aspect labels differ by marketplace. Resolve them instead of assuming.
  const resolve = (...wanted) => names.find((n) => wanted.some((w) => n.toLowerCase() === w.toLowerCase())) || null;

  // Checked against the live taxonomy on both marketplaces: category 261328
  // exposes NO grading aspects. There is no "Professional Grader" and no
  // "Grade", so PSA and the 10 cannot be filtered server side at all and
  // must come from the title. What does exist, and is worth a great deal
  // more, is Sport and League, which cut the result set down to gridiron
  // before anything reaches us.
  const resolved = {
    auto: resolve('Autographed', 'Signed', 'Autograph'),
    sport: resolve('Sport'),
    league: resolve('League'),
    grader: resolve('Professional Grader', 'Grader', 'Grading Company'),
    grade: resolve('Grade', 'Card Grade'),
  };

  return { treeId, catId: chosen.id, catName: chosen.name, catPath: chosen.path, aspectNames: names, resolved, candidates };
}

/* ---------- search ---------- */

function buildFilter({ marketplace, maxPrice, auOnly }) {
  const f = [
    `price:[1..${maxPrice}]`,
    `priceCurrency:${marketplace === 'EBAY_AU' ? 'AUD' : 'USD'}`,
    'buyingOptions:{FIXED_PRICE|BEST_OFFER}',
  ];
  if (auOnly) f.push('itemLocationCountry:AU');
  return f.join(',');
}

async function searchPage(token, marketplace, params) {
  const qs = new URLSearchParams(params);
  return getJson(`${BASE}/buy/browse/v1/item_summary/search?${qs}`, token, marketplace, 'search');
}

async function pagedSearch(token, marketplace, base, maxItems = 600) {
  const out = [];
  for (let offset = 0; offset < maxItems; offset += 200) {
    const page = await searchPage(token, marketplace, { ...base, limit: '200', offset: String(offset) });
    const items = page.itemSummaries || [];
    out.push(...items);
    if (items.length < 200) break;
    await sleep(120); // stay well under the burst limit
  }
  return out;
}

/* ---------- normalisation ---------- */

function toListing(i, marketplace) {
  const ship = i.shippingOptions?.[0]?.shippingCost;
  // Absent shipping is not free shipping. Marked so the cost model estimates.
  const shippingKnown = ship != null && ship.value != null;
  return {
    itemId: i.itemId,
    title: i.title,
    price: Number(i.price?.value || 0),
    currency: i.price?.currency,
    shipping: shippingKnown ? Number(ship.value) : 0,
    shippingUnknown: !shippingKnown,
    bestOffer: (i.buyingOptions || []).includes('BEST_OFFER'),
    country: i.itemLocation?.country,
    seller: i.seller?.username,
    feedbackPct: i.seller?.feedbackPercentage != null ? Number(i.seller.feedbackPercentage) : null,
    feedbackScore: i.seller?.feedbackScore != null ? Number(i.seller.feedbackScore) : null,
    marketplace,
    url: i.itemWebUrl,
    image: i.image?.imageUrl,
    listed: i.itemCreationDate,
  };
}

/* ---------- public ---------- */

/**
 * Scan one marketplace. Returns deduped listings plus the discovery result,
 * so a caller can log which aspect names actually resolved.
 */
async function scanMarketplace({
  clientId, clientSecret, marketplace, maxPrice, auOnly = false,
  queries = QUERY_SET,
}) {
  const callsAtStart = CALLS;
  const browseAtStart = BROWSE;
  const token = await getToken(clientId, clientSecret);
  const disc = await discoverCategory(token, marketplace);
  const filter = buildFilter({ marketplace, maxPrice, auOnly });
  const seen = new Map();
  const passes = [];

  // Pass 1: aspect-filtered. High precision, misses blank-aspect listings.
  //
  // League, not Sport. Measured against the live API on both marketplaces:
  // Sport:{Football} filters correctly on EBAY_US but is silently ignored on
  // EBAY_AU, returning the identical total to no filter at all. League does
  // the job on both. Baseball and Basketball filter fine on AU, so this is
  // specific to the Football value rather than a broken aspect.
  const aspectBits = [`categoryId:${disc.catId}`];
  if (disc.resolved.league) aspectBits.push(`${disc.resolved.league}:{National Football League (NFL)}`);
  if (disc.resolved.sport) aspectBits.push(`${disc.resolved.sport}:{Football}`);
  if (disc.resolved.auto) aspectBits.push(`${disc.resolved.auto}:{Yes}`);
  if (disc.resolved.grader) aspectBits.push(`${disc.resolved.grader}:{PSA}`);
  if (disc.resolved.grade) aspectBits.push(`${disc.resolved.grade}:{10}`);

  // Deliberately outside the query rotation. This is the pass that catches a
  // newly listed card, so it runs every time. The rotation below is about
  // filling out the price picture, which is a slower business.
  if (aspectBits.length > 1) {
    try {
      const items = await pagedSearch(token, marketplace, {
        q: 'rookie autograph psa 10',
        category_ids: disc.catId,
        aspect_filter: aspectBits.join(','),
        filter,
        sort: 'newlyListed',
      });
      items.forEach((i) => seen.set(i.itemId, i));
      passes.push({ pass: 'aspect', found: items.length });
    } catch (e) {
      // A bad aspect name should degrade to keyword-only, not kill the scan.
      passes.push({ pass: 'aspect', error: String(e.message).slice(0, 200) });
    }
  }

  // Pass 2..n: keyword. Deliberately NOT aspect filtered.
  //
  // The first live run pulled roughly 1,100 baseball, basketball and even
  // Formula 1 cards through these passes, and it is tempting to filter them
  // out at the source. Resist it. Any aspect filter here also drops football
  // listings where the seller left that aspect blank, and sloppy listings
  // are exactly where the underpriced cards are. The NFL player index
  // rejects the other sports a moment later at no cost worth counting.
  for (const q of queries) {
    try {
      const items = await pagedSearch(token, marketplace, {
        q, category_ids: disc.catId, filter, sort: 'newlyListed',
      }, 400);
      let fresh = 0;
      for (const i of items) if (!seen.has(i.itemId)) { seen.set(i.itemId, i); fresh++; }
      passes.push({ pass: q, found: items.length, new: fresh });
    } catch (e) {
      passes.push({ pass: q, error: String(e.message).slice(0, 200) });
    }
    await sleep(150);
  }

  return {
    listings: [...seen.values()].map((i) => toListing(i, marketplace)),
    discovery: disc,
    passes,
    calls: CALLS - callsAtStart,
    browse: BROWSE - browseAtStart,
  };
}

module.exports = { scanMarketplace, discoverCategory, getToken, querySlice, QUERY_SET, watchQueries, chooseQueries };
module.exports.callsMade = () => ({ total: CALLS, browse: BROWSE });
