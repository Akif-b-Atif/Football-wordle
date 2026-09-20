# Footle — Football Wordle

[deployment](https://footle-pi.vercel.app/)

A daily footballer-guessing game, in the spirit of Wordle: guess the hidden
player in 8 tries, using nationality, club, position, age, overall, height,
and shared gameplay traits as clues.

> **Data disclaimer:** all player info (clubs, ages, ratings, heights) is as
> of **2022** (FIFA 22 data) and may be out of date. The game says so in the
> footer and in "How to play".

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
  drops irrelevant columns, de-duplicates by `sofifa_id`, drops incomplete
  rows, reduces the position list to a single `primary_position`, strips the
  "(AI)" suffix from and de-duplicates traits, adds a `nationality_continent`
  column (see "Continents" below), and sorts the result by `overall`
  (descending) then `short_name`. The cleaner is the one place data gets
  prepared, and it asserts its output is exactly the columns listed below, so
  `players.csv` never carries anything the game doesn't use. Every player in this
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

`data/players.csv` already has the trimmed 13-column schema the app expects
(produced by `data/cleaner.py` from a full FIFA-style export). To swap in
your own data, either:

- point `data/cleaner.py`'s `INPUT_CSV` at your own full export and re-run
  `python data/cleaner.py` (edit `BIG_5_LEAGUES` first if you want different
  leagues). The cleaner stops with a clear message if your data contains a
  nationality it has no continent for — just add it to `CONTINENTS`, or
- hand-build a CSV with the same columns below and set `DATA_FILE` to point
  at it.

The app only actually *reads* these columns, so anything else is fine to
leave populated or blank:

| Column | Used for |
|---|---|
| `sofifa_id` | unique ID, de-duplication |
| `short_name`, `long_name` | display name, search |
| `primary_position` | Pos column + position-group (yellow/green logic) |
| `overall` | Overall Rating column |
| `age` | Age column |
| `height_cm` | Height column |
| `club_name` | Club column |
| `league_name` | Club column turns yellow when the league matches |
| `nationality_name` | Nationality column |
| `nationality_continent` | Nationality column turns yellow when the continent matches (optional — without it that clue is never yellow) |
| `player_traits` | Shared Traits column (comma-separated; may be empty) |
| `player_face_url` | player photo (see "Player photos" below) |

**Data cleaning applied automatically at startup** (per the product spec),
on top of what `cleaner.py` already did:
- Duplicate `sofifa_id` rows are dropped (first occurrence wins).
- Rows missing any required field above (all but `nationality_continent`, `player_traits`
  and `player_face_url`) are excluded — from *both* being
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
- One rule for every clue: **green = exact, yellow = close, gray = not close.**
  - **Nationality**: green = same country; yellow = different country, same
    continent (Europe follows UEFA membership, so Turkey, Israel, Georgia etc.
    count as Europe; England/Scotland/Wales/N. Ireland are separate countries
    in Europe).
  - **Club**: green = same club; yellow = different club, same league. League
    is no longer a column of its own; the club cell shows its league in small
    text so you can see why it's yellow.
  - **Position**: green = same position; yellow = same group (attack / midfield
    / defence); gray otherwise.
  - **Age** (±2 years), **Overall** (±2), **Height** (±3 cm): green = exact,
    yellow = within the band, gray = further. An arrow (▲/▼) always shows
    whether the hidden player's value is higher or lower. The bands live in
    `CLOSE_BY` in `server.js`; keep the "How to play" text in sync.
  - **Shared Traits**: only traits in common are revealed.
- Every result cell has a plain-English tooltip / screen-reader description, so
  colour is never the only way to read a clue.
- Search ignores accents and punctuation (`mbappe` finds Mbappé) and lists
  better-known players first.
- Each footballer can only be guessed once per game.
- When a game ends (win or loss, Daily or Unlimited) a popup opens with the
  answer, a **Wordle-style emoji summary** and a **Copy result** button, plus
  your stats including the game you just finished. The summary shows only the
  colours of each guess, never who you guessed or who the answer was:

  ```
  Footle #12 3/8

  🟨⬛⬛⬛🟨🟨
  🟩🟨🟨🟨🟩⬛
  🟩🟩🟩🟩🟩🟩
  ```

  Closing the popup? The end card has a **Share & stats** button to reopen it.
  The 📊 button in the header shows the stats only (no share box). Daily
  puzzle numbers count from `LAUNCH_UTC` in `public/app.js`.
- Stats (played, win %, streaks, guess distribution) are tracked in the
  browser's `localStorage` — no account or database needed. Daily Challenge
  and Unlimited each keep their own stats. The trade-off of no accounts:
  stats live in one browser and reset if site data is cleared.
- "How to play" opens automatically the first time someone visits (tracked
  by `fw_seen_howto_v2` in `localStorage`).

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

## Player photos

Photos come from the sofifa CDN (`player_face_url`). To survive that host
refusing or blocking requests, the frontend tries, in order:

1. the CDN directly, sending no `Referer` (avoids simple hotlink protection);
2. `/api/face/:id`, where this server fetches the image itself and serves it
   from your own origin (only CDN URLs from `players.csv` are ever fetched;
   responses are cached);
3. an initials badge, so a failed image never shows as an empty grey circle.
