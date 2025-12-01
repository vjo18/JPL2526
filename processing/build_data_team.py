import pandas as pd
import json

# ---- CONFIG ----
INITIAL_ELO = 1500
K = 30  # standaard 30 zoals in je sheet

# -------------------------------------------------
# 🇳🇱 Nederlandse maanden → maandnummer
# -------------------------------------------------
MONTH_MAP_NL = {
    "JANUARI": 1,
    "FEBRUARI": 2,
    "MAART": 3,
    "APRIL": 4,
    "MEI": 5,
    "JUNI": 6,
    "JULI": 7,
    "AUGUSTUS": 8,
    "SEPTEMBER": 9,
    "OKTOBER": 10,
    "NOVEMBER": 11,
    "DECEMBER": 12,
}

def parse_dutch_date(s: str) -> pd.Timestamp:
    """
    Converteer datum zoals:
    'ZATERDAG, 30 AUGUSTUS 2025'
    naar een echte datetime.
    """
    s = s.strip()
    # verwijder dag + komma
    if "," in s:
        s = s.split(",", 1)[1].strip()

    # s = "30 AUGUSTUS 2025"
    parts = s.split()
    day = int(parts[0])
    month = MONTH_MAP_NL[parts[1].upper()]
    year = int(parts[2])

    return pd.Timestamp(year=year, month=month, day=day)

def expected_score(elo_team, elo_opponent):
    """Bereken verwacht resultaat via de ELO-formule."""
    return 1 / (1 + 10 ** ((elo_opponent - elo_team) / 400))

def load_matches():
    """Laad kalender uit JSON en zet datum naar datetime."""
    with open("data_raw/match_calendar.json", "r", encoding="utf8") as f:
        matches = json.load(f)

    df = pd.DataFrame(matches)
    df["date"] = df["date"].apply(parse_dutch_date)
    df = df.sort_values("date").reset_index(drop=True)
    return df

def process():
    df = load_matches()
    
    # lijst van alle ploegen
    teams = sorted(set(df["homeTeam"]).union(df["awayTeam"]))

    # init ELO dictionary
    elo = {team: INITIAL_ELO for team in teams}

    results = []

    for _, row in df.iterrows():
        ht = row["homeTeam"]
        at = row["awayTeam"]
        hs = row["homeScore"]
        as_ = row["awayScore"]

        elo_home = elo[ht]
        elo_away = elo[at]

        # expected values
        exp_home = expected_score(elo_home, elo_away)
        exp_away = expected_score(elo_away, elo_home)

        # resultaat
        if pd.isna(hs):
            # toekomstige match
            result_home = None
            result_away = None
            G = 0
        else:
            hs = int(hs)
            as_ = int(as_)

            if hs > as_:
                result_home = 1
                result_away = 0
            elif hs < as_:
                result_home = 0
                result_away = 1
            else:
                result_home = 0.5
                result_away = 0.5

            # G-factor precies zoals je in Excel gebruikt
            diff = abs(hs - as_)
            if diff <= 1:
                G = 1
            else:
                G = (11 + diff) / 8

        # nieuwe ELO
        if result_home is not None:
            new_elo_home = elo_home + K * G * (result_home - exp_home)
            new_elo_away = elo_away + K * G * (result_away - exp_away)
        else:
            new_elo_home = elo_home
            new_elo_away = elo_away

        results.append({
            "date": row["date"].strftime("%d/%m/%Y"),
            "homeTeam": ht,
            "awayTeam": at,
            "homeScore": row["homeScore"],
            "awayScore": row["awayScore"],
            "elo_home_before": round(elo_home, 2),
            "elo_away_before": round(elo_away, 2),
            "expected_home": round(exp_home, 4),
            "expected_away": round(exp_away, 4),
            "result_home": result_home,
            "result_away": result_away,
            "G": G,
            "elo_home_after": round(new_elo_home, 2),
            "elo_away_after": round(new_elo_away, 2)
        })

        # update ELO’s
        elo[ht] = new_elo_home
        elo[at] = new_elo_away

    out = pd.DataFrame(results)
    out.to_csv("data_raw/data_team.csv", index=False, encoding="utf8")

    print("Saved: data_raw/data_team.csv")

if __name__ == "__main__":
    process()
