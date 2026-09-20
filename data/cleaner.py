"""
Cleans the full FIFA-style export (players_raw.csv) down to the players.csv
that the game actually loads.

This script is the ONE place data gets prepared: server.js reads players.csv
as-is. players.csv contains exactly the columns listed in OUTPUT_COLUMNS
below, every one of which the game uses, and nothing else.

Run from anywhere:   python data/cleaner.py

Data note: the export is the FIFA 22 database, so every club, rating, age and
height in it is "as of 2022". The game shows a disclaimer saying so.
"""
import re
from pathlib import Path

import pandas as pd

# -----------------------------
# Configuration
# -----------------------------
HERE = Path(__file__).resolve().parent
INPUT_CSV = HERE / "players_raw.csv"
OUTPUT_CSV = HERE / "players.csv"

BIG_5_LEAGUES = [
    "French Ligue 1",
    "German 1. Bundesliga",
    "English Premier League",
    "Spain Primera Division",
    "Italian Serie A",
]

# Raw columns we read from the export. (weak_foot, skill_moves and dob were
# dropped: weak foot / skill moves are FIFA-game ratings most fans can't reason
# about, and dob is redundant with `age`.)
RAW_COLUMNS = [
    "sofifa_id",
    "short_name",
    "long_name",
    "player_positions",   # only the first (primary) position is used, see below
    "overall",
    "age",
    "height_cm",
    "club_name",
    "league_name",
    "nationality_name",
    "player_traits",
    "player_face_url",
]

# The exact schema of players.csv, in order. Each column is read by server.js:
#   sofifa_id             unique id
#   short_name, long_name display + search
#   primary_position      Pos clue
#   overall, age          OVR / Age clues
#   height_cm             Height clue
#   club_name             Club clue
#   league_name           Club clue turns yellow on a matching league
#   nationality_name      Nation clue
#   nationality_continent Nation clue turns yellow on a matching continent
#   player_traits         Shared Traits clue
#   player_face_url       player photo
OUTPUT_COLUMNS = [
    "sofifa_id",
    "short_name",
    "long_name",
    "primary_position",
    "overall",
    "age",
    "height_cm",
    "club_name",
    "league_name",
    "nationality_name",
    "nationality_continent",
    "player_traits",
    "player_face_url",
]

# Columns a row must have to be playable at all (traits may legitimately be empty).
REQUIRED_COLUMNS = [
    "sofifa_id",
    "short_name",
    "long_name",
    "primary_position",
    "overall",
    "age",
    "height_cm",
    "club_name",
    "league_name",
    "nationality_name",
    "player_face_url",
]

# -----------------------------
# Nationality -> continent
#
# Powers the yellow "right continent, wrong country" clue.
# Rule of thumb: Europe follows UEFA membership (so Turkey, Israel, Georgia,
# Russia, etc. count as Europe, the way football fans think of them);
# everything else is plain geography. The four UK home nations are separate
# nationalities that all sit in Europe.
# -----------------------------
CONTINENTS = {
    "Europe": [
        "Albania", "Andorra", "Armenia", "Austria", "Azerbaijan", "Belarus",
        "Belgium", "Bosnia and Herzegovina", "Bulgaria", "Croatia", "Cyprus",
        "Czech Republic", "Denmark", "England", "Estonia", "Faroe Islands",
        "Finland", "France", "Georgia", "Germany", "Gibraltar", "Greece",
        "Hungary", "Iceland", "Israel", "Italy", "Kazakhstan", "Kosovo",
        "Latvia", "Lithuania", "Luxembourg", "Malta", "Moldova", "Montenegro",
        "Netherlands", "North Macedonia", "Northern Ireland", "Norway",
        "Poland", "Portugal", "Republic of Ireland", "Romania", "Russia",
        "Scotland", "Serbia", "Slovakia", "Slovenia", "Spain", "Sweden",
        "Switzerland", "Turkey", "Ukraine", "Wales",
    ],
    "Africa": [
        "Algeria", "Angola", "Benin", "Burkina Faso", "Burundi", "Cameroon",
        "Cape Verde Islands", "Central African Republic", "Chad", "Comoros",
        "Congo", "Congo DR", "Côte d'Ivoire", "Egypt", "Equatorial Guinea",
        "Eritrea", "Ethiopia", "Gabon", "Gambia", "Ghana", "Guinea",
        "Guinea Bissau", "Kenya", "Liberia", "Libya", "Madagascar", "Malawi",
        "Mali", "Mauritania", "Mauritius", "Morocco", "Mozambique", "Namibia",
        "Niger", "Nigeria", "Senegal", "Sierra Leone", "South Africa",
        "South Sudan", "Sudan", "Tanzania", "Togo", "Tunisia", "Uganda",
        "Zambia", "Zimbabwe",
    ],
    "Asia": [
        "Afghanistan", "Bhutan", "China PR", "Chinese Taipei", "Hong Kong",
        "India", "Indonesia", "Iran", "Iraq", "Japan", "Jordan", "Korea DPR",
        "Korea Republic", "Kyrgyzstan", "Lebanon", "Malaysia", "Palestine",
        "Philippines", "Saudi Arabia", "Syria", "Thailand",
        "United Arab Emirates", "Uzbekistan", "Vietnam",
    ],
    "North America": [
        "Antigua and Barbuda", "Barbados", "Belize", "Bermuda", "Canada",
        "Costa Rica", "Cuba", "Curacao", "Dominican Republic", "El Salvador",
        "Grenada", "Guatemala", "Haiti", "Honduras", "Jamaica", "Mexico",
        "Montserrat", "Panama", "Puerto Rico", "Saint Kitts and Nevis",
        "Saint Lucia", "Trinidad and Tobago", "United States",
    ],
    "South America": [
        "Argentina", "Bolivia", "Brazil", "Chile", "Colombia", "Ecuador",
        "Guyana", "Paraguay", "Peru", "Suriname", "Uruguay", "Venezuela",
    ],
    "Oceania": [
        "Australia", "Fiji", "Guam", "New Zealand", "Papua New Guinea",
    ],
}

NATION_TO_CONTINENT = {
    nation: continent
    for continent, nations in CONTINENTS.items()
    for nation in nations
}

# -----------------------------
# Load dataset
# -----------------------------
df = pd.read_csv(INPUT_CSV, low_memory=False)

print(f"Original rows: {len(df):,}")

# -----------------------------
# Keep only Big 5 leagues
# -----------------------------
df = df[df["league_name"].isin(BIG_5_LEAGUES)]

print(f"After league filter: {len(df):,}")

# -----------------------------
# Keep only required columns
# -----------------------------
df = df[RAW_COLUMNS].copy()

# -----------------------------
# Remove duplicate players
# (keeps first occurrence)
# -----------------------------
df = df.drop_duplicates(subset="sofifa_id")

print(f"After removing duplicates: {len(df):,}")

# -----------------------------
# Primary position
# player_positions is a list ("LW, RW, ST"); the game only ever uses the first
# one, so keep just that.
# -----------------------------
df["primary_position"] = (
    df["player_positions"].astype("string").str.split(",").str[0].str.strip().str.upper()
)


# -----------------------------
# Traits
# Raw data has "(AI)" variants of traits (e.g. "Flair (AI)") and sometimes both
# the plain and "(AI)" version of the same trait. Strip the suffix and
# de-duplicate, keeping order.
# -----------------------------
def clean_traits(value):
    if pd.isna(value):
        return ""
    seen, out = set(), []
    for trait in re.sub(r"\(ai\)", "", str(value), flags=re.IGNORECASE).split(","):
        trait = trait.strip()
        if trait and trait not in seen:
            seen.add(trait)
            out.append(trait)
    return ", ".join(out)


df["player_traits"] = df["player_traits"].map(clean_traits)

# -----------------------------
# Trim stray whitespace on text columns
# -----------------------------
for col in ["short_name", "long_name", "club_name", "league_name", "nationality_name"]:
    df[col] = df[col].astype("string").str.strip()

# -----------------------------
# Drop rows the game can't use
# -----------------------------
df = df.dropna(subset=REQUIRED_COLUMNS)

print(f"After dropping incomplete rows: {len(df):,}")

# -----------------------------
# Add continent (fail loudly if a nationality isn't mapped, so a swapped-in
# dataset can never silently break the yellow nationality clue)
# -----------------------------
df["nationality_continent"] = df["nationality_name"].map(NATION_TO_CONTINENT)

unmapped = sorted(df.loc[df["nationality_continent"].isna(), "nationality_name"].unique())
if unmapped:
    raise SystemExit(
        f"No continent mapped for: {unmapped}\n"
        "Add them to CONTINENTS in cleaner.py and re-run."
    )

df["height_cm"] = df["height_cm"].astype(int)

# -----------------------------
# Final schema: exactly the columns the game uses, no more, no less
# -----------------------------
df = df[OUTPUT_COLUMNS]
assert list(df.columns) == OUTPUT_COLUMNS

# -----------------------------
# Sort
# (the game treats file order as "how famous": the top ANSWER_POOL_SIZE rows
#  can be the hidden player)
# -----------------------------
df = df.sort_values(
    by=["overall", "short_name"],
    ascending=[False, True]
)

# -----------------------------
# Save cleaned dataset
# -----------------------------
df.to_csv(OUTPUT_CSV, index=False)

print(f"Saved cleaned dataset to '{OUTPUT_CSV.name}'")
print(f"Final rows: {len(df):,}")
