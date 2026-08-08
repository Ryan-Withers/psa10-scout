/**
 * Sends the alert email and remembers what it has already sent.
 *
 * The memory is the whole point. A good listing sits on eBay for days, so a
 * scan that runs every 20 minutes will find the same card 200 times. Without
 * a record of what has gone out, the first genuinely good find turns into 200
 * identical emails and you stop reading them, which defeats the tool.
 *
 * Two design notes:
 *
 *   The record is only written when Resend confirms the send. If the email
 *   fails and we marked the cards anyway, one transient outage would
 *   permanently swallow the best find of the week.
 *
 *   Recipient and sender come from the environment first, config second, so
 *   a personal email address does not have to sit in a committed file.
 */

const fs = require('fs');
const path = require('path');
const CFG = require('./config');
const { buildAlert, selectAlerts } = require('./alert');
const { RANK } = require('./verdict');

const SENT_FILE = 'data/alerted.json';

// Roughly how long a listing stays findable. Anything older than this is
// dropped from the record: if a card is still listed after three months, a
// fresh reminder is fair, and the file should not grow forever.
const REMEMBER_DAYS = 90;

// The bar for being worth an email at all. Kept in step with selectAlerts,
// which picks from exactly this population.
//
// verdict.reasons is the single definition of that bar: a named target at any
// call, a good deal, or a card fitting the profile. Restating it as a
// threshold here is how the two drift apart, so this just asks whether the
// card has a reason at all.
const worthEmailing = (r) => (r.verdict?.reasons || []).length > 0;

/**
 * Which rows the notifier should even look at.
 *
 * Priced rows always. Unpriced ones only when they carry a reason: a named
 * target the tool could not value is the card Ryan most needs to eyeball
 * himself, and a profile card is judged on age, grade and asking price and
 * needs no valuation at all. Everything else in the unpriced pile is a report,
 * not an alert.
 *
 * Lives here rather than inline in run.js so it can be tested. Inline, it was
 * deletable without a single assertion noticing.
 */
const alertPopulation = (priced = [], unpriced = []) =>
  [...priced, ...unpriced.filter(worthEmailing)];

/* ---------- the record of what has been sent ---------- */

/**
 * Shape is { itemId: { at, call } }. The call matters as much as the date.
 *
 * A card emailed as a BUY that later drops in price and becomes a STRONG BUY
 * is genuinely new information and should come round again. A card emailed as
 * a STRONG BUY that stays a STRONG BUY is not.
 */
function loadSent(file = SENT_FILE) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, file), 'utf8'));
    if (Array.isArray(raw)) {
      // Oldest shape: a bare list of ids, no date and no call.
      return Object.fromEntries(raw.map((id) => [id, { at: Date.now(), call: 'STRONG BUY' }]));
    }
    if (!raw || typeof raw !== 'object') return {};
    return Object.fromEntries(Object.entries(raw).map(([id, v]) =>
      // Middle shape: a bare timestamp.
      [id, typeof v === 'number' ? { at: v, call: 'STRONG BUY' } : v]));
  } catch {
    return {};
  }
}

function saveSent(sent, file = SENT_FILE) {
  const cutoff = Date.now() - REMEMBER_DAYS * 86400000;
  const kept = Object.fromEntries(Object.entries(sent).filter(([, v]) => (v?.at ?? 0) > cutoff));
  fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, file), JSON.stringify(kept));
  return kept;
}

// Never emailed, or the call has improved since it was.
function isNews(r, sent) {
  const prev = sent[r.itemId];
  if (!prev) return true;
  return (RANK[r.verdict?.call] ?? 9) < (RANK[prev.call] ?? 9);
}

/* ---------- sending ---------- */

async function sendViaResend({ apiKey, from, to, subject, html, text }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [to], subject, html, text }),
    signal: AbortSignal.timeout(20000),
  });
  const body = await res.text().catch(() => '');
  if (!res.ok) throw new Error(`resend ${res.status}: ${body.slice(0, 300)}`);
  return body;
}

/**
 * @param buys      scored rows that carry a verdict, best first
 * @param opts.placeholder  true when running on invented data
 * @returns a short summary of what happened, for the console
 */
async function notify(buys, { placeholder = false, dryRun = false } = {}) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.ALERT_FROM || CFG.alert.from;
  const to = process.env.ALERT_TO || CFG.alert.to;

  const sent = loadSent();
  const news = buys.filter((r) => isNews(r, sent));

  /**
   * Everything that cleared the bar, not just what fits in one email.
   *
   * This distinction was a bug worth catching. The email is capped at ten
   * cards, and marking only those ten as sent turned the cap into a queue:
   * the next scan an hour later found the eleventh through fifteenth still
   * unsent and mailed those, and so on down a list of 1,281 priced listings.
   * The cap exists to keep one email readable. It is not a drip feed.
   */
  const candidates = news.filter(worthEmailing);
  const selection = selectAlerts(news);
  const shown = [...selection.act, ...selection.also, ...selection.targets, ...selection.profile];

  if (!shown.length) {
    return { sent: 0, reason: news.length ? 'nothing met the bar' : 'nothing new since last scan' };
  }

  const trimmed = candidates.length - shown.length;
  const mail = buildAlert(selection, { placeholder, trimmed });

  if (dryRun) {
    fs.writeFileSync(path.join(__dirname, 'alert-preview.html'), mail.html);
    return { sent: 0, would: shown.length, trimmed, subject: mail.subject, reason: 'dry run, wrote alert-preview.html' };
  }

  if (!apiKey) {
    return { sent: 0, would: shown.length, trimmed, subject: mail.subject, reason: 'no RESEND_API_KEY set' };
  }
  // config.js ships an empty recipient on purpose, so this is the normal way
  // a missing ALERT_TO shows up. Say so plainly rather than letting Resend
  // return a 422 that reads like a broken key.
  if (!to) {
    return { sent: 0, would: shown.length, trimmed, subject: mail.subject, reason: 'no ALERT_TO set' };
  }

  await sendViaResend({ apiKey, from, to, ...mail });

  // Only now, once the send is confirmed. A transient Resend failure should
  // cost one email, not permanently bury the best card of the week.
  const now = Date.now();
  for (const r of candidates) sent[r.itemId] = { at: now, call: r.verdict?.call || 'BUY' };
  saveSent(sent);

  return {
    sent: shown.length, trimmed, subject: mail.subject, to,
    act: selection.act.length, also: selection.also.length,
    targets: selection.targets.length, profile: selection.profile.length,
  };
}

module.exports = { notify, loadSent, saveSent, alertPopulation, worthEmailing, SENT_FILE };
