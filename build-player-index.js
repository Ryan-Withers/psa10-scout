/**
 * Compact the 14MB Sleeper dump into a name-keyed index for title parsing
 * and the youth multiplier. Keeps only fields the scorer needs.
 *
 * Run: node build-player-index.js
 * In:  data/sleeper-players-raw.json, downloaded if absent
 * Out: data/player-index.json
 */
const fs = require('fs');

const RAW = 'data/sleeper-players-raw.json';
const OUT = 'data/player-index.json';

/**
 * Sleeper publishes the whole NFL player table as free open JSON, no key.
 *
 * It is downloaded on demand rather than committed, for two reasons: 14MB of
 * churning JSON does not belong in a git history, and the file carries the
 * age, team and years-of-experience the scorer leans on, so a stale copy
 * quietly ages every player by a season and skews the youth multiplier.
 *
 * Sleeper asks that this be called at most once a day, so the copy on disk
 * is reused until it is 20 hours old. On GitHub Actions the file is also
 * cached under today's date, which is what keeps a 20 minute schedule down to
 * one download a day rather than 72.
 */
const SLEEPER_URL = 'https://api.sleeper.app/v1/players/nfl';
const RAW_MAX_AGE_HOURS = 20;

async function ensureRaw() {
  try {
    const ageMs = Date.now() - fs.statSync(RAW).mtimeMs;
    if (ageMs < RAW_MAX_AGE_HOURS * 3600 * 1000) {
      console.log(`using cached ${RAW} (${(ageMs / 3600000).toFixed(1)}h old)`);
      return;
    }
  } catch { /* not there, fall through and fetch */ }

  console.log(`downloading ${SLEEPER_URL} ...`);
  const res = await fetch(SLEEPER_URL, { signal: AbortSignal.timeout(120000) });
  if (!res.ok) {
    // A stale copy beats no copy. Only fatal when there is nothing on disk.
    if (fs.existsSync(RAW)) {
      console.warn(`sleeper returned ${res.status}, using the copy already on disk`);
      return;
    }
    throw new Error(`sleeper ${res.status} and no local copy to fall back on`);
  }
  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync(RAW, Buffer.from(await res.arrayBuffer()));
  console.log(`saved ${(fs.statSync(RAW).size / 1e6).toFixed(1)}MB`);
}

// Cards get printed for these. Ignore long snappers and practice-squad linemen.
const CARD_POSITIONS = new Set(['QB', 'RB', 'WR', 'TE', 'K', 'DEF', 'LB', 'DB', 'DL', 'CB', 'S', 'EDGE', 'DE', 'OT', 'OL']);

function normName(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')   // strip accents
    .toLowerCase()
    .replace(/[.'`’]/g, '')                        // T.J. -> tj, Ja'Marr -> jamarr
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// "Marvin Harrison Jr" -> also index "marvin harrison"
function stripSuffix(n) {
  return n.replace(/\s+(jr|sr|ii|iii|iv|v)$/i, '').trim();
}

/* ---------- dynasty values ---------- *
 *
 * FantasyCalc publishes current dynasty trade values as free open JSON, no
 * key required, and every row carries a sleeperId so it joins straight onto
 * this index. Two fields matter:
 *
 *   overallRank  where the hobby rates the player right now
 *   trend30Day   which way that has moved in the last month
 *
 * Age and years of experience describe a player. Dynasty rank and its trend
 * describe what people are willing to pay for him, which is much closer to
 * what moves card prices.
 */
const FC_URL = 'https://api.fantasycalc.com/values/current?isDynasty=true&numQbs=1&numTeams=12&ppr=1';

async function fetchDynasty() {
  try {
    const res = await fetch(FC_URL, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rows = await res.json();
    const bySleeperId = new Map();
    for (const r of rows) {
      if (!r.player?.sleeperId) continue;
      bySleeperId.set(String(r.player.sleeperId), {
        dynRank: r.overallRank ?? null,
        dynPosRank: r.positionRank ?? null,
        dynValue: r.value ?? null,
        dynTrend30: r.trend30Day ?? null,
      });
    }
    return bySleeperId;
  } catch (e) {
    // Not fatal. Without it every player scores neutral on dynasty, which
    // is the behaviour before this existed.
    console.warn(`dynasty values unavailable (${e.message}), continuing without them`);
    return new Map();
  }
}

(async () => {

await ensureRaw();
const dynasty = await fetchDynasty();
const raw = JSON.parse(fs.readFileSync(RAW, 'utf8'));
const byName = {};
let kept = 0, withDyn = 0;

for (const id of Object.keys(raw)) {
  const p = raw[id];
  if (p.sport !== 'nfl') continue;
  const pos = p.position || p.fantasy_positions?.[0];
  if (!pos || !CARD_POSITIONS.has(pos)) continue;
  const full = `${p.first_name || ''} ${p.last_name || ''}`.trim();
  if (full.length < 4) continue;
  // Sleeper ships placeholder rows under these exact names. They collide with
  // everything and would poison the name index.
  if (/^(player invalid|duplicate player)$/i.test(full)) continue;

  const rec = {
    id,
    name: full,
    pos,
    team: p.team || null,
    age: p.age ?? null,
    exp: p.years_exp ?? null,
    status: p.status || null,
    // recency proxy, used to break name collisions toward the relevant player
    seen: p.news_updated || 0,
    // Dynasty standing, where we have it. Absent for the long tail of
    // players nobody is trading, which is itself informative.
    ...(dynasty.get(id) || {}),
  };
  if (dynasty.has(id)) withDyn++;
  kept++;

  const keys = new Set();
  const n = normName(full);
  keys.add(n);
  const bare = stripSuffix(n);
  if (bare !== n) keys.add(bare);

  for (const k of keys) {
    (byName[k] ||= []).push(rec);
  }
}

// Sort each collision bucket: has a team first, then most recent news.
for (const k of Object.keys(byName)) {
  byName[k].sort((a, b) => (b.team ? 1 : 0) - (a.team ? 1 : 0) || b.seen - a.seen);
}

const collisions = Object.entries(byName).filter(([, v]) => v.length > 1);

fs.writeFileSync(OUT, JSON.stringify({
  built: new Date().toISOString(),
  count: kept,
  keys: Object.keys(byName).length,
  byName,
}));

const bytes = fs.statSync(OUT).size;
console.log(`kept ${kept} players -> ${Object.keys(byName).length} name keys, ${(bytes / 1e6).toFixed(1)}MB`);
console.log(`${withDyn} carry a dynasty rank`);
console.log(`${collisions.length} colliding names. Top 8:`);
for (const [k, v] of collisions.sort((a, b) => b[1].length - a[1].length).slice(0, 8)) {
  console.log(`  ${k}: ${v.map((r) => `${r.pos}/${r.team || 'FA'}/exp${r.exp}`).join('  ')}`);
}

})().catch((e) => { console.error(e); process.exit(1); });
