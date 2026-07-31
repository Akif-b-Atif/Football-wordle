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
  "player_positions",
  "overall",
  "age",
  "dob",
  "club_name",
  "league_name",
  "nationality_name",
];

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

    const traits = (row.player_traits || "")
      .split(",")
      .map((t) => t.replace(/\(ai\)/gi, "").trim())
      .filter(Boolean);

    const positions = row.player_positions.split(",").map((p) => p.trim().toUpperCase());

    seenIds.add(id);
    pool.push({
      id,
      short_name: row.short_name.trim(),
      long_name: (row.long_name || row.short_name).trim(),
      primary_position: positions[0],
      all_positions: positions,
      overall: parseInt(row.overall, 10),
      age: parseInt(row.age, 10),
      dob: row.dob,
      club_name: row.club_name.trim(),
      league_name: row.league_name.trim(),
      nationality_name: row.nationality_name.trim(),
      weak_foot: parseInt(row.weak_foot, 10) || null,
      skill_moves: parseInt(row.skill_moves, 10) || null,
      traits,
      face_url: row.player_face_url || null,
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

console.log(`[football-wordle] loaded ${POOL.length} players from ${DATA_FILE}`);

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

function arrow(hiddenVal, guessVal) {
  if (hiddenVal === guessVal) return "green";
  return hiddenVal > guessVal ? "up" : "down";
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
  const idx = hashString(dateKey) % POOL.length;
  return POOL[idx];
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
    nationality: {
      value: guessed.nationality_name,
      result: guessed.nationality_name === hidden.nationality_name ? "green" : "gray",
    },
    league: {
      value: guessed.league_name,
      result: guessed.league_name === hidden.league_name ? "green" : "gray",
    },
    club: {
      value: guessed.club_name,
      result: guessed.club_name === hidden.club_name ? "green" : "gray",
    },
    position: {
      value: guessed.primary_position,
      result: positionFeedback(hidden.primary_position, guessed.primary_position),
    },
    age: {
      value: guessed.age,
      result: arrow(hidden.age, guessed.age),
    },
    overall: {
      value: guessed.overall,
      result: arrow(hidden.overall, guessed.overall),
    },
    weak_foot: {
      value: guessed.weak_foot,
      result: guessed.weak_foot == null ? "gray" : arrow(hidden.weak_foot, guessed.weak_foot),
    },
    skill_moves: {
      value: guessed.skill_moves,
      result: guessed.skill_moves == null ? "gray" : arrow(hidden.skill_moves, guessed.skill_moves),
    },
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
app.get("/api/search", (req, res) => {
  const q = (req.query.q || "").toString().trim().toLowerCase();
  if (q.length < 2) return res.json({ results: [] });

  const results = POOL.filter(
    (p) => p.short_name.toLowerCase().includes(q) || p.long_name.toLowerCase().includes(q)
  )
    .slice(0, 8)
    .map((p) => ({
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
    hiddenId = POOL[Math.floor(Math.random() * POOL.length)].id;
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

app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, () => {
  console.log(`[football-wordle] listening on port ${PORT}`);
});
