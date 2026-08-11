/**
 * Every tunable in one place. Nothing downstream hardcodes a number.
 *
 * The import cost block is the part most likely to be wrong in a way that
 * costs money, because eBay does not expose a clean breakdown of what it
 * charges on an import. Each value below is an assumption with a note saying
 * how confident it is. Tighten them against a real invoice once you buy
 * something, then the edge numbers stop being approximate.
 */

module.exports = {
  /* ---- what we are willing to buy ---- */
  budget: {
    maxUsd: 250,          // your ceiling, applied per card
    currency: 'USD',
  },

  /* ---- how hard we hit eBay ---- *
   *
   * eBay allows 5,000 Browse searches a day on a standard keyset, and this is
   * the budget that decides how often the tool can look. Running the whole
   * query set every 20 minutes would need 10,584 and be throttled into
   * silence by mid-morning.
   *
   * So each run takes a slice of the keyword queries and the slices rotate.
   * The broad aspect-filtered pass sits outside the rotation and runs every
   * time, which is what actually catches a newly listed card; the rotation
   * only paces how quickly the price picture fills out.
   *
   *   searchesPerRun = 2 marketplaces * (3 aspect pages + queriesPerRun * 2)
   *   searchesPerDay = searchesPerRun * runsPerDay
   *
   * At 10 per run and 20 minute spacing: 46 a run, 3,312 a day, 66% of the
   * ceiling, with a full cycle every four runs. The remaining third absorbs
   * the backstop schedule, manual full sweeps at 146 apiece, and retries.
   */
  scan: {
    /* High enough to cover the whole watchlist in one run, which is the point:
     * a rotation means two runs in three are not looking for a given player,
     * and the tool's only job now is to notice when one of them is listed.
     *
     * At the six-hourly schedule, 25 names costs 2 * (3 + 25 * 2) = 106
     * searches a run, 424 a day, 8% of the 5,000 ceiling. There is room to
     * roughly quadruple the watchlist before this needs a thought.
     *
     * The 20 minute Cloudflare trigger is the case that breaks it: 72 runs a
     * day puts even 17 names at 5,328, over the ceiling. Drop this to 12 if
     * that is ever deployed and accept a two-run cycle.
     */
    queriesPerRun: 25,
    // eBay's published daily limit for Browse. Taxonomy and OAuth are
    // metered separately, each with their own allowance, and neither is
    // anywhere near contended.
    dailyBrowseCeiling: 5000,
  },

  /* ---- import cost model, Australia ---- */
  landed: {
    // GST on low value imported goods. Solid, this is the published rate.
    gstRate: 0.10,

    // Under this value eBay collects GST at checkout. Over it, GST is
    // collected at the border instead and a broker gets involved.
    // Confident on the threshold, less so on what the broker charges.
    lowValueThresholdAud: 1000,
    customsProcessingAud: 90,

    // eBay's international service charge, bundled into "import charges" at
    // checkout and not itemised. This is an estimate from typical checkouts,
    // NOT a published rate. Single biggest source of error in the model.
    ebayImportFeeRate: 0.05,

    // Used when the listing does not expose a shipping cost. Treating unknown
    // shipping as free is how you talk yourself into a bad buy.
    estShippingFromUsAud: 25,
    estShippingDomesticAud: 10,

    // Trading cards attract no import duty in practice. Left here as a knob
    // in case that turns out to be wrong for a given shipment.
    dutyRate: 0,
  },

  /* ---- where card values come from ---- *
   *
   * No paid price feed, so there are two sources and they are not equally
   * trustworthy. Values you entered by hand are treated as truth. Values
   * inferred from what other people are asking on eBay are treated as a
   * rough guide and scored down accordingly.
   */
  market: {
    // A card needs this many DISTINCT listings observed before its median
    // means anything. One seller relisting the same card 40 times is one
    // observation, which is why the store is keyed on itemId.
    minObservations: 6,

    // A listing that vanishes within this many days of first being seen is
    // treated as having cleared the market at roughly its asking price.
    // eBay's sold-price API is a limited release and closed to new
    // applicants, so watching the shelf is the free alternative.
    soldWithinDays: 14,
    // How long a listing must be absent before "vanished" is believed. Must
    // exceed one full query-rotation cycle (an hour) with room for dropped
    // runs, or cards whose query simply did not run this time get counted
    // as sales.
    goneGraceHours: 3,
    // How many cleared listings before that becomes the price, rather than
    // discounting the asking price.
    minClearedForPrice: 3,

    // Fallback only, used until enough listings have cleared. Asking prices
    // run above selling prices and this converts one to the other.
    //
    // THIS NUMBER IS A GUESS, and it is why the cleared-listing signal above
    // exists: once a card has three sales-worth of evidence, this stops
    // being used for it at all.
    askToSoldRatio: 0.85,

    // How much to trust a score built on each source.
    valueTrust: { you: 1.0, market: 0.75 },

    // Liquidity without sales-volume data. Substitute signal is how many
    // distinct copies of this card we have seen listed over time. A card
    // that shows up constantly is liquid, one seen twice is not.
    liquidityFloorListings: 4,
    liquidityComfortListings: 25,

    // Drop observations older than this so the median tracks the market
    // rather than remembering 2024 prices forever.
    observationTtlDays: 120,
  },

  /* ---- what counts as an NFL card ---- */
  nfl: {
    // Drop anything printed before the player's NFL debut. A 2022 card of a
    // man who debuted in 2024 is a college or draft-prospect card, whatever
    // the set is called.
    excludeCollege: true,

    // Debut is inferred from years of experience, which freezes when a player
    // retires and then drifts late. So the rule is only applied to players
    // who currently have a team, where the number is reliable. Without this
    // guard the 2011 Topps Chrome A.J. Green gets thrown out as "college"
    // because his frozen experience implies a 2014 debut.
    onlyWhenRostered: true,

    // A draft-year product carries the draft year, which equals the debut
    // year, so it passes. This allows one year of slack beyond that for
    // products dated the season before release.
    graceYears: 0,
  },

  /* ---- gates ---- */
  gates: {
    // Below this the parser does not trust its own read of the title.
    minParseConfidence: 70,
    // Below this the listing could not be tied to a specific comp row.
    minMatchConfidence: 75,

    // Liquidity. Under the floor the comp is an anecdote, not a price, and
    // the listing is dropped outright. Between floor and comfort the score
    // is ramped down rather than cliff-edged.
    liquidityFloorSales: 12,
    liquidityComfortSales: 60,
  },

  /* ---- multipliers ---- */
  /* ---- who we want ---- *
   *
   * The target is a highly rated early-career player: a second or third year
   * man inside the dynasty top 20 or so. Age and experience alone cannot
   * express that, because a 23 year old nobody rates scores the same as a
   * 23 year old the whole hobby is chasing.
   *
   * So the multiplier is built from three things, in order of weight:
   *   dynasty rank   what the fantasy market pays for him right now
   *   trend          which way that has moved over 30 days
   *   experience     early career still gets a lift on top
   */
  youth: {
    // Where the hobby rates him. Unranked players sit outside the top 475
    // and are penalised, which is correct: nobody is chasing their cards.
    byDynastyRank: [
      { maxRank: 12, mult: 1.35 },
      { maxRank: 24, mult: 1.25 },
      { maxRank: 50, mult: 1.15 },
      { maxRank: 100, mult: 1.05 },
      { maxRank: 200, mult: 1.00 },
      { maxRank: 9999, mult: 0.92 },
    ],
    unrankedMult: 0.80,

    // Rising or falling over the last month. A player the market is moving
    // toward is worth paying up for; one bleeding value is not.
    trendRisingAbove: 100,
    trendRisingMult: 1.12,
    trendFallingBelow: -100,
    trendFallingMult: 0.90,

    // Early career lift, on top of the rank. This is what makes a top-20
    // second year player the highest scoring profile in the system.
    byExp: [
      { maxExp: 0, mult: 1.10 },   // rookie, rank is still speculative
      { maxExp: 2, mult: 1.15 },   // 2nd and 3rd year, the sweet spot
      { maxExp: 5, mult: 1.00 },
      { maxExp: 9, mult: 0.95 },
      { maxExp: 99, mult: 0.88 },
    ],
  },

  sellerTrust: {
    // Feedback percentage bands.
    bands: [
      { minPct: 99.5, mult: 1.00 },
      { minPct: 98.0, mult: 0.95 },
      { minPct: 95.0, mult: 0.85 },
      { minPct: 0, mult: 0.60 },
    ],
    // Thin feedback history is its own risk regardless of percentage.
    newAccountScore: 50,
    newAccountMult: 0.80,
    veryNewAccountScore: 10,
    veryNewAccountMult: 0.60,
  },

  /* ---- alerting ---- *
   *
   * Two reasons a card gets emailed, and they have different bars.
   *
   *   Young guns: rookies through third year. Lower bar, because these are
   *   what Ryan is actually hunting and he wants to see them even when the
   *   discount is modest.
   *
   *   Value plays: anyone, any age, but the discount has to be real.
   *
   * A card qualifying on both shows up under young guns with a note.
   */
  alert: {
    youngMaxExp: 2,        // 0 rookie, 1 second year, 2 third year
    youngMinEdge: 0.10,    // 10% under market is enough for a young player
    bargainMinEdge: 0.30,  // 30% under before age stops mattering

    maxPerEmail: 10,

    /* Three reasons a card earns an email. A card can qualify on more than
     * one; it is shown once, under the strongest reason, and the others are
     * named on the row so it is obvious why it is there.
     *
     *   TARGET   a player flagged alwaysAlert in data/my-players.json. Any
     *            call, any discount, including the ones the tool rates badly.
     *            Ryan asked to hear about these whatever the numbers say.
     *   DEAL     the existing bar: a strong call, or a BUY.
     *   PROFILE  the shape Ryan is hunting, independent of any valuation.
     *
     * PROFILE deliberately carries no discount test and no dynasty rank test.
     * It answers "is this the kind of card I want to own at this price", which
     * is a question about the card, not about the market. That also makes it
     * the one reason here that can fire on a card the tool cannot value.
     */
    reasons: {
      // Named targets alert at any call. Turn off to put them back on the
      // ordinary DEAL bar.
      targetAnyCall: true,

      /* The watchlist rule, and currently the only one switched on.
       *
       * Ryan's brief: "All notifications are PSA 10 autos of those players
       * only." Autographs are structural, since parse.js rejects anything
       * that does not claim one, so the two tests that live here are the
       * grade and the price.
       *
       * maxAskUsd is the asking price in USD before postage, which is the
       * number on the listing rather than what it costs landed in Australia.
       * A $190 card from the US lands nearer $420 AUD once postage, GST and
       * the import charge are on it. Say the word and this becomes a test on
       * landedAud instead; it is one line.
       */
      target: {
        grade: 10,
        maxAskUsd: 200,
      },

      /* The old bargain hunter. Off: Ryan asked for the watchlist only.
       *
       * Turning this back on restores STRONG BUY and BUY emails for any
       * player at all, which is what "too many emails" was about.
       */
      deal: { enabled: false },

      // Also off. It was the "any first or second year PSA 10 under $200"
      // rule, and the watchlist replaced it: the men Ryan wants are named now
      // rather than described.
      profile: {
        enabled: false,
        maxExp: 1,          // 0 rookie, 1 second year. First or second year only.
        grade: 10,          // PSA 10 only. A 9 has to earn its place elsewhere.
        maxAskUsd: 200,     // the asking price in USD, not the landed cost

        /* Proof the man is actually a current NFL player, which experience on
         * its own does not give. Sleeper reports years_exp 0 for someone who
         * never played and freezes it at retirement, so the index carries Kurt
         * Warner at 47 with exp 0 and 2,775 entries at exp 0 or 1 in total.
         * Without these two, "first or second year" quietly includes the
         * retired and the never-were.
         *
         * requireRanked is also the volume brake. Ryan asked for no quality
         * bar and this is the mildest one that works: ranked at all by the
         * dynasty market, not ranked highly. Set it false once a live run has
         * printed its PROFILE tally and shown the number is manageable.
         */
        requireRostered: true,
        requireRanked: true,

        // A harder cap on top, if ranked-at-all still proves too loud. null
        // means no ceiling beyond requireRanked.
        maxDynRank: null,
      },
    },

    /* Per-section caps. Targets and profile cards are capped separately from
     * the buys, so a flood of one cannot bury the other.
     *
     * maxTargets is deliberately high. Everything that clears the bar is
     * marked as emailed whether or not it fitted, which is what stops the cap
     * becoming a drip feed, but it also means a trimmed card is one Ryan never
     * sees. That is an acceptable trade for the hundreds of ordinary buys and
     * a bad one for the two men he asked to be told about every time. With two
     * named players this should never bind; it is here as a runaway guard for
     * the day the target list grows.
     */
    maxTargets: 25,
    maxProfile: 8,

    // Fallbacks only. The real addresses come from the ALERT_FROM and
    // ALERT_TO environment variables, which on GitHub are repository secrets.
    // Kept out of this file deliberately: the repo is public, and a working
    // address sitting in a public file is an invitation to scrapers.
    from: 'PSA 10 Scout <onboarding@resend.dev>',
    to: '',
  },

  /* ---- fx ---- */
  fx: {
    endpoint: 'https://open.er-api.com/v6/latest/USD',
    fallbackUsdToAud: 1.4338,   // last known good, used if the fetch fails
  },
};
