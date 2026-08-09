import pandas as pd

# -----------------------------
# Configuration
# -----------------------------
INPUT_CSV = "players_raw.csv"
OUTPUT_CSV = "players.csv"

BIG_5_LEAGUES = [
    "French Ligue 1",
    "German 1. Bundesliga",
    "English Premier League",
    "Spain Primera Division",
    "Italian Serie A",
]

COLUMNS_TO_KEEP = [
    "sofifa_id",
    "short_name",
    "long_name",
    "player_positions",
    "overall",
    "age",
    "dob",
    "club_name",
    "league_name",
    "nationality_name",
    "weak_foot",
    "skill_moves",
    "player_traits",
    "player_face_url",
]

# -----------------------------
# Load dataset
# -----------------------------
df = pd.read_csv(INPUT_CSV)

print(f"Original rows: {len(df):,}")

# -----------------------------
# Keep only Big 5 leagues
# -----------------------------
df = df[df["league_name"].isin(BIG_5_LEAGUES)]

print(f"After league filter: {len(df):,}")

# -----------------------------
# Keep only required columns
# -----------------------------
df = df[COLUMNS_TO_KEEP]

# -----------------------------
# Remove duplicate players
# (keeps first occurrence)
# -----------------------------
df = df.drop_duplicates(subset="sofifa_id")

print(f"After removing duplicates: {len(df):,}")

# -----------------------------
# Sort (optional)
# -----------------------------
df = df.sort_values(
    by=["overall", "short_name"],
    ascending=[False, True]
)

# -----------------------------
# Save cleaned dataset
# -----------------------------
df.to_csv(OUTPUT_CSV, index=False)

print(f"Saved cleaned dataset to '{OUTPUT_CSV}'")
print(f"Final rows: {len(df):,}")