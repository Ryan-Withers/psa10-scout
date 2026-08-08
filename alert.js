/**
 * Turns scored listings into an email.
 *
 * Ryan wants two things and they have different bars:
 *
 *   1. Rookies, second and third year players. Low bar, these are the hunt.
 *   2. Genuine bargains at any age. High bar, the discount has to be real.
 *
 * Tone: plain sentences, but the numbers stay in. "This costs $318 and we
 * think that is about 20% under market" rather than either a bare score or
 * a chatty note with no figures.
 *
 * Builds the message only. notify.js decides what is new and sends it.
 */

const CFG = require('./config');
const { byCall } = require('./verdict');

/* Email-safe visuals only: tables, divs and inline styles. Gmail strips
 * <style> blocks and SVG, and Outlook ignores flexbox, so every bar and
 * badge below is built from table cells with background colours. */

const ORDINAL = ['rookie', '2nd year', '3rd year', '4th year', '5th year',
  '6th year', '7th year', '8th year', '9th year'];

function describePlayer(r) {
  const exp = r.exp ?? null;
  const pos = r.pos || 'player';
  if (exp === 0) return `rookie ${pos}`;
  if (exp != null && exp < ORDINAL.length) return `${ORDINAL[exp]} ${pos}`;
  if (exp != null && exp >= 10) return `veteran ${pos}`;
  return pos;
}

const isYoung = (r) => r.exp != null && r.exp <= CFG.alert.youngMaxExp;
const pct = (n) => Math.round(n * 100) + '%';

/**
 * "12% under" or "9% over", never "-9% under".
 *
 * Only buys used to reach the email, so edge was always positive and the word
 * "under" could be hardcoded next to it. Named targets and profile cards now
 * arrive at any call, including ones priced above the market.
 */
const vsMarket = (edge) => (edge < 0 ? `${pct(-edge)} over` : `${pct(edge)} under`);
const money = (n) => '$' + Math.round(Number(n));
const titleCase = (s) => String(s || '').replace(/\b[a-z]/g, (c) => c.toUpperCase());

function cardName(r) {
  const set = String(r.set || '').toLowerCase();
  const setWords = new Set(set.split(/\s+/));
  // The set name leaks into the parallel because the products are named that
  // way. Without stripping the overlap this reads "Prizm Prizm Silver".
  const parallel = String(r.parallel || '')
    .split(/\s+/).filter((w) => w && !setWords.has(w.toLowerCase())).join(' ');
  return [r.year, titleCase(set), parallel ? titleCase(parallel) : null, 'auto']
    .filter(Boolean).join(' ');
}

/* ---------- selection ---------- */

/**
 * Splits the priced rows into the two things Ryan asked to hear about.
 * A card meeting both bars lands in young and is flagged, so nothing is
 * reported twice.
 */
/**
 * The verdict decides what gets emailed, not a threshold on edge.
 *
 *   act       things worth shouting about: a strong call, or one of your named
 *             targets at a buy or better
 *   also      solid buys that do not warrant an interruption on their own
 *   targets   your named men at any call, including the ones the tool rates
 *             badly and the ones it could not value
 *   profile   first or second year, PSA 10, under the asking ceiling
 *
 * Selecting on the verdict rather than on raw discount is what stopped the
 * email filling up with cheap cards of players nobody rates.
 *
 * Sections are exclusive and in that order, so a card appears once, under the
 * strongest reason it qualifies on. Its other reasons still show on the row.
 */
function selectAlerts(rows) {
  const A = CFG.alert;
  const name = (r) => String(r.player || '').toLowerCase();
  const has = (r, reason) => (r.verdict?.reasons || []).includes(reason);

  // One card per player. Three Zay Flowers cards in a row reads like spam
  // and buries the other nine names. Best card for each man, then move on.
  const bestPerPlayer = (list) => {
    const seen = new Set();
    return list.filter((r) => {
      const k = name(r);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };

  const act = bestPerPlayer(rows.filter((r) => r.verdict?.shout).sort(byCall));
  const actNames = new Set(act.map(name));
  const also = bestPerPlayer(
    rows.filter((r) => !r.verdict?.shout && r.verdict?.call === 'BUY' && !actNames.has(name(r)))
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
  );

  const shown = new Set([...act, ...also].map((r) => r.itemId));

  /**
   * Named targets are NOT collapsed to one card per player. There are two of
   * them and Ryan asked to see every listing, so three different Burden autos
   * are three things to look at, not spam. Best call first.
   */
  const targets = rows
    .filter((r) => has(r, 'TARGET') && !shown.has(r.itemId))
    .sort(byCall);
  targets.forEach((r) => shown.add(r.itemId));

  const profile = bestPerPlayer(
    rows.filter((r) => has(r, 'PROFILE') && !shown.has(r.itemId))
      .sort((a, b) => (a.landedAud ?? 1e9) - (b.landedAud ?? 1e9))
  );

  return {
    act: act.slice(0, A.maxPerEmail),
    also: also.slice(0, Math.max(0, A.maxPerEmail - Math.min(act.length, A.maxPerEmail))).slice(0, 5),
    targets: targets.slice(0, A.maxTargets),
    profile: profile.slice(0, A.maxProfile),
  };
}

/* ---------- one card ---------- */

const CALL_COLOUR = {
  'STRONG BUY': { fg: '#ffffff', bg: '#0a7d4a' },
  'BUY':        { fg: '#ffffff', bg: '#3f8f5c' },
  'CHECK':      { fg: '#ffffff', bg: '#b07d2a' },
  'WATCH':      { fg: '#3a3a3a', bg: '#e0ded9' },
  // Named targets and profile cards appear at any call, so the weak ones need
  // their own colour. Showing a PASS in the WATCH grey would read as a softer
  // call than it is.
  'FAIR':       { fg: '#3a3a3a', bg: '#e0ded9' },
  'PASS':       { fg: '#6a6a6a', bg: '#ebe9e5' },
  'SKIP':       { fg: '#6a6a6a', bg: '#ebe9e5' },
};

/**
 * The price bar. Two table cells: what you pay, and the rest of what the
 * market wants. Reading it takes no effort, which is the whole point.
 */
function priceBar(landed, comp) {
  if (!(comp > 0)) return '';
  const paid = Math.max(6, Math.min(100, Math.round((landed / comp) * 100)));
  const rest = 100 - paid;
  return `<table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;margin:2px 0 8px">
<tr>
  <td width="${paid}%" style="height:9px;background:#0a7d4a;border-radius:5px 0 0 5px;font-size:0;line-height:0">&nbsp;</td>
  <td width="${rest}%" style="height:9px;background:#e6e4df;border-radius:0 5px 5px 0;font-size:0;line-height:0">&nbsp;</td>
</tr></table>`;
}

// Dynasty trend as a compact arrow rather than a number nobody reads.
function trendChip(r) {
  const t = r.dynTrend30 ?? 0;
  if (r.dynRank == null) return '';
  const up = t >= 100, down = t <= -100;
  const c = up ? '#0a7d4a' : down ? '#b04a4a' : '#8a8a8a';
  const arrow = up ? '&#9650;' : down ? '&#9660;' : '&#9679;';
  return `<span style="color:${c};font-size:11px;font-weight:600">${arrow} #${r.dynRank}</span>`;
}

function chip(text, bg = '#eceae6', fg = '#4a4a4a') {
  return `<span style="display:inline-block;background:${bg};color:${fg};font-size:10px;font-weight:600;letter-spacing:.03em;padding:2px 6px;border-radius:3px;margin:0 4px 3px 0">${esc(text)}</span>`;
}

function cardHtml(r) {
  const v = r.verdict || {};
  const c = CALL_COLOUR[v.call] || CALL_COLOUR.WATCH;
  const strong = v.call === 'STRONG BUY';
  const gradeChip = (r.grade ?? 10) === 9
    ? chip('PSA 9', '#f4e6d0', '#8a5a1a')
    : chip('PSA 10', '#dcefe2', '#0a6b40');

  const img = r.image
    ? `<td width="78" valign="top" style="padding-right:12px">
         <img src="${esc(r.image)}" width="78" alt="" style="display:block;width:78px;border-radius:4px;border:1px solid #e0ded9">
       </td>`
    : '';

  return `<table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:separate;margin-bottom:14px;background:${strong ? '#f4faf6' : '#ffffff'};border:1px solid ${strong ? '#bcd9c4' : '#e5e3df'};border-radius:8px">
<tr><td style="padding:14px">
  <table cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
    ${img}
    <td valign="top">

      <div style="margin-bottom:7px">
        <span style="display:inline-block;background:${c.bg};color:${c.fg};font-size:11px;font-weight:700;letter-spacing:.05em;padding:3px 8px;border-radius:3px">${esc(v.call || '')}</span>
        <span style="font-size:13px;color:#5a5a5a;margin-left:8px">${esc(v.hook || '')}</span>
      </div>

      <div style="font-size:18px;font-weight:700;line-height:1.25;margin-bottom:2px">${esc(r.player)}</div>
      <div style="font-size:12px;color:#6b6b6b;margin-bottom:8px">
        ${esc(describePlayer(r))} ${trendChip(r)} &nbsp;&middot;&nbsp; ${esc(cardName(r))}
      </div>

      <div style="font-size:13px;color:#3a3a3a;margin-bottom:3px">
        <b style="font-size:20px;color:#1a1a1a">${money(r.landedAud)}</b>
        <span style="color:#6b6b6b"> landed</span>
        ${r.compAud && Number.isFinite(r.edge) ? `<span style="color:${r.edge < 0 ? '#b04a4a' : '#0a7d4a'};font-weight:700;margin-left:8px">${vsMarket(r.edge)}</span>
        <span style="color:#9a9a9a">&nbsp;these go for ${money(r.compAud)}</span>` : ''}
      </div>
      ${priceBar(r.landedAud, r.compAud)}

      <div style="margin-bottom:9px">${gradeChip}${(v.tags || []).filter((t) => t !== 'PSA 9').map((t) => chip(t, t === 'TARGET' ? '#e6f0ff' : '#eceae6', t === 'TARGET' ? '#2a5a9a' : '#4a4a4a')).join('')}</div>

      <a href="${esc(r.url)}" style="display:inline-block;background:${strong ? '#0a7d4a' : '#ffffff'};color:${strong ? '#ffffff' : '#0a7d4a'};border:1px solid #0a7d4a;font-size:13px;font-weight:600;text-decoration:none;padding:7px 14px;border-radius:5px">View on eBay &rarr;</a>

    </td>
  </tr></table>
</td></tr></table>`;
}

function cardText(r) {
  const v = r.verdict || {};
  return `${v.call}${(v.tags || []).length ? '  [' + v.tags.join(' ') + ']' : ''}\n${v.hook}\n${r.player} - ${cardName(r)}\n${money(r.landedAud)} landed${r.compAud && Number.isFinite(r.edge) ? `, ${vsMarket(r.edge)} the ${money(r.compAud)} these go for` : ''}\n${r.url}`;
}

/* ---------- selection helpers ---------- */

function describe(r) {
  const v = r.verdict || {};
  return { call: v.call || '', tags: v.tags || [], hook: v.hook || '', take: v.take || '', url: r.url };
}

/* ---------- subject ---------- */

function subject({ act, also, targets: named = [], profile = [] }) {
  if (!act.length && !also.length && !named.length && !profile.length) return 'Nothing worth flagging';
  const targets = act.filter((r) => (r.verdict?.tags || []).includes('TARGET'));
  if (targets.length) {
    const t = targets[0];
    return `${t.player} at ${vsMarket(t.edge)}, one of yours`;
  }
  // One of your men is listed, even though the price is nothing special. Say
  // whose and what it costs rather than implying a bargain.
  if (named.length) {
    const t = named[0];
    const cheapest = named.map((r) => r.landedAud).filter((n) => n > 0);
    if (named.length > 1 && cheapest.length) return `${named.length} of your guys listed, from ${money(Math.min(...cheapest))}`;
    return t.landedAud > 0
      ? `${t.player} listed at ${money(t.landedAud)} landed`
      : `${t.player} is listed`;
  }
  if (act.length === 1) {
    const r = act[0];
    return `${r.player}, ${vsMarket(r.edge)} - ${r.verdict.call.toLowerCase()}`;
  }
  if (act.length) {
    const best = act[0];
    return `${act.length} to look at, best is ${best.player} at ${vsMarket(best.edge)}`;
  }
  if (also.length) return `${also.length} solid buys, nothing urgent`;
  return `${profile.length} young PSA 10 auto${profile.length === 1 ? '' : 's'} under $${CFG.alert.reasons.profile.maxAskUsd}`;
}

/* ---------- render ---------- */

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function buildAlert(selection, { placeholder = false, trimmed = 0 } = {}) {
  const { act = [], also = [], targets = [], profile = [] } = selection;
  const P = CFG.alert.reasons.profile;

  // Said plainly, because these two sections are not claims that the card is
  // cheap. One is "he is listed", the other is "this is your shape of card".
  const targetsWhy = 'Listed now, whatever the price. You asked to hear about these every time.';
  const profileWhy = `First and second year, PSA 10, asking under $${P.maxAskUsd} USD. Not judged on discount.`;

  // Cards that cleared the bar but did not fit. Said out loud rather than
  // silently dropped, because on a first run the backlog can be large and
  // you should know the email is a top slice, not the whole answer.
  const more = trimmed > 0
    ? `${trimmed} more cleared the bar but did not fit. They are in the full report.`
    : '';

  const text = [
    placeholder ? 'TEST RUN. Figures below are estimates from comparable listings.\n' : '',
    act.length ? 'WORTH ACTING ON\n\n' + act.map(cardText).join('\n\n') : '',
    also.length ? '\n\nALSO SOLID\n\n' + also.map(cardText).join('\n\n') : '',
    targets.length ? `\n\nYOUR TARGETS\n${targetsWhy}\n\n` + targets.map(cardText).join('\n\n') : '',
    profile.length ? `\n\nFITS YOUR PROFILE\n${profileWhy}\n\n` + profile.map(cardText).join('\n\n') : '',
    more ? '\n\n' + more : '',
    '\n\nValues are estimated from comparable cards in the same scan, not confirmed sales.',
  ].filter(Boolean).join('\n');

  const heading = (t, why) => `<div style="margin:18px 0 10px">
<div style="font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:#8a8a8a;font-weight:700">${esc(t)}</div>
${why ? `<div style="font-size:12px;color:#9a9a9a;margin-top:3px">${esc(why)}</div>` : ''}
</div>`;

  const html = `<div style="background:#f6f5f2;padding:20px 12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif">
<table cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:600px;margin:0 auto"><tr><td>

<div style="font-size:20px;font-weight:700;color:#1a1a1a;margin-bottom:2px">${act.length
  ? `${act.length} worth acting on`
  : (targets.length ? `${targets.length} of your guys listed` : 'Nothing urgent')}</div>
<div style="font-size:13px;color:#7a7a7a;margin-bottom:6px">PSA 10 and 9 NFL autos, landed in Australia, under what comparable cards ask</div>
${placeholder ? '<div style="background:#fff4e5;border:1px solid #f0d9b5;padding:9px 11px;border-radius:6px;font-size:12px;margin:10px 0">Test run.</div>' : ''}

${act.length ? heading('Worth acting on') + act.map(cardHtml).join('') : ''}
${also.length ? heading('Also solid') + also.map(cardHtml).join('') : ''}
${targets.length ? heading('Your targets', targetsWhy) + targets.map(cardHtml).join('') : ''}
${profile.length ? heading('Fits your profile', profileWhy) + profile.map(cardHtml).join('') : ''}
${more ? `<div style="font-size:12px;color:#7a7a7a;background:#eceae6;border-radius:6px;padding:10px 12px;margin-top:12px">${esc(more)}</div>` : ''}

<div style="font-size:11px;color:#9a9a9a;line-height:1.5;margin-top:16px;padding-top:12px;border-top:1px solid #e0ded9">
Prices are landed in AUD including postage, GST and import charges. Values are estimated from comparable cards in the same scan, not from confirmed sold prices. A shortlist, not an appraisal.
</div>

</td></tr></table></div>`;

  return { subject: (placeholder ? '[TEST] ' : '') + subject(selection), text, html };
}

module.exports = { buildAlert, selectAlerts, describe, describePlayer, subject, isYoung };
