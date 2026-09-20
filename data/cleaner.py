"""
Cleans the full FIFA-style export (players_raw.csv) down to the players.csv
that the game actually loads.

Run from anywhere:   python data/cleaner.py

Data note: the export is the FIFA 22 database, so every club, rating, age and
height in it is "as of 2022". The game shows a disclaimer saying so.
"""
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

# Only what the game reads. (weak_foot, skill_moves and dob were dropped:
# weak foot / skill moves are FIFA-game ratings most fans can't reason about,
# and dob was never used because `age` already covers it.)
COLUMNS_TO_KEEP = [
    "sofifa_id",
    "short_name",
    "long_name",
    "player_positions",
    "overall",
    "age",
    "height_cm",
    "club_name",
    "league_name",
    "nationality_name",
    "player_traits",
    "player_face_url",
]

# Columns a row must have to be playable at all.
REQUIRED_COLUMNS = [
    "sofifa_id",
    "short_name",
    "player_positions",
    "overall",
    "age",
    "height_cm",
    "club_name",
    "league_name",
    "nationality_name",
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
df = df[COLUMNS_TO_KEEP].copy()

# -----------------------------
# Remove duplicate players
# (keeps first occurrence)
# -----------------------------
df = df.drop_duplicates(subset="sofifa_id")

print(f"After removing duplicates: {len(df):,}")

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

# Same column order the game expects, continent next to nationality.
ordered = COLUMNS_TO_KEEP.copy()
ordered.insert(ordered.index("nationality_name") + 1, "nationality_continent")
df = df[ordered]

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
