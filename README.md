# PSA 10 NFL autograph watchlist

> **Retired, August 2026.** The scan is switched off and nothing runs on a
> schedule any more. It did its job: the last live run found 94 PSA 10
> autographs across 14 of the 17 watchlisted players and emailed them in one
> go. Both automatic triggers are commented out in
> `.github/workflows/scan.yml`; uncommenting them is all it takes to start it
> again. The Run workflow button still works for a one-off scan by hand.

Watches eBay Australia and eBay US for PSA 10 autographs of the players you
name, works out what each one costs landed in Australia, and emails you when
one is listed.

Runs itself on GitHub Actions. Free, nothing to host, nothing on your machine.

**Setup: [GITHUB-SETUP.md](GITHUB-SETUP.md)**

## What gets emailed

One rule: a **PSA 10 autograph**, of a player in `data/my-players.json`,
asking under **$200 USD**. Each listing is emailed once. Nothing else earns a
place, however cheap it is.

## How it decides

1. **Read the title.** Year, set, player, parallel, card number, grade. It
   refuses to guess when unsure rather than reporting a fake bargain.
2. **Find a value.** Your own numbers first. Where you have none, the median
   of comparable cards in the same scan: same grade, same set, same rarity
   tier, same dynasty band, licensed against unlicensed.
3. **Work out real cost.** Price plus postage in AUD, plus GST and import
   charges when the seller is overseas.
4. **Write a call.** STRONG BUY down to SKIP, with a sentence saying why, in
   terms you can check against the row.
5. **Email it, if it is one of yours.** The call and the price comparison are
   there so you can judge the listing at a glance. They do not decide whether
   the email is sent; the watchlist does. Once each, and a card only comes
   round again if its call improves.

## The files you edit

| File | What it is |
| --- | --- |
| `data/my-players.json` | **The watchlist.** Every player here gets his own eBay search and every listing of him is emailed. This is the file that decides what you hear about. |
| `data/my-values.json` | Cards you know the price of. Trusted over everything else. |
| `data/my-values-TOFILL.json` | 30 commonly listed cards with the prices left blank. A worksheet. |
| `data/known-cards.json` | Cards for the sanity check. |
| `config.js` | Every threshold and assumption, with notes on which are guesses. |

Commit and push after editing. The next run picks them up.

## Running it yourself

No dependencies to install. Node 18 or newer.

```bash
npm test          # parser checks
npm run scan      # sweep, writes report.html
npm run backtest  # check the tool against cards you know
```

A live sweep needs the eBay keys:

```bash
EBAY_CLIENT_ID=... EBAY_CLIENT_SECRET=... DATA_SOURCE=live npm run scan
```

A scheduled run searches for your watchlist by name, one query per player, so
a new listing is found on the very next scan. `SCAN_ALL=1` runs the old wide
set-based sweep instead, which is what rebuilds the comparable-card pools.

`DATA_SOURCE` also takes `cached`, which re-scores the last live pull without
spending eBay quota, and `seed`, which uses invented listings. Both write to a
separate price history so test runs cannot pollute the real one.

Set `ALERT_DRY_RUN=1` to build the email and write `alert-preview.html`
instead of sending it.

## What is guesswork

Named in `config.js` so they are easy to find and fix:

- `askToSoldRatio` assumes cards sell for 85% of asking price. This stops
  being used for a card once three of its listings have cleared the shelf.
- `ebayImportFeeRate` assumes eBay's import charge is 5%. Not a published
  rate. Check it against a real invoice once you buy something.

## Known limits

Values come from asking prices, not confirmed sales. eBay's sold-price API is
a limited release and closed to new applicants, and the paid alternatives
start at $49/month. So the tool watches which listings vanish quickly and
treats those as having cleared at roughly their asking price. That signal
needs a few weeks of history before it means much.

Relative pricing spots the outlier within a market. It cannot tell you the
market itself is wrong. If every copy of a card on eBay is overpriced, a
slightly less overpriced one still looks like a find.

## Data sources

- eBay Browse API, live listings
- Sleeper, player ages, teams and experience, free, no key
- FantasyCalc, dynasty ranks and 30 day trend, free, no key
- open.er-api.com, AUD/USD rate
- Resend, the email
- Your own valuations
