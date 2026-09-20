/**
 * Football Wordle - backend
 *
 * Responsibilities:
 *  - Load & clean the player CSV into an in-memory pool at startup
 *  - Serve the static frontend (public/)
 *  - Provide a search endpoint for the autocomplete guess box
 *  - Provide a game/guess API that picks the hidden player and computes
 *    the row-by-row comparison WITHOUT ever sending the hidden player's
 *    identity to the client until the game ends (win or out of guesses).
 *
 * Data note: players.csv is the FIFA 22 database, so every club, rating, age
 * and height is "as of 2022". The frontend shows a disclaimer saying so.
 *
 * The "session" (which player is hidden, which guesses have been made)
 * is kept in a signed JWT handed back to the client on every request.
 * This means the server needs no database / sticky sessions, which is
 * ideal for a free-tier single-instance deployment.
 */

const fs = require("fs");
const path = require("path");
const express = require("express");
const jwt = require("jsonwebtoken");
const { parse } = require("csv-parse/sync");

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, "data", "players.csv");
const MAX_GUESSES = 8;

// Every player in the CSV is a valid *guess* (autocomplete/search), but only
// the top N players — by the CSV's own sort order (overall desc, then name)
// — are eligible to be picked as the *hidden* player for Daily or Unlimited
// mode. This keeps the answer pool to well-known, high-rated players while
// still letting people guess anyone in the Big 5 leagues dataset.
const ANSWER_POOL_SIZE = parseInt(process.env.ANSWER_POOL_SIZE, 10) || 182;

if (JWT_SECRET === "dev-secret-change-me") {
  console.warn(
    "[football-wordle] WARNING: using the default JWT_SECRET. Set the JWT_SECRET " +
      "environment variable before deploying publicly."
  );
}

// ---------------------------------------------------------------------------
// Load & clean data
// ---------------------------------------------------------------------------

const REQUIRED_FIELDS = [
  "sofifa_id",
  "short_name",
  "primary_position",
  "overall",
  "age",
  "height_cm",
  "club_name",
  "league_name",
  "nationality_name",
];

// "Mbappé" -> "mbappe", "N'Golo Kanté" -> "ngolo kante", "Ødegaard" -> "odegaard".
// Lets people type names on a plain keyboard.
function normalizeText(str) {
  return String(str)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/ø/g, "o")
    .replace(/æ/g, "ae")
    .replace(/œ/g, "oe")
    .replace(/ß/g, "ss")
    .replace(/[đð]/g, "d")
    .replace(/ł/g, "l")
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Short league names shown under a club in the results table.
const LEAGUE_LABEL = {
  "English Premier League": "Premier League",
  "Spain Primera Division": "La Liga",
  "German 1. Bundesliga": "Bundesliga",
  "Italian Serie A": "Serie A",
  "French Ligue 1": "Ligue 1",
};
const leagueLabel = (name) => LEAGUE_LABEL[name] || name;

function loadPool() {
  const raw = fs.readFileSync(DATA_FILE, "utf-8");
  const records = parse(raw, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
  });

  const seenIds = new Set();
  const pool = [];

  for (const row of records) {
    const id = (row.sofifa_id || "").toString().trim();
    if (!id || seenIds.has(id)) continue;

    const missingRequired = REQUIRED_FIELDS.some((f) => !row[f] || !row[f].toString().trim());
    if (missingRequired) continue;

    // filter out obvious placeholder / generic records
    if (/^player\s*\d*$/i.test(row.short_name.trim())) continue;

    // data/cleaner.py already stripped "(AI)" variants and de-duplicated traits
    const traits = (row.player_traits || "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);

    seenIds.add(id);
    pool.push({
      id,
      short_name: row.short_name.trim(),
      long_name: (row.long_name || row.short_name).trim(),
      primary_position: row.primary_position.trim().toUpperCase(),
      overall: parseInt(row.overall, 10),
      age: parseInt(row.age, 10),
      height_cm: parseInt(row.height_cm, 10),
      club_name: row.club_name.trim(),
      league_name: row.league_name.trim(),
      nationality_name: row.nationality_name.trim(),
      // Added by data/cleaner.py. Optional here: without it the nationality
      // column just never goes yellow.
      continent: (row.nationality_continent || "").trim() || null,
      traits,
      face_url: row.player_face_url || null,
      // Accent-/punctuation-insensitive text used only by /api/search.
      search_key: normalizeText(`${row.short_name} ${row.long_name || ""}`),
      // Position among valid rows in the CSV's own file order (already sorted
      // overall desc, then name by data/cleaner.py). Used to build the
      // answer-eligible pool below; unrelated to the id-sort applied after.
      rank: pool.length,
    });
  }

  if (pool.length === 0) {
    throw new Error(
      `No valid players loaded from ${DATA_FILE}. Check that the CSV has the required columns: ` +
        REQUIRED_FIELDS.join(", ")
    );
  }

  // stable sort by id so the daily index is deterministic across restarts
  pool.sort((a, b) => (a.id > b.id ? 1 : -1));
  return pool;
}

let POOL = loadPool();
const BY_ID = new Map(POOL.map((p) => [p.id, p]));

// Every player in POOL is a valid guess. ANSWER_POOL is the subset that can
// actually be chosen as the hidden player (Daily or Unlimited).
const ANSWER_POOL = POOL.filter((p) => p.rank < ANSWER_POOL_SIZE);

if (ANSWER_POOL.length === 0) {
  throw new Error(
    `ANSWER_POOL_SIZE (${ANSWER_POOL_SIZE}) produced an empty answer pool. Check DATA_FILE and ANSWER_POOL_SIZE.`
  );
}

console.log(
  `[football-wordle] loaded ${POOL.length} players from ${DATA_FILE} ` +
    `(${ANSWER_POOL.length} eligible as the hidden player, top ${ANSWER_POOL_SIZE} by rating)`
);

// ---------------------------------------------------------------------------
// Position groups
// ---------------------------------------------------------------------------

const POSITION_GROUP = {
  ST: "ATT", CF: "ATT", LW: "ATT", RW: "ATT",
  CAM: "MID", CM: "MID", CDM: "MID", LM: "MID", RM: "MID",
  LB: "DEF", LWB: "DEF", RB: "DEF", RWB: "DEF", CB: "DEF",
  GK: "GK",
};

function positionFeedback(hiddenPos, guessPos) {
  if (hiddenPos === guessPos) return "green";
  const hg = POSITION_GROUP[hiddenPos];
  const gg = POSITION_GROUP[guessPos];
  if (hg && gg && hg === gg) return "yellow";
  return "gray";
}

// Numeric clues: green = exact, yellow = within `closeBy`, gray = further away.
// `arrow` always says which way the hidden player's value lies, so a yellow or
// gray cell still tells you whether to go higher or lower.
// Keep these thresholds in sync with "How to play" in public/index.html.
const CLOSE_BY = { age: 2, overall: 2, height_cm: 3 };

function numericFeedback(hiddenVal, guessVal, closeBy) {
  if (hiddenVal === guessVal) return { value: guessVal, result: "green", arrow: null };
  return {
    value: guessVal,
    result: Math.abs(hiddenVal - guessVal) <= closeBy ? "yellow" : "gray",
    arrow: hiddenVal > guessVal ? "up" : "down",
  };
}

// ---------------------------------------------------------------------------
// Daily player selection (deterministic per calendar day, UTC)
// ---------------------------------------------------------------------------

function todayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function hashString(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h * 31 + str.charCodeAt(i)) >>> 0;
  }
  return h;
}

function dailyPlayerFor(dateKey) {
  const idx = hashString(dateKey) % ANSWER_POOL.length;
  return ANSWER_POOL[idx];
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

function comparePlayers(hidden, guessed) {
  const sharedTraits = guessed.traits.filter((t) => hidden.traits.includes(t));

  return {
    guessedPlayer: {
      id: guessed.id,
      short_name: guessed.short_name,
      face_url: guessed.face_url,
    },
    // green = same country; yellow = different country, same continent
    nationality: {
      value: guessed.nationality_name,
      continent: guessed.continent,
      result:
        guessed.nationality_name === hidden.nationality_name
          ? "green"
          : guessed.continent && guessed.continent === hidden.continent
          ? "yellow"
          : "gray",
    },
    // green = same club; yellow = different club, same league
    club: {
      value: guessed.club_name,
      league: leagueLabel(guessed.league_name),
      result:
        guessed.club_name === hidden.club_name
          ? "green"
          : guessed.league_name === hidden.league_name
          ? "yellow"
          : "gray",
    },
    position: {
      value: guessed.primary_position,
      result: positionFeedback(hidden.primary_position, guessed.primary_position),
    },
    age: numericFeedback(hidden.age, guessed.age, CLOSE_BY.age),
    overall: numericFeedback(hidden.overall, guessed.overall, CLOSE_BY.overall),
    height: numericFeedback(hidden.height_cm, guessed.height_cm, CLOSE_BY.height_cm),
    traits: {
      shared: sharedTraits,
    },
    correct: guessed.id === hidden.id,
  };
}

function revealOf(player) {
  return {
    id: player.id,
    short_name: player.short_name,
    long_name: player.long_name,
    club_name: player.club_name,
    nationality_name: player.nationality_name,
    primary_position: player.primary_position,
    overall: player.overall,
    face_url: player.face_url,
  };
}

// ---------------------------------------------------------------------------
// Session token helpers
// ---------------------------------------------------------------------------

function signSession(session) {
  return jwt.sign(session, JWT_SECRET, { expiresIn: "24h" });
}

function readSession(token) {
  try {
    const { iat, exp, ...session } = jwt.verify(token, JWT_SECRET);
    return session;
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json());

if (process.env.ALLOW_ORIGIN) {
  app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", process.env.ALLOW_ORIGIN);
    res.header("Access-Control-Allow-Headers", "Content-Type");
    res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true, poolSize: POOL.length });
});

// Autocomplete search. Never reveals which player is hidden.
// - accent-insensitive ("mbappe" finds Mbappé), every word you type must match
// - best matches first: names where each typed word starts a name-word, then
//   the rest; within each group, higher-rated (better-known) players first
app.get("/api/search", (req, res) => {
  const q = normalizeText((req.query.q || "").toString());
  if (q.length < 2) return res.json({ results: [] });
  const tokens = q.split(" ");

  const matches = [];
  for (const p of POOL) {
    if (!tokens.every((t) => p.search_key.includes(t))) continue;
    const words = p.search_key.split(" ");
    const prefixMatch = tokens.every((t) => words.some((w) => w.startsWith(t)));
    matches.push({ p, tier: prefixMatch ? 0 : 1 });
  }
  matches.sort((a, b) => a.tier - b.tier || a.p.rank - b.p.rank);

  const results = matches.slice(0, 8).map(({ p }) => ({
    id: p.id,
    short_name: p.short_name,
    long_name: p.long_name,
    club_name: p.club_name,
    nationality_name: p.nationality_name,
    face_url: p.face_url,
  }));

  res.json({ results });
});

// Start a new game. mode: "daily" | "unlimited"
app.post("/api/game/new", (req, res) => {
  const mode = req.body && req.body.mode === "unlimited" ? "unlimited" : "daily";

  let hiddenId;
  let dateKey = null;
  if (mode === "daily") {
    dateKey = todayKey();
    hiddenId = dailyPlayerFor(dateKey).id;
  } else {
    hiddenId = ANSWER_POOL[Math.floor(Math.random() * ANSWER_POOL.length)].id;
  }

  const session = {
    mode,
    dateKey,
    hiddenId,
    guesses: [], // array of player ids guessed so far, in order
    won: false,
  };

  res.json({
    token: signSession(session),
    maxGuesses: MAX_GUESSES,
    mode,
    dateKey,
  });
});

// Submit a guess against an existing session token.
app.post("/api/guess", (req, res) => {
  const { token, playerId } = req.body || {};
  const session = token && readSession(token);
  if (!session) return res.status(400).json({ error: "Invalid or expired game session. Start a new game." });

  if (session.won || session.guesses.length >= MAX_GUESSES) {
    return res.status(400).json({ error: "This game is already over." });
  }

  const hidden = BY_ID.get(session.hiddenId);
  const guessed = BY_ID.get((playerId || "").toString());
  if (!hidden || !guessed) return res.status(400).json({ error: "Unknown player." });

  if (session.guesses.includes(guessed.id)) {
    return res.status(400).json({ error: "You already guessed that player." });
  }

  const feedback = comparePlayers(hidden, guessed);

  session.guesses.push(guessed.id);
  if (feedback.correct) session.won = true;

  const gameOver = session.won || session.guesses.length >= MAX_GUESSES;

  const payload = {
    feedback,
    won: session.won,
    gameOver,
    guessesUsed: session.guesses.length,
    guessesRemaining: MAX_GUESSES - session.guesses.length,
    token: signSession(session),
  };

  if (gameOver) {
    payload.reveal = revealOf(hidden);
  }

  res.json(payload);
});

// Resume an in-progress token (e.g. after a page refresh) without making a guess.
app.post("/api/game/state", (req, res) => {
  const { token } = req.body || {};
  const session = token && readSession(token);
  if (!session) return res.status(400).json({ error: "Invalid or expired game session." });

  const hidden = BY_ID.get(session.hiddenId);
  const history = session.guesses
    .map((id) => BY_ID.get(id))
    .filter(Boolean)
    .map((g) => comparePlayers(hidden, g));

  const gameOver = session.won || session.guesses.length >= MAX_GUESSES;

  res.json({
    mode: session.mode,
    dateKey: session.dateKey,
    guessesUsed: session.guesses.length,
    guessesRemaining: MAX_GUESSES - session.guesses.length,
    won: session.won,
    gameOver,
    history,
    reveal: gameOver ? revealOf(hidden) : undefined,
  });
});

// Player photo fallback. The browser first tries the sofifa CDN directly; if
// that fails (hotlink protection, blocked host, ...) the frontend asks here
// instead, and we fetch the image server-side and serve it from our own
// origin. Only URLs on the CDN host taken from our own data are ever fetched
// (never anything the client supplies), and results are cached.
const FACE_HOST = /^https:\/\/cdn\.sofifa\.net\//;
const FACE_CACHE_MAX = 500;
const faceCache = new Map(); // id -> { type, body }

app.get("/api/face/:id", async (req, res) => {
  const player = BY_ID.get(req.params.id);
  if (!player || !player.face_url || !FACE_HOST.test(player.face_url)) {
    return res.status(404).end();
  }

  try {
    let entry = faceCache.get(player.id);
    if (!entry) {
      const upstream = await fetch(player.face_url, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; Footle/1.0)", Accept: "image/*" },
        signal: AbortSignal.timeout(6000),
      });
      const type = upstream.headers.get("content-type") || "";
      if (!upstream.ok || !type.startsWith("image/")) return res.status(404).end();

      const body = Buffer.from(await upstream.arrayBuffer());
      if (body.length === 0 || body.length > 500_000) return res.status(404).end();

      entry = { type, body };
      if (faceCache.size >= FACE_CACHE_MAX) faceCache.delete(faceCache.keys().next().value);
      faceCache.set(player.id, entry);
    }
    res.set("Content-Type", entry.type);
    res.set("Cache-Control", "public, max-age=604800, s-maxage=604800");
    res.send(entry.body);
  } catch {
    res.status(404).end();
  }
});

app.use(express.static(path.join(__dirname, "public")));

// On Vercel (and other serverless hosts), the platform imports `app` and
// calls it directly per-request — it never runs this file as a long-lived
// process, so app.listen() is skipped there. Locally (`npm start`) and on
// traditional Node hosts, this file *is* the entry point, so it listens
// normally.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`[football-wordle] listening on port ${PORT}`);
  });
}

module.exports = app;
