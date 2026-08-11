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
  // Print run belongs in the name. A /25 and a base card out of the same set
  // are different assets, and on the cards that cannot be valued at all it is
  // often the only hard fact the email has to offer.
  const serial = r.serialOf === 1 ? '1/1' : r.serialOf > 0 ? `/${r.serialOf}` : null;
  return [r.year, titleCase(set), parallel ? titleCase(parallel) : null, serial, 'auto']
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
  /**
   * Same normalisation the conviction lookup uses, and for the same reason.
   * The Sleeper index stores men without a suffix while sellers type them with
   * one, so "Marvin Harrison Jr." and "Marvin Harrison" are two keys for one
   * man. Plain lowercasing let the one-card-per-player sections show him twice
   * and spend two slots on it.
   */
  const name = (r) => String(r.player || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[.'`]/g, '').replace(/\s+(jr|sr|ii|iii|iv|v)$/i, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();
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

  /**
   * Cap first, then exclude.
   *
   * This order matters and getting it wrong cost a real card. The exclusion
   * set used to be built from the uncapped act and also lists, which are then
   * sliced to maxPerEmail. A named target sitting at act position 11 was
   * therefore excluded from the targets section for being "already shown",
   * cut from act by the slice, displayed nowhere, and marked as emailed. The
   * one card the whole feature exists to surface was the one it swallowed.
   *
   * Building the set from what is actually rendered means a card cut by one
   * section's cap falls through to the next section it qualifies for.
   */
  /**
   * Both deal sections are gated on the DEAL reason, not on the call alone.
   *
   * They used to select on verdict.shout, which is computed from the call and
   * knows nothing about whether dealing is switched on. With DEAL off, a
   * STRONG BUY of a player nobody named still landed in act and was rendered,
   * while notify built its sent-list from rows that carry a reason. Shown but
   * never marked means emailed again on every single scan, forever.
   *
   * Selecting on the reason keeps the two in step: switch DEAL off in config
   * and these sections empty out, which is the whole intent.
   */
  const act = bestPerPlayer(rows.filter((r) => has(r, 'DEAL') && r.verdict?.shout).sort(byCall))
    .slice(0, A.maxPerEmail);
  const actNames = new Set(act.map(name));
  const also = bestPerPlayer(
    rows.filter((r) => has(r, 'DEAL') && !r.verdict?.shout && r.verdict?.call === 'BUY'
      && !actNames.has(name(r)))
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
  ).slice(0, Math.max(0, Math.min(5, A.maxPerEmail - act.length)));

  const shown = new Set([...act, ...also].map((r) => r.itemId));

  // Named men the parser could not read. Their own section because they carry
  // no call and no price, so they cannot sit next to cards that do.
  const unread = rows.filter((r) => r.verdict?.unread && !shown.has(r.itemId)).slice(0, A.maxTargets);
  unread.forEach((r) => shown.add(r.itemId));

  /**
   * Named targets are NOT collapsed to one card per player. There are two of
   * them and Ryan asked to see every listing, so three different Burden autos
   * are three things to look at, not spam. Best call first.
   */
  // Primaries above secondaries, then best call first inside each. Conviction
  // orders the email; it does not decide what is in it.
  const targets = rows
    .filter((r) => has(r, 'TARGET') && !shown.has(r.itemId))
    .sort((a, b) => (b.conviction ?? 1) - (a.conviction ?? 1) || byCall(a, b))
    .slice(0, A.maxTargets);
  targets.forEach((r) => shown.add(r.itemId));

  /**
   * Best player first, not cheapest first.
   *
   * Sorting by price put the eight cheapest cards in the sweep at the top,
   * and with no discount test the cheapest first-or-second-year PSA 10 autos
   * are by definition the men nobody rates. The section read as a junk drawer.
   * Ranking by dynasty standing means that if the cap does bite, what it drops
   * is the least interesting rather than the least cheap.
   */
  const profile = bestPerPlayer(
    rows.filter((r) => has(r, 'PROFILE') && !shown.has(r.itemId))
      .sort((a, b) => (a.dynRank ?? 1e9) - (b.dynRank ?? 1e9)
        || (a.landedAud ?? 1e9) - (b.landedAud ?? 1e9))
  ).slice(0, A.maxProfile);

  return { act, also, targets, profile, unread };
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
  if (!(comp > 0) || !(landed > 0)) return '';

  /**
   * Over-market cards reach the email now, and the bar was only ever asked to
   * draw a bargain. Clamped at 100%, a card 125% over the going rate rendered
   * as a completely full bar in the STRONG BUY green: the worse the deal, the
   * better it looked. Above the comp the bar flips to red and fills, which
   * reads as "past the line" rather than "maximum value".
   */
  const over = landed > comp;
  const colour = over ? '#b04a4a' : '#0a7d4a';
  const paid = Math.max(6, Math.min(100, Math.round((landed / comp) * 100)));
  const rest = 100 - paid;
  return `<table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;margin:2px 0 8px">
<tr>
  <td width="${paid}%" style="height:9px;background:${colour};border-radius:5px 0 0 5px;font-size:0;line-height:0">&nbsp;</td>
  ${rest > 0 ? `<td width="${rest}%" style="height:9px;background:#e6e4df;border-radius:0 5px 5px 0;font-size:0;line-height:0">&nbsp;</td>` : ''}
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

/**
 * Ordered by how much the run deserves interrupting for, strongest first.
 *
 * The targets branch used to sit above both act branches, which meant one
 * Burden listing the tool rated PASS took the subject line off ten STRONG
 * BUYs. A named man merely being listed is the weakest thing in the email, not
 * the strongest, so it now sits below the deals and above nothing else.
 */
function subject({ act, also, targets: named = [], profile = [], unread = [] }) {
  if (!act.length && !also.length && !named.length && !profile.length && !unread.length) {
    return 'Nothing worth flagging';
  }

  const targetsInAct = act.filter((r) => (r.verdict?.tags || []).includes('TARGET'));
  if (targetsInAct.length) {
    const t = targetsInAct[0];
    return `${t.player} at ${vsMarket(t.edge)}, one of yours`;
  }
  if (act.length === 1) {
    const r = act[0];
    return `${r.player}, ${vsMarket(r.edge)} - ${r.verdict.call.toLowerCase()}`;
  }
  if (act.length) {
    const best = act[0];
    return `${act.length} to look at, best is ${best.player} at ${vsMarket(best.edge)}`;
  }
  if (also.length) return `${also.length} solid buy${also.length === 1 ? '' : 's'}, nothing urgent`;

  // One of your men is listed and the price is nothing special. Count PEOPLE,
  // not listings: the targets bucket deliberately holds every card, so six
  // Burden autos were reading as "6 of your guys" when he has named two.
  if (named.length) {
    const men = [...new Set(named.map((r) => String(r.player || '')))];
    const cheapest = named.map((r) => r.landedAud).filter((n) => n > 0);
    if (men.length > 1) {
      return cheapest.length
        ? `${men.length} of your guys listed, from ${money(Math.min(...cheapest))}`
        : `${men.length} of your guys listed`;
    }
    const one = named[0];
    if (named.length > 1) {
      return cheapest.length
        ? `${named.length} ${men[0]} cards listed, from ${money(Math.min(...cheapest))}`
        : `${named.length} ${men[0]} cards listed`;
    }
    return one.landedAud > 0
      ? `${men[0]} listed at ${money(one.landedAud)} landed`
      : `${men[0]} is listed`;
  }

  if (profile.length) {
    return `${profile.length} young PSA 10 auto${profile.length === 1 ? '' : 's'} asking under $${CFG.alert.reasons.profile.maxAskUsd} USD`;
  }

  const unreadMen = [...new Set(unread.map((r) => String(r.player || 'one of yours')))];
  return unreadMen.length === 1
    ? `${unreadMen[0]} listed, but the title beat the parser`
    : `${unreadMen.length} of your guys listed, titles the parser could not read`;
}

/* ---------- render ---------- */

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function buildAlert(selection, { placeholder = false, trimmed = 0 } = {}) {
  const { act = [], also = [], targets = [], profile = [], unread = [] } = selection;
  const P = CFG.alert.reasons.profile;

  // Said plainly, because these two sections are not claims that the card is
  // cheap. One is "he is listed", the other is "this is your shape of card".
  const targetsWhy = 'Listed now, whatever the price. You asked to hear about these every time.';
  const profileWhy = `First and second year, PSA 10, asking under $${P.maxAskUsd} USD before postage. Not judged on discount.`;

  /**
   * The old strapline said every card below was under what comparable cards
   * ask. That was true while only buys were emailed. Targets and profile cards
   * arrive at any call, so on a run carrying either, the sentence was a claim
   * the email itself disproved two inches further down.
   */
  const unreadWhy = 'One of your men by name, but the title did not give up enough to price the card.';

  // Title and link only. No call, no price, because there is neither, and a
  // row that looks like the others would imply the tool has an opinion.
  const unreadHtml = (r) => `<div style="padding:9px 11px;margin-bottom:6px;background:#ffffff;border:1px solid #e5e3df;border-radius:6px">
<div style="font-size:13px;font-weight:600;color:#1a1a1a;margin-bottom:2px">${esc(r.player || 'One of yours')}</div>
<div style="font-size:12px;color:#7a7a7a;line-height:1.4;margin-bottom:5px">${esc(String(r.title || '').slice(0, 150))}</div>
<a href="${esc(r.url || '')}" style="font-size:12px;color:#0a7d4a;text-decoration:none;font-weight:600">Look at it on eBay &rarr;</a>
</div>`;
  const unreadText = (r) => `${r.player || 'One of yours'}\n${String(r.title || '').slice(0, 150)}\n${r.url || ''}`;

  // Says PSA 10 rather than "PSA 10 and 9" because a 9 no longer earns an
  // email. If reasons.deal is ever switched back on, the first line applies
  // again and 9s come with it.
  const grades = CFG.alert.reasons.deal.enabled ? 'PSA 10 and 9' : 'PSA 10';
  const onlyDeals = !targets.length && !profile.length && !unread.length;
  const strapline = onlyDeals
    ? `${grades} NFL autos, landed in Australia, under what comparable cards ask`
    : `${grades} autographs of your players, landed in Australia. Not all of these are cheap, see each call.`;

  // Counts men, not listings. The targets bucket holds one row per card.
  const namedMen = [...new Set(targets.map((r) => String(r.player || '')))];
  const unreadMen = [...new Set(unread.map((r) => String(r.player || '')))];
  const headline = act.length ? `${act.length} worth acting on`
    : namedMen.length ? `${namedMen.length} of your guys listed`
    : profile.length ? `${profile.length} fit your profile`
    : unreadMen.length ? `${unreadMen.length} of your guys, unreadable titles`
    : 'Nothing urgent';

  // Cards that cleared the bar but did not fit. Said out loud rather than
  // silently dropped, because on a first run the backlog can be large and
  // you should know the email is a top slice, not the whole answer.
  const more = trimmed > 0
    // Says "will not come round again" rather than the old "they are in the
    // full report". Both halves of that were false on a scheduled run:
    // report.html is capped at 250 rows sorted by call, so the weak-call cards
    // that get trimmed here are exactly the ones it does not keep, and a
    // scheduled run does not publish the report anywhere Ryan can read it.
    // Every trimmed card is marked as emailed, so this is the only notice.
    ? `${trimmed} more cleared the bar but did not fit this email, and will not come round again. If this number is large the bar is too loose, not the cap too small.`
    : '';

  const text = [
    placeholder ? 'TEST RUN. Figures below are estimates from comparable listings.\n' : '',
    act.length ? 'WORTH ACTING ON\n\n' + act.map(cardText).join('\n\n') : '',
    also.length ? '\n\nALSO SOLID\n\n' + also.map(cardText).join('\n\n') : '',
    targets.length ? `\n\nYOUR TARGETS\n${targetsWhy}\n\n` + targets.map(cardText).join('\n\n') : '',
    profile.length ? `\n\nFITS YOUR PROFILE\n${profileWhy}\n\n` + profile.map(cardText).join('\n\n') : '',
    unread.length ? `\n\nCOULD NOT READ THESE\n${unreadWhy}\n\n` + unread.map(unreadText).join('\n\n') : '',
    more ? '\n\n' + more : '',
    '\n\nValues are estimated from comparable cards in the same scan, not confirmed sales.',
  ].filter(Boolean).join('\n');

  const heading = (t, why) => `<div style="margin:18px 0 10px">
<div style="font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:#8a8a8a;font-weight:700">${esc(t)}</div>
${why ? `<div style="font-size:12px;color:#9a9a9a;margin-top:3px">${esc(why)}</div>` : ''}
</div>`;

  const html = `<div style="background:#f6f5f2;padding:20px 12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif">
<table cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:600px;margin:0 auto"><tr><td>

<div style="font-size:20px;font-weight:700;color:#1a1a1a;margin-bottom:2px">${esc(headline)}</div>
<div style="font-size:13px;color:#7a7a7a;margin-bottom:6px">${esc(strapline)}</div>
${placeholder ? '<div style="background:#fff4e5;border:1px solid #f0d9b5;padding:9px 11px;border-radius:6px;font-size:12px;margin:10px 0">Test run.</div>' : ''}

${act.length ? heading('Worth acting on') + act.map(cardHtml).join('') : ''}
${also.length ? heading('Also solid') + also.map(cardHtml).join('') : ''}
${targets.length ? heading('Your targets', targetsWhy) + targets.map(cardHtml).join('') : ''}
${profile.length ? heading('Fits your profile', profileWhy) + profile.map(cardHtml).join('') : ''}
${unread.length ? heading('Could not read these', unreadWhy) + unread.map(unreadHtml).join('') : ''}
${more ? `<div style="font-size:12px;color:#7a7a7a;background:#eceae6;border-radius:6px;padding:10px 12px;margin-top:12px">${esc(more)}</div>` : ''}

<div style="font-size:11px;color:#9a9a9a;line-height:1.5;margin-top:16px;padding-top:12px;border-top:1px solid #e0ded9">
Prices are landed in AUD including postage, GST and import charges. Values are estimated from comparable cards in the same scan, not from confirmed sold prices. A shortlist, not an appraisal.
</div>

</td></tr></table></div>`;

  return { subject: (placeholder ? '[TEST] ' : '') + subject(selection), text, html };
}

module.exports = { buildAlert, selectAlerts, describe, describePlayer, subject, isYoung };
