# Matchday — Football Wordle

A daily footballer-guessing game, in the spirit of Wordle: guess the hidden
player in 8 tries, using nationality, league, club, position, age, overall,
weak foot, skill moves, and shared gameplay traits as clues.

## How it's built

- **Backend**: Node.js + Express (`server.js`). Loads your player CSV into
  memory once at startup, exposes a search endpoint for the autocomplete box,
  and a guess endpoint that computes the row-by-row comparison.
  The identity of the hidden player is **never sent to the browser** until
  the game ends — game state (which player is hidden, which guesses have
  been made) lives in a signed JWT that's handed back and forth with the
  client, so the server doesn't need a database or sticky sessions.
- **Frontend**: plain HTML/CSS/JS (`public/`) — no build step required.
- **Data**: a CSV of players. A small curated sample (`data/players.csv`)

## Running locally

Requires Node.js 18+.

```bash
npm install
cp .env.example .env     # optional, edit JWT_SECRET
npm start
```

Then open http://localhost:3000

## Using your own player data

Replace `data/players.csv` with your full CSV — it can use the exact same
109-column FIFA-style schema. The app only actually *reads* these
columns, so everything else is fine to leave populated or blank:

| Column | Used for |
|---|---|
| `sofifa_id` | unique ID, de-duplication |
| `short_name`, `long_name` | display name, search |
| `player_positions` | primary position + position-group (yellow/green logic) |
| `overall` | Overall Rating column |
| `age`, `dob` | Age column |
| `club_name` | Club column |
| `league_name` | League column |
| `nationality_name` | Nationality column |
| `weak_foot` | Weak Foot column |
| `skill_moves` | Skill Moves column |
| `player_traits` | Shared Traits column |
| `player_face_url` | player photo in search results / results table |

**Data cleaning applied automatically at startup** (per the product spec):
- Duplicate `sofifa_id` rows are dropped (first occurrence wins).
- Rows missing any required field above are excluded from the hidden-player
  pool and from being guessable.
- Rows whose `short_name` looks like a generic placeholder (e.g. `"Player 4"`)
  are excluded.
- This FIFA-style export has no explicit "retired" flag, so if your dataset
  includes retired players and you want to exclude them, filter those rows
  out of the CSV before deploying (e.g. drop rows below a certain
  `club_contract_valid_until`, or rows with no `club_team_id`).

If you point `DATA_FILE` at a much larger CSV (thousands of players), nothing
else needs to change — the whole file is just loaded into memory once.

## Game rules implemented

- 8 guesses per game.
- Daily Challenge: every player gets the same hidden footballer each
  calendar day (UTC), chosen deterministically from the pool so it's
  consistent across server restarts without needing a database.
- Unlimited Mode: a fresh random hidden player every game.
- Feedback columns: Nationality, League, Club, Position (green / yellow
  same-group / gray), Age, Overall, Weak Foot, Skill Moves (green / ↑ / ↓),
  and Shared Traits (only traits in common are revealed).
- Each footballer can only be guessed once per game.
- On loss, the hidden player's name, club, nationality, position, overall,
  and photo are revealed.
- Stats (played, win %, streak, guess distribution) and Daily Challenge
  results are tracked in the browser's `localStorage` — no account or
  database needed. Unlimited games don't affect the streak, matching how
  Wordle-style dailies usually behave.

## Environment variables

See `.env.example`. The only one you should always set explicitly in
production is `JWT_SECRET`.
