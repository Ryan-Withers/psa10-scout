/**
 * Parser regression corpus. Titles written to mirror how these actually list
 * on eBay: caps spam, emoji, missing years, colour surnames, suffix names,
 * competing slabs, and outright junk.
 *
 * Run: node test-parser.js
 *      node test-parser.js --low     (only sub-threshold, for eyeballing)
 */

require('./providers').loadPlayerIndexFromDisk();
const { parseTitle } = require('./parse');

const CORPUS = [
  // --- clean modern autos, should sail through ---
  "2023 Panini Prizm Bryce Young Rookie Autographs Silver Prizm #RA-BY PSA 10 GEM MT",
  "2024 Panini Select Jayden Daniels Rookie Signatures Blue #RS-JD PSA 10 AUTO",
  "2020 Panini Contenders Justin Herbert Rookie Ticket Auto #101 PSA 10 GEM MINT",
  "2023 Panini National Treasures C.J. Stroud Rookie Patch Autograph /99 #172 PSA 10",
  "2021 Panini Donruss Optic Ja'Marr Chase Rated Rookie Signatures Holo PSA 10 Auto",
  "2024 Panini Immaculate Marvin Harrison Jr. Rookie Patch Auto Gold /10 PSA 10",
  "2022 Panini Mosaic Brock Purdy Rookie Autographs Green Prizm #RA-BP PSA 10 GEM",

  // --- colour-surname traps: parallel vocab overlaps the player name ---
  "2011 Topps Chrome A.J. Green Rookie Autograph Refractor #150 PSA 10 GEM MT",
  "2019 Panini Prizm Marquise Brown Rookie Signature Silver PSA 10 Auto RC",
  "2016 Panini Contenders Michael Thomas Rookie Ticket Auto PSA 10 GEM MINT 10",
  "2021 Panini Select Amon-Ra St. Brown Rookie Signatures Red PSA 10 AUTO",
  "2018 Panini Prizm Josh Allen Rookie Auto Orange Prizm /249 PSA 10",

  // --- season format, accents, apostrophes ---
  "2023-24 Panini Prizm Draft Picks Xavier Worthy Auto Green #DP-XW PSA 10",
  "2022 Panini Origins Kenneth Walker III Rookie Jersey Autograph /49 PSA 10 GEM",
  "2024 Panini Phoenix Bo Nix Rookie Autographs Fire Burst PSA 10 Auto RC",

  // --- caps spam and seller noise, still valid ---
  "🔥 2023 PANINI PRIZM ANTHONY RICHARDSON ROOKIE AUTO SILVER PSA 10 GEM MINT 🔥 INVEST",
  "2020 PANINI CONTENDERS OPTIC JUSTIN JEFFERSON ROOKIE TICKET AUTO PSA 10 !!! MINT",
  "2024 Panini Absolute Caleb Williams RC Auto Kaboom PSA 10 Gem Mint 10 *HOT*",

  // --- serial numbering variants ---
  "2023 Panini Flawless Jordan Addison Rookie Patch Auto 1/1 PSA 10 GEM MT",
  "2022 Panini Immaculate Garrett Wilson RPA /25 PSA 10 Auto Rookie Patch",
  "2021 Panini Spectra Najee Harris Rookie Patch Autograph Gold 07/10 PSA 10",

  // --- older stock, thinner vocab coverage ---
  "1998 Playoff Contenders Peyton Manning Rookie Ticket Autograph PSA 10",
  "2005 Upper Deck SP Authentic Aaron Rodgers Rookie Auto #201 PSA 10 GEM MT",
  "2017 Panini Prizm Patrick Mahomes II Rookie Autograph PSA 10 Gem Mint",

  // --- should be REJECTED: junk ---
  "PSA 10 NFL Autograph Card Lot of 5 Rookie Autos Mixed Players GEM MINT",
  "2023 Panini Prizm Custom Bryce Young Auto Card PSA 10 Style Reprint",
  "NFL Card Break Random Team 2024 Panini National Treasures PSA 10 Auto Slot",
  "2023 Panini Prizm PSA 10 Auto Mystery Pack Repack Hot Pack Guaranteed Hit",
  "2024 Panini Select Rookie Auto PSA 10 - PICK YOUR CARD - Read Description",

  // --- should be REJECTED: wrong slab or no auto ---
  "2023 Panini Prizm Bryce Young Rookie Autograph BGS 10 Pristine Black Label",
  "2021 Panini Select Ja'Marr Chase Rookie Signatures SGC 10 GEM",
  "2020 Panini Prizm Justin Herbert Rookie Card Silver PSA 10 GEM MINT",
  "2024 Panini Donruss Caleb Williams Rated Rookie PSA 10 Base RC No Auto",

  // --- should be LOW CONFIDENCE: parser genuinely cannot resolve these ---
  "Panini Rookie Auto PSA 10 Gem Mint Football Card Investment Grade",
  "2023 Rookie Autograph PSA 10 Football Card Numbered Parallel Nice Card",
  "2022 Panini Prizm Tyreek Hill Autograph PSA 10 Signed Card WOW",
  "Autographed Football Card PSA 10 Gem Mint 10 Rare Low Pop Must See",
  "2024 Panini Zenith Jonathon Brooks Rookie Auto PSA 10 Some Extra Words Here Filler",

  // --- ambiguity: real colliding NFL names ---
  "2021 Panini Prizm Josh Johnson Autograph Silver PSA 10 Gem Mint",
  "2019 Panini Certified Chris Johnson Rookie Signature Blue PSA 10 Auto",
];

const rows = [];
let rejected = 0, low = 0, pass = 0;

for (const t of CORPUS) {
  const r = parseTitle(t);
  if (r.reject) rejected++;
  else if (r.ok) pass++;
  else low++;
  rows.push(r);
}

const onlyLow = process.argv.includes('--low');

function trunc(s, n) {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n);
}

console.log('='.repeat(120));
for (const r of rows) {
  if (onlyLow && (r.ok || r.reject)) continue;
  const tag = r.reject ? 'REJECT' : r.ok ? ` OK ${String(r.confidence).padStart(3)}` : `LOW ${String(r.confidence).padStart(3)}`;
  console.log(`${tag}  ${trunc(r.title, 78)}`);
  if (r.reject) { console.log(`        reason: ${r.reject}\n`); continue; }
  console.log(
    `        yr=${trunc(r.year, 5)} set=${trunc(r.set, 20)} ins=${trunc(r.insert, 22)} par=${trunc(r.parallel, 16)}`
  );
  console.log(
    `        player=${trunc(r.player, 22)} pos=${trunc(r.pos, 4)} debut=${trunc(r.debut, 5)} age=${trunc(r.age, 3)} n=${trunc(r.candidates, 2)} no=${trunc(r.cardNo, 9)} ser=${trunc(r.serial ? `${r.serial.num ?? ''}/${r.serial.of}` : '', 8)}`
  );
  if (r.blockers.length) console.log(`        blockers: ${r.blockers.join(', ')}`);
  if (r.warnings.length) console.log(`        warnings: ${r.warnings.join(', ')}`);
  if (r.residual.length) console.log(`        residual: ${r.residual.join(' ')}`);
  console.log('');
}

console.log('='.repeat(120));
console.log(`${CORPUS.length} titles: ${pass} scored (>=70), ${low} to review, ${rejected} rejected at the gate`);

/* field extraction rate across everything that got past the gate */
const scored = rows.filter((r) => !r.reject);
const fields = ['year', 'set', 'insert', 'parallel', 'player', 'cardNo', 'serial'];
console.log('\nfield fill rate on the ' + scored.length + ' non-rejected titles:');
for (const f of fields) {
  const n = scored.filter((r) => r[f]).length;
  const pct = Math.round((n / scored.length) * 100);
  console.log(`  ${f.padEnd(9)} ${String(n).padStart(2)}/${scored.length}  ${'█'.repeat(Math.round(pct / 4)).padEnd(25)} ${pct}%`);
}

/* ------------------------------------------------------------------ *
 * Assertions. Eyeballing a table catches obvious breakage; these pin
 * the cases that previously went wrong so they cannot regress quietly.
 * ------------------------------------------------------------------ */

const find = (frag) => rows.find((r) => r.title.includes(frag));
const CHECKS = [
  // The collision that priced the wrong player before debut-year tiebreaking.
  ['A.J. Green resolves to the receiver, not the corner',
    () => find('A.J. Green').pos === 'WR'],
  ['Kenneth Walker resolves to the running back',
    () => find('Kenneth Walker').pos === 'RB'],
  ['Roman numeral suffix keeps its casing',
    () => find('Kenneth Walker').player === 'Kenneth Walker III'],
  ['Mahomes II parses and clears threshold',
    () => find('Patrick Mahomes').player === 'Patrick Mahomes II' && find('Patrick Mahomes').ok],

  // Gates.
  ['"No Auto" is rejected, not matched on the substring',
    () => find('No Auto').reject === 'auto-explicitly-denied'],
  ['Competing slab is rejected', () => find('BGS 10').reject === 'other-grader'],
  ['Card lot is rejected', () => find('Card Lot of 5').reject?.startsWith('junk')],
  ['Break listing is rejected', () => find('Card Break').reject?.startsWith('junk')],
  ['Ungraded-auto base card is rejected',
    () => find('Rookie Card Silver').reject === 'no-auto-claim'],

  // Structured extraction.
  ['Season format collapses to the first year', () => find('Xavier Worthy').year === 2023],
  ['Hyphenated card number survives', () => find('Bryce Young Rookie').cardNo === 'RA-BY'],
  ['Serial with leading zero parses', () => {
    const s = find('Najee Harris').serial; return s && s.num === 7 && s.of === 10;
  }],
  ['One-of-one parses', () => {
    const s = find('Jordan Addison').serial; return s && s.num === 1 && s.of === 1;
  }],
  ['Emoji does not become residual', () => !find('ANTHONY RICHARDSON').residual.some((t) => /[^\x20-\x7e]/.test(t))],

  // Confidence behaviour.
  ['Unresolvable title stays below threshold', () => !find('Investment Grade').ok],
  ['Unsettled name collision is flagged',
    () => find('Chris Johnson').warnings.includes('ambiguous-player')],
  ['Missing parallel is called out rather than assumed silently',
    () => find('Justin Herbert').warnings.includes('assumed-base-parallel')],
];

console.log('\nassertions:');
let failed = 0;
for (const [name, fn] of CHECKS) {
  let pass;
  try { pass = !!fn(); } catch (e) { pass = false; }
  if (!pass) failed++;
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}`);
}
console.log(`\n${CHECKS.length - failed}/${CHECKS.length} assertions passing`);
process.exitCode = failed ? 1 : 0;
