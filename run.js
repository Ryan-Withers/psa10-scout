/**
 * The sweep. Listings in, three lists out.
 *
 *   BUYS       priced against a value, ranked by score
 *   WORTH A LOOK  read fine, no value on file, sorted by how interesting
 *   IGNORED    failed a gate. Not a card, wrong slab, unreadable
 *
 * The middle list exists because this is a shortlist tool. Throwing away
 * every card we cannot price would throw away most of the market.
 *
 * Run: node run.js
 */

const fs = require('fs');
const path = require('path');
const CFG = require('./config');
require('./providers').loadPlayerIndexFromDisk();
const P = require('./providers');
const { parseTitle } = require('./parse');
const { buildIndex, matchListing } = require('./match');
const { scoreListing, setConviction } = require('./score');
const market = require('./market');
const compare = require('./compare');
const { evaluate, byCall, unreadTarget } = require('./verdict');
const { notify, alertPopulation } = require('./notify');

(async () => {
  setConviction(P.getConviction());
  // FX first: the live scan needs it to convert the USD ceiling for the AU
  // marketplace query.
  const fx = await P.getFx();
  const listings = await P.getListings(fx);
  const store = P.loadMarketStore();

  if (listings.discovery) {
    const s = listings.discovery._slice;
    if (s) {
      // Printed every run, because searches are the one budget that can
      // silence the tool. Only Browse calls count here; taxonomy and auth
      // are metered separately and have their own untroubled allowances.
      const perDay = (n) => Math.round(s.browse * (1440 / n));
      const ceil = CFG.scan.dailyBrowseCeiling;
      const pct = Math.round(perDay(20) / ceil * 100);
      console.log(`query slice ${s.index + 1} of ${s.slices}, ${s.queries} queries, ` +
        `${s.browse} searches (${s.calls} calls all up)  ->  ` +
        `${perDay(20)}/day at 20 min spacing, ${pct}% of eBay's ${ceil}\n`);
    }
    for (const [mp, d] of Object.entries(listings.discovery)) {
      if (mp === '_slice') continue;
      const missing = Object.entries(d.resolved).filter(([, v]) => !v).map(([k]) => k);
      console.log(`${mp}  cat ${d.catId}  filters: ${Object.entries(d.resolved).filter(([, v]) => v).map(([k]) => k).join(', ')}` +
        (missing.length ? `  (unavailable: ${missing.join(', ')})` : ''));
      for (const p of d.passes) {
        console.log(`   ${p.error ? 'ERR ' : ''}${String(p.found ?? '').padStart(5)}${p.new != null ? ` (+${p.new} new)` : ''}  ${p.pass}${p.error ? '  ' + p.error : ''}`);
      }
    }
    console.log('');
  }

  /* pass 1: read every title, record what people are asking */
  const parsed = new Map();
  const seenIds = new Set();
  for (const l of listings.rows) {
    const p = parseTitle(l.title);
    parsed.set(l.itemId, p);
    seenIds.add(l.itemId);
    if (!p.reject && p.confidence >= CFG.gates.minParseConfidence) {
      market.record(store, p, l, fx);
    }
  }
  // Anything we tracked before and did not see this time has left the market.
  // That is the sold-price signal, and it only works if this runs every time.
  const cleared = market.reconcile(store, seenIds);
  market.prune(store);
  P.saveMarketStore(store);
  if (cleared) console.log(`${cleared} listings left the market since last scan`);

  /* pass 2: build comparable-card pools from this scan */
  const poolEntries = [];
  for (const l of listings.rows) {
    const p = parsed.get(l.itemId);
    if (!p || p.reject || p.confidence < CFG.gates.minParseConfidence) continue;
    poolEntries.push({ parsed: p, askAud: market.askAud(l, fx) });
  }
  const pools = compare.buildPools(poolEntries);

  /* pass 3: value, score and judge */
  const values = await P.getValues(fx, store);
  const index = buildIndex(values.rows);

  const results = [];
  for (const l of listings.rows) {
    const p = parsed.get(l.itemId);
    if (p.reject) {
      results.push({ itemId: l.itemId, title: l.title, dropped: `gate:${p.reject}`, warnings: [] });
      continue;
    }
    const r = scoreListing(l, p, matchListing(p, index), fx, pools);
    if (!r.dropped) r.verdict = evaluate(r);
    results.push(r);
  }

  const buys = results.filter((r) => !r.dropped && !r.unpriced).sort(byCall);
  const look = results.filter((r) => r.unpriced).sort((a, b) => (b.interest ?? 0) - (a.interest ?? 0));
  const ignored = results.filter((r) => r.dropped);

  // A named target the parser could not read is still a named target. These
  // carry no call and no price, only a name and a link. See verdict.unreadTarget.
  const unread = [];
  for (const r of ignored) {
    const v = unreadTarget(r);
    if (v) { r.verdict = v; unread.push(r); }
  }
  const shouts = buys.filter((r) => r.verdict?.shout);

  // A real sweep returns thousands of listings. Writing every one of them,
  // pretty-printed, produced a multi-megabyte file and killed the process
  // partway through. Only the top of each list is worth keeping; the counts
  // tell you the rest.
  const CAP = { buys: 250, look: 250, ignored: 100 };

  const payload = {
    generated: new Date().toISOString(),
    dataSource: P.SOURCE,
    placeholderData: P.SOURCE === 'seed',
    fx, values: values.counts, discovery: listings.discovery || null,
    counts: { input: listings.rows.length, buys: buys.length, look: look.length, ignored: ignored.length, shouts: shouts.length },
    capped: CAP,
    buys: buys.slice(0, CAP.buys),
    look: look.slice(0, CAP.look),
    ignored: ignored.slice(0, CAP.ignored),
  };

  fs.writeFileSync(path.join(__dirname, 'ranked.json'), JSON.stringify(payload));
  fs.writeFileSync(path.join(__dirname, 'report.html'), renderHtml(payload));

  /* ---------- console ---------- */
  const A = (n) => '$' + Number(n).toFixed(0);
  const pc = (n) => (n * 100).toFixed(0) + '%';
  const src = (s) => (s === 'you' ? 'you ' : 'mkt ');

  console.log(`\nfx ${fx.usdToAud.toFixed(4)} USD to AUD   values: ${values.counts.fromYou} from you, ${values.counts.fromMarket} from the market`);
  console.log(`${payload.counts.input} listings  ->  ${buys.length} priced, ${look.length} worth a look, ${ignored.length} ignored\n`);

  if (shouts.length) {
    console.log('*** ' + shouts.length + ' WORTH SHOUTING ABOUT ***\n');
    shouts.slice(0, 6).forEach((r) => {
      console.log('  ' + r.verdict.call + (r.verdict.tags.length ? '  [' + r.verdict.tags.join(' ') + ']' : ''));
      console.log('  ' + r.verdict.take);
      console.log('  ' + r.url + '\n');
    });
  }

  console.log('THE SHORTLIST');
  console.log('  ' + '-'.repeat(96));
  buys.slice(0, 15).forEach((r) => {
    console.log('  ' + String(r.verdict.call).padEnd(11) + A(r.landedAud).padStart(6) + ' vs ' + A(r.compAud).padStart(6) +
      '  ' + (r.edge >= 0 ? '+' : '') + pc(r.edge).padStart(5) + '  ' +
      (r.year + ' ' + r.player + (r.parallel ? ' ' + r.parallel : '')).padEnd(42) +
      (r.verdict.tags.length ? r.verdict.tags.join(' ') : ''));
  });

  console.log('\n  calls: ' + Object.entries(buys.reduce((a, r) => { a[r.verdict.call] = (a[r.verdict.call] || 0) + 1; return a; }, {})).map(([k, v]) => k + ' ' + v).join('   '));

  /**
   * How many cards each alert reason pulled in, before the per-section caps
   * and before the already-emailed filter. Printed because PROFILE is the one
   * rule here with no discount test and no rank test, so it is the one that
   * could quietly match hundreds of listings a sweep. If this line reads
   * PROFILE 300 on a live run, the rule wants tightening in config, not the
   * email cap raising.
   */
  const reasonTally = [...buys, ...look].reduce((a, r) => {
    for (const why of r.verdict?.reasons || []) a[why] = (a[why] || 0) + 1;
    return a;
  }, {});
  console.log('  alertable: ' + (Object.entries(reasonTally).map(([k, v]) => k + ' ' + v).join('   ') || 'none'));

  console.log(`\nIGNORED (${ignored.length})`);
  const why = {};
  for (const d of ignored) { const k = String(d.dropped).split(':')[1] || d.dropped; why[k] = (why[k] || 0) + 1; }
  for (const [k, n] of Object.entries(why).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(3)}  ${k}`);

  console.log('\nwrote ranked.json and report.html');
  if (P.SOURCE === 'seed') console.log('\n*** Placeholder data. Values are invented. ***');

  /* ---------- the email ---------- *
   *
   * Last, deliberately. Everything above is written to disk before anything
   * is sent, so a Resend outage costs an email and not the scan.
   */
  try {
    const r = await notify(alertPopulation(buys, look, unread), {
      placeholder: P.SOURCE !== 'live',
      dryRun: process.env.ALERT_DRY_RUN === '1',
    });
    // The recipient address is deliberately not printed. On GitHub this log
    // is public. Actions masks exact secret values, but not derivatives, and
    // an address has no business in a public log either way.
    console.log(r.sent
      ? `\nemailed: ${r.subject}  (${r.act} to act on, ${r.also} also solid, ${r.targets} targets, ${r.profile} profile)`
      : `\nno email: ${r.reason}${r.would ? ` (${r.would} would have gone)` : ''}`);
  } catch (e) {
    // Never fatal. The scan succeeded and the price history is already saved.
    console.error(`\nemail failed: ${e.message}`);
  }
})().catch((e) => { console.error(e); process.exit(1); });

/* ---------- report ---------- */

function renderHtml(p) {
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const A = (n) => '$' + Number(n).toFixed(0);
  const pc = (n) => (n * 100).toFixed(0) + '%';

  const tag = (t, cls = 'w') => `<span class="${cls}">${esc(t)}</span>`;
  const cardCell = (r) => `
    <a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.year)} ${esc(r.player)}</a>
    ${r.bestOffer ? tag('offer', 'o') : ''}${r.conviction > 1 ? tag(`your pick x${r.conviction}`, 'c') : ''}
    <span class="sub">${esc(r.set)} &middot; ${r.parallel ? esc(r.parallel) : 'base'}${r.insert ? ' &middot; ' + esc(r.insert) : ''}</span>
    ${(r.warnings || []).filter((w) => w !== 'assumed-base-parallel').map((w) => tag(w)).join('')}`;

  const buyRows = p.buys.map((r) => `
    <tr class="${r.verdict && r.verdict.call === 'STRONG BUY' ? 'hot' : ''}">
      <td><span class="call ${r.verdict ? r.verdict.call.replace(' ', '') : ''}">${esc(r.verdict ? r.verdict.call : '')}</span></td>
      <td style="max-width:520px">${esc(r.verdict ? r.verdict.take : '')}
        <span class="sub"><a href="${esc(r.url)}" target="_blank" rel="noopener">see the listing</a>
        ${(r.verdict && r.verdict.tags || []).map((t) => tag(t, 'o')).join('')}</span></td>
      <td>${A(r.landedAud)}<span class="sub">vs ${A(r.compAud)}</span></td>
      <td class="${r.edge < 0 ? 'neg' : ''}">${pc(r.edge)}</td>
    </tr>`).join('');

  const lookRows = p.look.map((r) => `
    <tr><td class="n"></td><td colspan="2">${A(r.landedAud)}</td>
      <td>${cardCell(r)}</td>
      <td colspan="2" class="sub">${esc(r.unpriced)}</td>
      <td>${esc(r.country)} &middot; ${esc(r.feedbackPct)}%</td></tr>`).join('');

  return `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>PSA 10 sweep</title>
<style>
:root{--fg:#1a1a1a;--mut:#6b6b6b;--line:#e5e3df;--bg:#faf9f7;--hot:#f0f7f0;--warn:#8a6d3b;--neg:#b04a4a}
*{box-sizing:border-box}body{margin:0;padding:28px 20px;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--fg);background:var(--bg)}
.wrap{max-width:1120px;margin:0 auto}h1{font-size:20px;margin:0 0 4px}
.meta{color:var(--mut);font-size:13px;margin-bottom:18px}
.banner{background:#fff4e5;border:1px solid #f0d9b5;padding:12px 14px;border-radius:6px;margin-bottom:18px;font-size:13px}
h2{font-size:13px;margin:26px 0 8px;color:var(--mut);text-transform:uppercase;letter-spacing:.05em}
h2 span{text-transform:none;letter-spacing:0;font-weight:400}
table{width:100%;border-collapse:collapse;background:#fff;border:1px solid var(--line);border-radius:6px;overflow:hidden}
th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--mut);padding:10px;border-bottom:1px solid var(--line);font-weight:600}
td{padding:10px;border-bottom:1px solid var(--line);vertical-align:top;font-size:14px}
tr:last-child td{border-bottom:0}tr.hot{background:var(--hot)}
.n{color:var(--mut);width:32px}.s{font-weight:600;font-variant-numeric:tabular-nums}.neg{color:var(--neg)}
a{color:#0a7d4a;text-decoration:none;font-weight:500}a:hover{text-decoration:underline}
.sub{display:block;color:var(--mut);font-size:12px;margin-top:2px}
.w,.o,.c{display:inline-block;margin-left:5px;padding:1px 6px;border-radius:3px;font-size:11px}
.call{font-size:11px;font-weight:700;letter-spacing:.03em;white-space:nowrap}
.call.STRONGBUY{color:#0a7d4a}.call.BUY{color:#2a7d0a}.call.CHECK{color:#8a6d3b}.call.PASS,.call.FAIR{color:#9a9a9a}
.w{background:#fdf6e3;color:var(--warn)}.o{background:#e8e8e8;color:#555}.c{background:#e6f0ff;color:#2a5a9a}
</style><div class="wrap">
<h1>PSA 10 NFL autograph sweep</h1>
<div class="meta">${esc(p.generated)} &middot; ${p.counts.input} listings &middot; ${p.values.fromYou} values from you, ${p.values.fromMarket} inferred &middot; FX ${p.fx.usdToAud.toFixed(4)}</div>
${p.placeholderData ? '<div class="banner"><strong>Placeholder data.</strong> Values here are invented for testing.</div>' : ''}

<h2>Shortlist <span>&mdash; ${p.counts.buys} priced, ${p.counts.shouts || 0} worth acting on</span></h2>
<table><tr><th>Call</th><th>The take</th><th>Landed</th><th>Gap</th></tr>${buyRows}</table>

<h2>Worth a look <span>&mdash; no value on file, ${p.counts.look} of them</span></h2>
<table><tr><th></th><th colspan="2">Landed</th><th>Card</th><th colspan="2">Why unpriced</th><th>Seller</th></tr>${lookRows}</table>

<h2>Ignored <span>&mdash; ${p.counts.ignored} failed a gate</span></h2>
<table>${p.ignored.map((d) => `<tr><td class="sub" style="width:260px">${esc(d.dropped)}</td><td class="sub">${esc(d.title)}</td></tr>`).join('')}</table>
</div>`;
}
