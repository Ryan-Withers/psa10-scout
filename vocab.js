/**
 * Controlled vocabularies for football card title parsing.
 *
 * Ordering matters. Everything is matched longest-phrase-first, so multi-word
 * entries must be able to win over their own substrings:
 * "Donruss Optic" beats "Donruss", "Rookie Patch Autograph" beats "Rookie".
 * The matcher sorts by token length so you do not have to hand-order these.
 */

// Manufacturer. Rarely decisive on its own, useful for disambiguating sets
// that exist under more than one brand (Chrome is Topps, Prizm is Panini).
const BRANDS = [
  'panini', 'topps', 'leaf', 'upper deck', 'donruss', 'score', 'fleer',
  'bowman', 'sage', 'wild card', 'playoff', 'pacific', 'press pass',
];

// The product line. This is the single most important field for pricing:
// a National Treasures RPA and a Score auto of the same player are not
// remotely the same card.
const SETS = [
  // Panini flagship
  'national treasures', 'flawless', 'immaculate', 'impeccable', 'noir',
  'one', 'origins', 'obsidian', 'spectra', 'encased', 'limited',
  'gold standard', 'plates and patches', 'plates & patches', 'crown royale',
  'contenders optic', 'contenders', 'prizm draft picks', 'prizm draft',
  'prizm', 'select draft picks', 'select', 'donruss optic', 'optic',
  // Donruss is both a brand and its own product line. Listed here after the
  // two-word entries so "Donruss Optic" and "Donruss Elite" still win.
  'donruss',
  'mosaic', 'phoenix', 'certified', 'totally certified', 'absolute',
  'chronicles', 'illusions', 'playbook', 'xr', 'zenith', 'legacy',
  'elite extra edition', 'elite', 'prestige', 'luminance', 'clear vision',
  'vertex', 'unparalleled', 'rookies and stars', 'rookies & stars',
  'prime signatures', 'elements', 'titanium', 'revolution', 'instant',
  'black', 'donruss elite', 'classics', 'majestic', 'dynasty', 'sterling',
  // Topps and Bowman
  'bowman chrome', 'bowman sterling', 'bowman', 'topps chrome', 'chrome',
  'finest', 'stadium club', 'inception', 'museum collection', 'gallery',
  // Upper Deck
  'sp authentic', 'exquisite collection', 'exquisite', 'ultimate collection',
  // Leaf and others
  'metal draft', 'metal', 'valiant', 'trinity', 'flash', 'army all american',
  // Added after the first live run surfaced them in real titles.
  'signature class', 'pro debut', 'fire', 'chrome black', 'chrome sapphire',
  'leaf pro set', 'pro set', 'draft picks and prospects', 'score',
  'sage hit', 'sage', 'super break', 'wild card matte', 'wild card',
  'gridiron kings', 'playbook momentum', 'threads', 'rookies and legends',
];

// Insert lines and autograph subsets. These carry huge price separation:
// a Contenders Rookie Ticket is the set's chase auto, a base auto is not.
const INSERTS = [
  'rookie ticket swatches', 'championship ticket', 'playoff ticket',
  'cracked ice ticket', 'rookie ticket', 'cracked ice',
  'rookie patch autograph', 'rookie patch auto', 'rpa',
  'rookie jersey autograph', 'rookie signatures', 'rookie autographs',
  'rated rookie', 'rated rookies', 'downtown', 'kaboom', 'color blast',
  'colour blast', 'stained glass', 'hometown heroes', 'sensational signatures',
  'signature series', 'freshman fabric', 'autograph patch', 'patch autograph',
  'dual patch autograph', 'triple autograph', 'dual autograph',
  'immaculate ink', 'rookie ink', 'shadow box', 'field level', 'star gazing',
  'my house', 'legendary material', 'rookie premiere materials', 'draft picks',
];

// Parallels and finishes. Colour is the main value axis inside a set,
// so a missed parallel is a mispriced card. Anything here that is also a
// common surname (green, brown, white, black) is safe because players are
// extracted and their token spans consumed before parallels are matched.
const PARALLELS = [
  // metal and finish
  'superfractor', 'super fractor', 'x fractor', 'xfractor', 'atomic refractor',
  'refractor', 'prizm', 'holo', 'shimmer', 'sparkle', 'white sparkle',
  'speckle', 'marble', 'nebula', 'galactic', 'pandora', 'mojo', 'wave',
  'hyper', 'disco', 'ice', 'scope', 'fast break', 'choice', 'snakeskin',
  'tiger stripe', 'zebra', 'lazer', 'laser', 'premium', 'neon', 'fluorescent',
  'finite', 'pulsar', 'cosmic', 'reactive', 'velocity', 'genesis', 'flash',
  'camo', 'checkerboard', 'mirror', 'die cut', 'die-cut', 'asia', 'no huddle',
  'fire burst', 'ice burst', 'starburst', 'kaleidoscope', 'psychedelic',
  'dragon scale', 'peacock', 'gator', 'elephant', 'butterfly', 'honeycomb',
  'concourse', 'premier level', 'field level', 'club level', 'tie dye',
  // colours
  'gold vinyl', 'gold', 'silver', 'green', 'blue', 'red', 'orange', 'purple',
  'pink', 'black', 'white', 'bronze', 'teal', 'yellow', 'aqua', 'lime',
  'magenta', 'crimson', 'navy', 'emerald', 'sapphire', 'ruby', 'amethyst',
  'platinum', 'copper', 'rose gold',
];

// Hard rejects. If any of these fire the listing never reaches the matcher.
const JUNK = [
  /\blots?\b/i, /\bbundle\b/i, /\bmystery\s*(box|pack)\b/i, /\brepack\b/i,
  /\breprint(s)?\b/i, /\bcustom(s|ised|ized)?\b/i, /\bproxy\b/i, /\bnovelty\b/i,
  /\bfacsimile\b/i, /\bpreprint\b/i, /\bdigital\b/i, /\bnft\b/i,
  /\bbreak\b/i, /\brandom\s+team\b/i, /\bpick\s+your\s+card\b/i, /\bpyc\b/i,
  /\bread\s+description\b/i, /\bnot\s+psa\b/i, /\bcase\s+hit\b/i,
  /\bsealed\s+(box|case|pack)\b/i, /\bhobby\s+box\b/i, /\bblaster\b/i,
  /\bx\s*\d{2,}\s+cards?\b/i, /\b\d{2,}\s+card\s+lot\b/i,
];

// The listing must clearly assert an on-card or sticker autograph.
const AUTO = /\b(auto(graph(ed|s)?)?|signature[sd]?|signed|on[\s-]?card|sticker\s+auto)\b/i;

// Checked BEFORE AUTO. "No Auto" and "Not Autographed" both contain a
// substring that satisfies AUTO, so without this a base rookie whose title
// explicitly denies an autograph passes the gate and gets priced against an
// autograph comp. Sellers write this constantly to catch auto searches.
const NOT_AUTO = /\b(no|not|non|without|w\/o)[\s-]*(auto(graph(ed|s)?)?|sig(nature[sd]?)?|signed)\b|\bunsigned\b|\bunautographed\b/i;

// The listing must clearly assert PSA, grade 10. Deliberately strict:
// a fake bargain costs more than a missed one.
const PSA10 = /\bpsa\s*(gem\s*(mt|mint)\s*)?10\b|\bgem\s*(mt|mint)\s*10\b.*\bpsa\b|\bpsa\b.*\bgem\s*(mt|mint)\s*10\b/i;

// PSA 9 is allowed in, but only earns a mention later if the player is elite
// and young or the discount is extreme. A 9 is a materially different asset
// from a 10 and is priced against other 9s, never against 10s.
const PSA9 = /\bpsa\s*9\b|\bpsa\s*mint\s*9\b|\bmint\s*9\b.*\bpsa\b/i;

// Guard: "PSA 9.5" is not a PSA grade at all, and "PSA 10" must not be read
// as a 9 because the string contains a 9 somewhere else.
const HALF_GRADE = /\bpsa\s*9\.5\b/i;

// Competing slabs. If the title says BGS or SGC 10 and never says PSA 10,
// it is not our card and the comp would be wrong.
const OTHER_GRADER = /\b(bgs|bccg|sgc|csg|hga|tag|ace)\s*(9(\.5)?|10|pristine|black)\b/i;

// Hobby filler. Present in almost every title, carries no matching signal.
// Excluded from the residual so that seller noise does not look like a
// parser failure and push a good listing into the review queue.
const STOPWORDS = new Set([
  'rookie', 'rookies', 'rc', 'rcs', 'auto', 'autos', 'autograph', 'autographs',
  'autographed', 'signature', 'signatures', 'signed', 'card', 'cards',
  'football', 'nfl', 'gem', 'mint', 'mt', 'psa', 'graded', 'grade', 'slab',
  'the', 'of', 'and', 'a', 'an', 'in', 'on', 'with', 'for', 'new',
  'sp', 'ssp', 'case', 'hit', 'rare', 'low', 'pop', 'must', 'see', 'look',
  'hot', 'wow', 'invest', 'investment', 'nice', 'sharp', 'clean', 'centered',
  'beautiful', 'stunning', 'gorgeous', 'insane', 'fire', 'grail', 'chase',
  'star', 'elite', 'top', 'best', 'great', 'mega', 'super', 'ultra',
  'numbered', 'parallel', 'insert', 'refractor', 'sale', 'free', 'ship',
  'shipping', 'usa', 'nm', 'mnt', 'true', 'perfect', 'x', 'w', 'vs',
  'filler', 'here', 'some', 'extra', 'words', 'base', 'no', 'not',
  'rated', 'patch', 'jersey', 'ticket', 'draft', 'pick', 'picks',
]);

// Consumed with the player name and used to disambiguate collisions.
const SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v']);

// Signals the card is a rookie-year issue, which lets us pin the player by
// debut season instead of guessing between same-named players.
const ROOKIE_HINT = /\b(rookie|rc|rated\s+rookie|1st|first\s+year|draft\s+picks?)\b/i;

module.exports = {
  BRANDS, SETS, INSERTS, PARALLELS, JUNK, AUTO, NOT_AUTO, PSA10, PSA9, HALF_GRADE, OTHER_GRADER,
  STOPWORDS, SUFFIXES, ROOKIE_HINT,
};
