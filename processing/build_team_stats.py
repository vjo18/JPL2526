import pandas as pd
import numpy as np
from collections import defaultdict

INPUT_PATH = "data_raw/data_team.csv"
MATCHEVENT_PATH = "data_raw/data_matchevent.csv"
OUTPUT_PATH = "data_raw/team_stats.csv"


def build_team_stats():
    # 1) Data Team inladen
    df = pd.read_csv(INPUT_PATH)

    # datum als echte datum
    df["date"] = pd.to_datetime(df["date"], format="%d/%m/%Y", errors="coerce")

    # gespeelde matchen (scores ingevuld) vs. toekomstige matchen
    df_played = df[df["homeScore"].notna()].copy()
    df_future = df[df["homeScore"].isna()].copy()

    # 2) Per match: twee rijen (home & away) met team-perspectief
    records = []

    for _, row in df_played.iterrows():
        for side in ["home", "away"]:
            team = row[f"{side}Team"]
            opponent = row["awayTeam"] if side == "home" else row["homeTeam"]

            gf = int(row["homeScore"] if side == "home" else row["awayScore"])
            ga = int(row["awayScore"] if side == "home" else row["homeScore"])

            if gf > ga:
                result = 1.0
                points = 3
            elif gf == ga:
                result = 0.5
                points = 1
            else:
                result = 0.0
                points = 0

            rec = {
                "date": row["date"],
                "team": team,
                "opponent": opponent,
                "is_home": 1 if side == "home" else 0,
                "goals_for": gf,
                "goals_against": ga,
                "goal_diff": gf - ga,
                "result": result,
                "points": points,
                "elo_before": row["elo_home_before"]
                if side == "home"
                else row["elo_away_before"],
                "elo_after": row["elo_home_after"]
                if side == "home"
                else row["elo_away_after"],
            }
            records.append(rec)

    team_matches = pd.DataFrame(records)

    # 3) Aggregatie per team: basis-statistieken
    out_records = []

    for team, g in team_matches.groupby("team"):
        g = g.sort_values("date")

        matches = len(g)
        wins = int((g["result"] == 1.0).sum())
        draws = int((g["result"] == 0.5).sum())
        losses = int((g["result"] == 0.0).sum())

        gf = int(g["goals_for"].sum())
        ga = int(g["goals_against"].sum())
        gd = gf - ga
        pts = int(g["points"].sum())

        avg_gf = round(gf / matches, 2) if matches > 0 else 0.0
        avg_ga = round(ga / matches, 2) if matches > 0 else 0.0

        current_elo = round(g["elo_after"].iloc[-1], 2)

        # laatste 5 matchen (punten)
        last5 = g.tail(5)
        last5_points = int(last5["points"].sum())

        out_records.append(
            {
                "Team": team,
                "Matches": matches,
                "Wins": wins,
                "Draws": draws,
                "Losses": losses,
                "Goals For": gf,
                "Goals Against": ga,
                "Goal Diff": gd,
                "Points": pts,
                "Avg GF": avg_gf,
                "Avg GA": avg_ga,
                "Current ELO": current_elo,
                "Last5 Points": last5_points,
            }
        )

    out = pd.DataFrame(out_records)

    # 4) ELO +/- L5 (vorm): verschil in ELO over laatste 5 matchen
    elo_delta = {}
    for team, g in team_matches.groupby("team"):
        g = g.sort_values("date")
        series = list(pd.to_numeric(g["elo_after"], errors="coerce"))
        if not series:
            elo_delta[team] = 0.0
        elif len(series) <= 5:
            elo_delta[team] = float(series[-1] - series[0])
        else:
            # laatste match - match 5 wedstrijden geleden
            elo_delta[team] = float(series[-1] - series[-6])
    out["ELO +/- L5"] = out["Team"].map(lambda t: round(elo_delta.get(t, 0.0), 2))

    # 5) Moeilijkheid resterend programma op basis van toekomstige matchen
    #    (ELO tegenstander H/A/total, + diff t.o.v. leaguegemiddelde)
    home_opps = defaultdict(list)
    away_opps = defaultdict(list)

    for _, row in df_future.iterrows():
        h, a = row["homeTeam"], row["awayTeam"]
        eh = row.get("elo_home_before", np.nan)
        ea = row.get("elo_away_before", np.nan)

        if not pd.isna(ea):
            home_opps[h].append(float(ea))  # thuis: tegenstander = away
        if not pd.isna(eh):
            away_opps[a].append(float(eh))  # uit: tegenstander = home

    def mean_or_nan(vs):
        return float(sum(vs) / len(vs)) if vs else np.nan

    league_avg = float(out["Current ELO"].mean()) if len(out) else 1500.0

    ELO_opp_H = {}
    ELO_opp_A = {}
    ELO_opp_total = {}
    ELO_opp_diff_HA = {}
    ELO_opp_diff_tot = {}

    for team in out["Team"]:
        hlist = home_opps.get(team, [])
        alist = away_opps.get(team, [])
        all_list = hlist + alist

        e_h = mean_or_nan(hlist)
        e_a = mean_or_nan(alist)
        e_tot = mean_or_nan(all_list)

        ELO_opp_H[team] = e_h
        ELO_opp_A[team] = e_a
        ELO_opp_total[team] = e_tot

        diff_ha = e_h - e_a if (not np.isnan(e_h) and not np.isnan(e_a)) else np.nan
        diff_tot = e_tot - league_avg if not np.isnan(e_tot) else np.nan

        ELO_opp_diff_HA[team] = diff_ha
        ELO_opp_diff_tot[team] = diff_tot

    out["ELO opp H"] = out["Team"].map(lambda t: round(ELO_opp_H.get(t, np.nan), 2))
    out["ELO opp A"] = out["Team"].map(lambda t: round(ELO_opp_A.get(t, np.nan), 2))
    out["ELO opp total"] = out["Team"].map(lambda t: round(ELO_opp_total.get(t, np.nan), 2))
    out["ELO opp diff HA"] = out["Team"].map(lambda t: round(ELO_opp_diff_HA.get(t, np.nan), 2))
    out["ELO opp diff tot"] = out["Team"].map(lambda t: round(ELO_opp_diff_tot.get(t, np.nan), 2))

    # 6) Gele kaarten F/A — exact volgens CSV en sheet-regel
    me = pd.read_csv(MATCHEVENT_PATH)

    # Only count EXACT "Yellow Card"
    is_yellow = me["event"].astype(str).str.strip() == "Yellow Card"

    # Team For = kolom 'team'
    yf_series = me[is_yellow].groupby("team").size()

    # Team Against = kolom 'team against'
    ya_series = me[is_yellow].groupby("team against").size()

    out["Yellow cards F"] = out["Team"].map(lambda t: int(yf_series.get(t, 0)))
    out["Yellow cards A"] = out["Team"].map(lambda t: int(ya_series.get(t, 0)))



    # 7) Sorteren zoals klassement (Points, GD, Goals For)
    out = out.sort_values(
        ["Points", "Goal Diff", "Goals For"],
        ascending=[False, False, False],
    ).reset_index(drop=True)

    out.to_csv(OUTPUT_PATH, index=False, encoding="utf8")
    print(f"Saved: {OUTPUT_PATH}")


if __name__ == "__main__":
    build_team_stats()
