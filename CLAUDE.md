# Working on this project

Context for Claude sessions. Ryan is the only user. He is technical, wants
working code over explanation, and asks for one step at a time.

**Never use em dashes, in prose or in code. Hyphens only.**

## What this is

Scans eBay AU and US every 20 minutes for PSA 10 and PSA 9 NFL autographs
under $250 USD, values each against comparable cards, and emails the ones
worth acting on. Runs on GitHub Actions. Zero dependencies, Node 18+.

Target profile: early-career, well-rated players. A second or third year man
inside the dynasty top 24 whose value is climbing is the peak. Egbuka and
Burden are named targets in `data/my-players.json`.

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

**Never persist seller usernames.** `market.js` hashes them via `sellerKey`.
Only used to count distinct sellers. This keeps the eBay account-deletion
exemption honest. Do not carry the username into scored output.

**Slice index comes from `SLICE_INDEX` (GitHub's run number), not the clock.**
GitHub starts runs late; a clock-derived index repeats slices under delay.

**Cloudflare fires the 20 minute cadence**, via `trigger/` and
`repository_dispatch`. GitHub's own cron is a 6-hourly backstop only.
Restoring it to 20 minutes alongside the trigger doubles eBay usage.

## Budgets that constrain design

- **eBay: 5,000 Browse searches a day.** Full query set is 146. Hence the
  rotation in `ebay.js`: 10 queries a run, full cycle every 4 runs, 64% of
  the ceiling at 20 minute spacing. Taxonomy and OAuth are metered
  separately and counted separately; do not conflate them when reasoning
  about headroom. Every run prints its own usage.
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
