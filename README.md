# Footle — Football Wordle

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
- **Data**: `data/players.csv`, ~2,976 real players from the Big 5 European
  leagues (Premier League, La Liga, Bundesliga, Serie A, Ligue 1), trimmed
  down from a full FIFA-style export (`data/players_raw.csv`, ~19,240
  players) by `data/cleaner.py`. The cleaner keeps only Big-5-league rows,
  drops irrelevant columns, de-duplicates by `sofifa_id`, and sorts the
  result by `overall` (descending) then `short_name`. Every player in this
  file is a valid **guess** — see "Answer pool" below for which of them can
  actually be the hidden player.

### Answer pool (who can be the hidden player)

All ~2,976 players in `data/players.csv` are searchable and guessable, but
only the **top `ANSWER_POOL_SIZE` players** (default **182**), ranked by
their position in the already-sorted CSV (i.e. the 182 highest-`overall`
players), are eligible to actually *be* the hidden player for Daily
Challenge or Unlimited mode. This keeps every day's answer recognizable —
you can still guess an obscure squad player, but you'll never have to guess
one *as* the answer. Change this with the `ANSWER_POOL_SIZE` environment
variable (see below).

## Running locally

Requires Node.js 18+.

```bash
npm install
cp .env.example .env     # optional, edit JWT_SECRET
npm start
```

Then open http://localhost:3000

## Using your own player data

`data/players.csv` already has the trimmed 14-column schema the app expects
(produced by `data/cleaner.py` from a full FIFA-style export). To swap in
your own data, either:

- point `data/cleaner.py`'s `INPUT_CSV` at your own full export and re-run
  `python data/cleaner.py` from inside `data/` (edit `BIG_5_LEAGUES` first
  if you want different leagues), or
- hand-build a CSV with the same columns below and set `DATA_FILE` to point
  at it.

The app only actually *reads* these columns, so anything else is fine to
leave populated or blank:

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

**Data cleaning applied automatically at startup** (per the product spec),
on top of what `cleaner.py` already did:
- Duplicate `sofifa_id` rows are dropped (first occurrence wins).
- Rows missing any required field above are excluded — from *both* being
  guessable and from being answer-eligible.
- Rows whose `short_name` looks like a generic placeholder (e.g. `"Player 4"`)
  are excluded.
- This FIFA-style export has no explicit "retired" flag, so if your dataset
  includes retired players and you want to exclude them, filter those rows
  out of the CSV before deploying (e.g. drop rows below a certain
  `club_contract_valid_until`, or rows with no `club_team_id`).
- Whatever survives this cleaning keeps the **rank** it had in the CSV's own
  sort order; the first `ANSWER_POOL_SIZE` surviving rows become the answer
  pool (see above).

If you point `DATA_FILE` at a much larger CSV (thousands of players), nothing
else needs to change — the whole file is just loaded into memory once. Just
make sure it's sorted the way you want the top-`ANSWER_POOL_SIZE` cutoff to
work (`cleaner.py` already sorts by `overall` descending).

## Game rules implemented

- 8 guesses per game.
- Daily Challenge: every player gets the same hidden footballer each
  calendar day (UTC), chosen deterministically from the **answer pool** (top
  `ANSWER_POOL_SIZE` by rating — see "Answer pool" above) so it's consistent
  across server restarts without needing a database.
- Unlimited Mode: a fresh random hidden player every game, also drawn from
  the answer pool. In both modes you can still *guess* any of the ~2,976
  players in the full dataset.
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

| Variable | Default | Purpose |
|---|---|---|
| `JWT_SECRET` | `dev-secret-change-me` | Signs game session tokens. **Always set a long random value in production** — anyone with it can forge/inspect sessions. |
| `PORT` | `3000` | Port the server listens on locally. Most hosts (including Vercel) set/ignore this for you. |
| `DATA_FILE` | `./data/players.csv` | Path to the player CSV to load at startup. |
| `ANSWER_POOL_SIZE` | `182` | How many of the top-rated players (by the CSV's sort order) are eligible to be the hidden player. Doesn't affect what's guessable. |
| `ALLOW_ORIGIN` | *(unset)* | Only needed if you host the frontend separately from the API. |
