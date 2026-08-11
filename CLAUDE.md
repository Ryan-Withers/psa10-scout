# Working on this project

Context for Claude sessions. Ryan is the only user. He is technical, wants
working code over explanation, and asks for one step at a time.

**Never use em dashes, in prose or in code. Hyphens only.**

## What this is

A watchlist. It scans eBay AU and US for PSA 10 autographs of the players
named in `data/my-players.json` and emails Ryan when one is listed. Runs on
GitHub Actions. Zero dependencies, Node 18+.

One rule decides everything: **PSA 10, autograph, a man on the watchlist,
asking under `alert.reasons.target.maxAskUsd`.** Nothing else earns an email.
Not a 60% discount, not a top-24 dynasty asset, not a rookie fitting the old
profile. `test-market.js` guards this with "a screaming bargain of a player
you never named earns nothing", because the old behaviour creeps back easily.

It used to be a bargain hunter across the whole market. That produced too many
emails for what Ryan actually wanted, which is: tell me when one of my guys
appears. `alert.reasons.deal` and `alert.reasons.profile` are the old rules,
both switched off in config rather than deleted. The valuation machinery still
runs, so each card still carries a call and a price comparison, but the call
does not decide whether the email is sent.

Adding a player is one row in `my-players.json`. The scan picks it up on the
next run, including a new eBay query for him.

## Running it

```bash
npm test                                    # parser (17) + market and alerts (10)
DATA_SOURCE=cached ALERT_DRY_RUN=1 npm run scan   # rescore 2,765 saved listings, no network, no email
npm run backtest                            # check values against cards Ryan knows
```

`test-market.js` guards the two faults that are invisible in production: a
sold signal that invents sales, and an alert cap that drip-feeds. Both
shipped once. Do not weaken those assertions to make a change pass.

`DATA_SOURCE`: `live` hits eBay, `cached` rescores the last live pull, `seed`
uses invented listings. **Only `live` writes `data/market-store.json`**; the
others write `market-store-demo.json` so test runs cannot pollute real price
history. Preserve that separation.

`ALERT_DRY_RUN=1` writes `alert-preview.html` instead of sending.

Live runs need `EBAY_CLIENT_ID` and `EBAY_CLIENT_SECRET`. Use
`QUERIES_PER_RUN=2` when testing live so you spend almost no quota.

## The pipeline

`run.js` orchestrates: providers -> parse -> market -> compare -> score ->
verdict -> notify.

| File | Job |
| --- | --- |
| `parse.js` | eBay title to structured card. The hard part. |
| `vocab.js` | Controlled vocabularies for sets, parallels, grades |
| `ebay.js` | Browse API, query rotation, call counting |
| `market.js` | Accumulated asking prices, disappeared-listing signal |
| `compare.js` | Values a card against similar cards |
| `score.js` | Landed cost, edge, multipliers |
| `verdict.js` | The written call, STRONG BUY to SKIP |
| `alert.js` | Builds the email |
| `notify.js` | Sends it, remembers what was sent |
| `config.js` | Every threshold, with notes on which are guesses |

## Invariants, each learned from a real bug

**Parse players before parallels.** Half the parallel vocabulary is also a
surname: Green, Brown, White, Black. Matching parallels first eats "A.J.
Green" and reports a green parallel of nobody.

**Check `NOT_AUTO` before `AUTO`.** "No Auto" and "Not Autographed" both
contain a substring satisfying `AUTO`. Without the guard, a base card whose
title explicitly denies an autograph gets priced against an autograph comp.

**Never pool unlicensed sets with licensed.** Leaf, Wild Card, Sage and
friends carry no NFL logos and price well below Panini. Measured: $307 median
licensed against $245 unlicensed for top-60 players. Pooling manufactures
discounts that are not there.

**Being seen clears the `gone` flag.** A scheduled run carries only a third of
the keyword queries, so a card whose query did not run is invisible while
still listed. Without this, and without `goneGraceHours`, every keyword-found
card eventually counts as a sale and inflates the cleared-price medians.

**Mark every alert candidate as sent, not just the ten shown.** The email cap
is for readability. Marking only the shown ten turns it into a queue that
drip-feeds the rest of the list on later runs.

**Cap each email section before building the exclusion set, never after.**
`selectAlerts` slices `act` and `also` first, then builds `shown` from what
survived. Built from the uncapped lists instead, a named target at act
position 11 was cut by the slice, barred from the targets section for being
"already shown", rendered nowhere, and marked as emailed. The cap silently ate
the one card the feature exists for.

**Experience alone cannot tell you a player is early career.** Sleeper reports
`years_exp` 0 for a man who never played and freezes it at retirement, so the
index holds Kurt Warner at 47 with exp 0, among 2,775 entries at exp 0 or 1.
`isBoomRookie` only escaped this by also demanding a dynasty rank inside the
top 60. `fitsProfile` has no rank test, so it carries `requireRostered` and
`requireRanked` instead. Any new rule keyed on `exp` needs one of the two.

**`conviction` and `alwaysAlert` answer different questions.** Conviction is
how much Ryan rates a player and it multiplies the score. `alwaysAlert` is
whether he wants his phone to buzz. `isTarget` (conviction) drives the scoring
multipliers; `isNamed` (either) drives what the email says. Flagging a player
alwaysAlert at conviction 1.0 is invited by `my-players.json`, and it used to
put a card in the targets section with nothing on it saying why.

**Test the delivery, not just the decision.** The first cut of the three-reason
alerting had six assertions, all stopping at `evaluate()`. Five separate
mutations that each destroyed the feature outright, including deleting the
target and profile buckets and reverting `notify`'s bar, all left the suite
green. Assertions now run a card to rendered email text, and the wiring
`run.js` used to do inline lives in `notify.alertPopulation` so it can be
tested at all. Before trusting a new assertion, revert the guard it covers and
watch it fail.

**`verdict.reasons` is the only definition of what earns an email.** Three
reasons exist; only `TARGET` is switched on. `notify.js` and `alert.js` both
read that array. Restating the bar as a threshold in either is how the two
drift apart and cards get marked sent without being shown.

**Every email section selects on its reason, never on the call.** `act` and
`also` used to select on `verdict.shout`, which is computed from the call and
knows nothing about whether `reasons.deal` is enabled. With dealing switched
off, a STRONG BUY of a player nobody named still rendered into the email while
`notify` built its sent-list from rows carrying a reason. Shown but never
marked means emailed again on every scan, forever.

**Anything reaching the email can now be priced above the market.** `hook()`
and the alert copy used to hardcode the word "under" next to the edge, which
was safe while only buys were emailed. Targets and profile cards arrive at any
call. Telling Ryan a card is cheap when it is 9% over is how he stops
believing the rest of the email.

**A hand-entered value needs a real price to count.** `handValueRows` drops
any row whose `psa10Usd` is not a positive number. `my-values-TOFILL.json` is
a 30 card worksheet meant to be filled a few at a time, and a blank row that
reaches the value index prices its card at $0, matches it at high confidence,
scores it NaN, and skips the comparable-pool fallback that would have valued
it. The card is silently binned and it looks like ordinary PASS traffic.

**Never put a value you are not sure of in `my-values.json`.** Your numbers
outrank everything inferred, so a wrong one there does more damage than no
number at all. The file shipped six invented example prices for a while and
they were being used as truth on live scans.

**Never persist seller usernames.** `market.js` hashes them via `sellerKey`.
Only used to count distinct sellers. This keeps the eBay account-deletion
exemption honest. Do not carry the username into scored output.

**Slice index comes from `SLICE_INDEX` (GitHub's run number), not the clock.**
GitHub starts runs late; a clock-derived index repeats slices under delay.

**Cloudflare fires the 20 minute cadence**, via `trigger/` and
`repository_dispatch`. GitHub's own cron is a 6-hourly backstop only.
Restoring it to 20 minutes alongside the trigger doubles eBay usage.

## Budgets that constrain design

- **eBay: 5,000 Browse searches a day.** A scheduled run searches the
  watchlist by name, one query per player, no rotation: a rotation would mean
  two runs in three are not looking for a given man, which is the opposite of
  the job. 17 names cost `2 marketplaces * (3 aspect pages + 17 * 2)` = 74 a
  run, 296 a day at the 6-hourly schedule, 6% of the ceiling. Room for roughly
  four times the current list. `SCAN_ALL=1` still runs the old 146-query
  set-based sweep, which is what rebuilds the comparable pools. Taxonomy and
  OAuth are metered separately; do not conflate them. Every run prints usage.
  **The 20 minute trigger is what breaks this arithmetic**: 74 a run at 72
  runs a day is 5,328, over the ceiling. Drop `queriesPerRun` to 12 first.
- **Sleeper: once a day.** `build-player-index.js` reuses a copy under 20
  hours old; the workflow also caches it under the date.
- GitHub Actions is unlimited on a public repo.

## The repo is public

No keys, no email addresses in any tracked file. `config.js` ships empty
placeholders for `alert.to` and `alert.from`; the real values are repository
secrets read from `ALERT_TO` and `ALERT_FROM`. Do not print the recipient into
logs. `.claude/` is gitignored because it holds chat transcripts.

## Before saying something works

Run `npm test` and a `cached` scan. If you touched `market.js`, also verify
the three sold-signal cases: a still-listed card under rotation is not marked
sold, a genuinely gone card is, and a reappearance withdraws the claim.

Valuation is the weak point, not the plumbing. Asking prices are not sold
prices. If a change makes more cards look like bargains, suspect the change.
