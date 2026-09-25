"""Prepare the EA FC 27 player snapshot for Footle.

Run from anywhere: python data/cleaner.py
The source snapshot is dated 2026-09-12. Ages are calculated on that date.
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

# Source columns used to build the game data.
RAW_COLUMNS = [
    "player_id",
    "common_name",
    "first_name",
    "last_name",
    "overall_rating",
    "position",
    "club",
    "league",
    "nationality",
    "gender",
    "skill_moves",
    "weak_foot",
    "birthdate",
    "playstyles",
    "pace",
    "shooting",
    "passing",
    "dribbling",
    "defending",
    "physicality",
    "snapshot_date",
]

# Exact runtime schema. Every field is used by server.js.
OUTPUT_COLUMNS = [
    "player_id",
    "short_name",
    "long_name",
    "primary_position",
    "overall",
    "age",
    "club_name",
    "league_name",
    "nationality_name",
    "nationality_continent",
    "skill_moves",
    "weak_foot",
    "playstyles",
    "pace",
    "shooting",
    "passing",
    "dribbling",
    "defending",
    "physicality",
]

# Optional data (common names and PlayStyles) may be blank in the source.
REQUIRED_COLUMNS = [
    "player_id", "first_name", "last_name", "overall_rating", "position",
    "club", "league", "nationality", "skill_moves", "weak_foot", "birthdate",
    "pace", "shooting", "passing", "dribbling", "defending", "physicality",
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
        "Latvia", "Liechtenstein", "Lithuania", "Luxembourg", "Malta", "Moldova", "Montenegro",
        "Netherlands", "Holland", "North Macedonia", "Northern Ireland", "Norway",
        "Poland", "Portugal", "Republic of Ireland", "Romania", "Russia",
        "Scotland", "Serbia", "Slovakia", "Slovenia", "Spain", "Sweden",
        "Switzerland", "Turkey", "Ukraine", "Wales",
    ],
    "Africa": [
        "Algeria", "Angola", "Benin", "Burkina Faso", "Burundi", "Cameroon",
        "Cape Verde Islands", "Central African Republic", "Chad", "Comoros",
        "Congo", "Congo DR", "Côte d'Ivoire", "Egypt", "Equatorial Guinea",
        "Eritrea", "Ethiopia", "Gabon", "Gambia", "Ghana", "Guinea",
        "Guinea Bissau", "Guinea-Bissau", "Kenya", "Liberia", "Libya", "Madagascar", "Malawi",
        "Mali", "Mauritania", "Mauritius", "Morocco", "Mozambique", "Namibia",
        "Niger", "Nigeria", "Senegal", "Sierra Leone", "South Africa",
        "South Sudan", "Sudan", "Tanzania", "Togo", "Tunisia", "Uganda",
        "Zambia", "Zimbabwe", "Rwanda", "Somalia", "São Tomé e Príncipe",
    ],
    "Asia": [
        "Afghanistan", "Bangladesh", "Bhutan", "China PR", "Chinese Taipei", "Hong Kong",
        "India", "Indonesia", "Iran", "Iraq", "Japan", "Jordan", "Korea DPR",
        "Korea Republic", "Kyrgyzstan", "Lebanon", "Malaysia", "Palestine",
        "Oman", "Pakistan", "Philippines", "Qatar", "Saudi Arabia", "Syria",
        "Sri Lanka", "Thailand", "United Arab Emirates", "Uzbekistan", "Vietnam", "Yemen",
    ],
    "North America": [
        "Antigua and Barbuda", "Barbados", "Belize", "Bermuda", "Canada",
        "Costa Rica", "Cuba", "Curacao", "Curaçao", "Dominican Republic", "El Salvador",
        "Grenada", "Guatemala", "Haiti", "Honduras", "Jamaica", "Mexico",
        "Montserrat", "Panama", "Puerto Rico", "Saint Kitts and Nevis",
        "St. Kitts and Nevis", "Saint Lucia", "St. Lucia", "Trinidad and Tobago", "United States",
    ],
    "South America": [
        "Argentina", "Bolivia", "Brazil", "Chile", "Colombia", "Ecuador",
        "Guyana", "Paraguay", "Peru", "Suriname", "Uruguay", "Venezuela",
    ],
    "Oceania": [
        "Australia", "Fiji", "Guam", "New Caledonia", "New Zealand",
        "Papua New Guinea", "Vanuatu",
    ],
}

NATION_TO_CONTINENT = {
    nation: continent
    for continent, nations in CONTINENTS.items()
    for nation in nations
}

def restore_invalid_bytes(value):
    """Recover occasional CP1252 bytes embedded in an otherwise UTF-8 CSV."""
    if not isinstance(value, str):
        return value
    return re.sub(
        r"[\udc80-\udcff]",
        lambda match: bytes([ord(match.group()) - 0xDC00]).decode("cp1252", errors="replace"),
        value,
    )


def format_long_name(row):
    first = row["first_name"].strip()
    last = row["last_name"].strip()
    common = row["common_name"].strip()
    if common:
        return f'{first} "{common}" {last}'.strip()
    return f"{first} {last}".strip()


def age_on_snapshot(birthdate, snapshot_date):
    return snapshot_date.year - birthdate.year - (
        (snapshot_date.month, snapshot_date.day) < (birthdate.month, birthdate.day)
    )


df = pd.read_csv(
    INPUT_CSV,
    low_memory=False,
    encoding="utf-8-sig",
    encoding_errors="surrogateescape",
)
missing_source_columns = sorted(set(RAW_COLUMNS) - set(df.columns))
if missing_source_columns:
    raise SystemExit(f"Source CSV is missing required columns: {missing_source_columns}")

for column in df.select_dtypes(include=["object", "string"]).columns:
    df[column] = df[column].map(restore_invalid_bytes)

print(f"Original rows: {len(df):,}")

# Footle currently uses the men's player pool only; keep every men's league.
df = df[df["gender"] == "Men's Football"].copy()
df = df[RAW_COLUMNS].drop_duplicates(subset="player_id").copy()
print(f"Men's players after de-duplication: {len(df):,}")

for column in ["common_name", "first_name", "last_name", "club", "league", "nationality", "position"]:
    df[column] = df[column].fillna("").astype("string").str.strip()

df["short_name"] = df["common_name"].where(
    df["common_name"].ne(""), df["last_name"]
)
df["long_name"] = df.apply(format_long_name, axis=1)
df["primary_position"] = df["position"].str.upper()
df["overall"] = pd.to_numeric(df["overall_rating"], errors="coerce")
df["skill_moves"] = pd.to_numeric(df["skill_moves"], errors="coerce")
df["weak_foot"] = pd.to_numeric(df["weak_foot"], errors="coerce")
for stat in ["pace", "shooting", "passing", "dribbling", "defending", "physicality"]:
    df[stat] = pd.to_numeric(df[stat], errors="coerce")
df["birthdate"] = pd.to_datetime(df["birthdate"], errors="coerce")
snapshot_dates = pd.to_datetime(df["snapshot_date"], errors="coerce").dropna().unique()
if len(snapshot_dates) != 1:
    raise SystemExit(
        f"Expected one snapshot date in the source CSV; found {len(snapshot_dates)}."
    )
snapshot_date = pd.Timestamp(snapshot_dates[0]).date()
df["age"] = df["birthdate"].map(
    lambda birthdate: age_on_snapshot(birthdate.date(), snapshot_date)
    if pd.notna(birthdate)
    else pd.NA
)
df["nationality_continent"] = df["nationality"].map(NATION_TO_CONTINENT)
df["playstyles"] = df["playstyles"].fillna("").astype("string").str.strip()

unmapped = sorted(df.loc[df["nationality_continent"].isna(), "nationality"].unique())
if unmapped:
    raise SystemExit(
        f"No continent mapped for: {unmapped}\n"
        "Add them to CONTINENTS in cleaner.py and re-run."
    )

text_columns = [
    "player_id", "short_name", "long_name", "primary_position", "club",
    "league", "nationality", "nationality_continent", "playstyles",
]
invisible_chars = "[\u00ad\u200b-\u200d\u2060\ufeff]"
for column in text_columns:
    df[column] = df[column].astype("string").str.replace(invisible_chars, "", regex=True).str.strip()

df["playstyles"] = df["playstyles"].map(
    lambda value: ", ".join(dict.fromkeys(
        item.strip() for item in value.split(",") if item.strip()
    ))
)
df = df.dropna(subset=REQUIRED_COLUMNS + ["overall", "age"])
df = df[df["short_name"].ne("") & df["long_name"].ne("")]
df = df.rename(
    columns={
        "club": "club_name",
        "league": "league_name",
        "nationality": "nationality_name",
    }
)

numeric_columns = [
    "overall", "age", "skill_moves", "weak_foot", "pace", "shooting",
    "passing", "dribbling", "defending", "physicality",
]
df[numeric_columns] = df[numeric_columns].astype(int)
df = df[OUTPUT_COLUMNS]
assert list(df.columns) == OUTPUT_COLUMNS

# High-rated players make a recognizable answer pool; every men's player is
# still available as a guess.
df = df.sort_values(by=["overall", "short_name", "player_id"], ascending=[False, True, True])
df.to_csv(OUTPUT_CSV, index=False, encoding="utf-8")

print(f"Snapshot date: {snapshot_date.isoformat()}")
print(f"Saved cleaned dataset to '{OUTPUT_CSV.name}'")
print(f"Final men's players: {len(df):,}")
