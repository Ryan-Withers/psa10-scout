# PSA 10 NFL autograph scout

Sweeps eBay Australia and eBay US for PSA 10 and PSA 9 NFL autographs, works
out what each one actually costs landed in Australia, compares that against
what similar cards are going for, and emails the ones worth acting on.

Runs itself every 20 minutes on GitHub Actions. Free, nothing to host,
nothing running on your machine.

**Setup: [GITHUB-SETUP.md](GITHUB-SETUP.md)**

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
5. **Email the good ones.** Once each. A card only comes round again if its
   call improves.

## What it is looking for

A highly rated early-career player, which is the profile that moves. A second
or third year man inside the dynasty top 24 whose value is climbing scores
highest. College and pre-debut cards are dropped. PSA 9s only appear when the
player is elite and early career, or the discount is extreme.

## The files you edit

| File | What it is |
| --- | --- |
| `data/my-players.json` | Players you rate. Multiplies their score. |
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

A scheduled run only takes a third of the search list, because eBay allows
5,000 searches a day. `SCAN_ALL=1` forces the full set for a one-off sweep.

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
