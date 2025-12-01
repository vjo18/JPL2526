import sys, json
from pathlib import Path
import pandas as pd
from urllib.parse import urlparse, parse_qs, urlencode, urlunparse
import os

from build_player_stats import (
    compute_rapm_from_logs,
    PLAYER_INPUT,
    MATCH_EVENTS,
    load_calendar,
)

# =========================== GOOGLE SHEETS (CSV) ============================


GSHEET_ID = os.environ.get("GSHEET_ID", "1_j1bUN1hw7LhxwIf2vaDvKD0NNkPW75muC81UCLapxo")

def _build_sheet_url(gid: str | int) -> str:
    gid = str(gid)
    if not GSHEET_ID or GSHEET_ID.startswith("<ZET_HIER"):
        raise RuntimeError("GSHEET_ID ontbreekt. Zet een env var GSHEET_ID of hardcode het ID in export_json.py")
    return f"https://docs.google.com/spreadsheets/d/{GSHEET_ID}/export?format=csv&gid={gid}"


# GIDs (zoals door jou doorgegeven)
GID_DATA_TEAM        = "0"           # tab: Data Team
GID_TEAM_STATS       = "1098770111"  # tab: Team Stats
GID_PLAYER_STATS     = "1104078248"  # tab: Player Stats
GID_DATA_MATCHEVENT  = "677032943"   # tab: Data Matchevent

# Optioneel: voor 'vorig seizoen' reeksen (als je zulke tabs gepublished hebt)
# Laat leeg ("") als je die niet hebt.
GID_DATA_TEAM_PREV = ""            # laat leeg als je dit niet gebruikt
GID_DATA_TEAM_24_25 = ""  # tab: Data Team 24_25 (vorig seizoen)


ALLOWED = [
    "K. Eendr. Wervik A","K.S.C. Wielsbeke","K.R.C. Waregem A","Zwevegem Sport",
    "K. FC Marke A","K. RC Bissegem","S.V. Wevelgem City A","FC Sp. Heestert A",
    "Club Roeselare","K. WS Oudenburg","K. VC Ardooie A","KFC Aalbeke Sport A",
    "K. SV Moorsele A","K. FC Varsenare A","K. FC Heist A","K. SV Bredene A",
]

SEP = (",", ":")  # minified JSON

def outdir():
    p = Path("public/data")
    p.mkdir(parents=True, exist_ok=True)
    return p

def _minidump(obj: dict | list, fp: Path):
    fp.write_text(json.dumps(obj, ensure_ascii=False, separators=SEP))


# In plaats van Google Sheets: lokale CSV's
LOCAL_MAP = {
    GID_DATA_TEAM:       "data_raw/data_team.csv",
    GID_TEAM_STATS:      "data_raw/team_stats.csv",
    GID_PLAYER_STATS:    "data_raw/player_stats.csv",
    GID_DATA_MATCHEVENT: "data_raw/data_matchevent.csv",
}

def _read_csv(gid: str | int, usecols=None):
    gid = str(gid)
    path = LOCAL_MAP.get(gid)
    if not path:
        raise RuntimeError(f"Geen lokaal CSV-pad gedefinieerd voor gid={gid}")
    return pd.read_csv(path, usecols=usecols)




# ============================== TEAM STATS ==================================

def export_team_stats(xfile: str, dst: Path):
    df = _read_csv(GID_TEAM_STATS)

    # Enkel de ploegen die mogen
    df = df[df["Team"].isin(ALLOWED)].copy()

    # Hernoem kolommen naar wat de app verwacht
    rename_map = {
        "Matches": "Played",
        "Wins": "W",
        "Draws": "G",
        "Losses": "V",
        "Goals For": "GF",
        "Goals Against": "GA",
        "Goal Diff": "GD",
        "Points": "Points",
        "Current ELO": "ELO",     # ⭐ BELANGRIJK: HIER komt "ELO" vandaan!
    }

    df = df.rename(columns=rename_map)

    # --- Gele kaarten ---
    # In team_stats.csv komen die nu uit build_team_stats als 'Yellow cards F'.
    if "YellowF" in df.columns:
        pass  # al ok
    elif "Yellow cards F" in df.columns:
        df["YellowF"] = df["Yellow cards F"]
    else:
        df["YellowF"] = 0

    # --- Vorm & moeilijkheid ---
    # Deze kolommen bereken je nu in build_team_stats.
    # Bestaan ze niet (fallback), dan vullen we 0 in zodat de app niet crasht.
    if "ELO +/- L5" not in df.columns:
        df["ELO +/- L5"] = 0.0
    if "ELO opp diff tot" not in df.columns:
        df["ELO opp diff tot"] = 0.0


    # Selecteer kolommen in juiste volgorde
    keep = [
        "Team",
        "Played",
        "W",
        "G",
        "V",
        "GF",
        "GA",
        "GD",
        "Points",
        "ELO",
        "YellowF",
        "ELO +/- L5",
        "ELO opp diff tot"
    ]

    # Zorg dat alles numeriek is waar mogelijk
    for col in keep:
        if col == "Team":
            continue
        df[col] = pd.to_numeric(df[col], errors="coerce").fillna(0)

    df["ELO"] = df["ELO"].round(1)

    _minidump(df.to_dict(orient="records"), dst)

# ================================= H2H ======================================

def _pack_cell(row: dict, is_home: bool):
    hs, as_, date = row.get("homeScore"), row.get("awayScore"), row.get("date")
    if pd.notna(hs) and pd.notna(as_):
        team_goals = int(hs) if is_home else int(as_)
        opp_goals  = int(as_) if is_home else int(hs)
        res = "W" if team_goals > opp_goals else ("G" if team_goals == opp_goals else "V")
        return {"text": f"{int(hs)}-{int(as_)}", "res": res}

    if pd.isna(date):
        return {"text": None, "res": None}

    # date kan al een Timestamp zijn; zoniet: parse met dayfirst=True
    d = date if isinstance(date, pd.Timestamp) else pd.to_datetime(date, errors="coerce", dayfirst=True)
    return {"text": d.strftime("%d/%m/%Y") if pd.notna(d) else None, "res": None}


def export_h2h_all(xfile: str, dst: Path):
    dt = _read_csv(GID_DATA_TEAM, usecols=["date","homeTeam","homeScore","awayTeam","awayScore"])
    # Parseer datum meteen in dag/maand volgorde voor correcte sortering/formattering
    dt["date"] = pd.to_datetime(dt["date"], errors="coerce", dayfirst=True)


    data = {}
    for team in ALLOWED:
        sub = dt[(dt.homeTeam == team) | (dt.awayTeam == team)]
        h2h = {}
        for opp in ALLOWED:
            if opp == team:
                h2h[opp] = {"home": {"text": None, "res": None}, "away": {"text": None, "res": None}}
                continue

            h = sub[(sub.homeTeam == team) & (sub.awayTeam == opp)].sort_values("date").tail(1)
            a = sub[(sub.awayTeam == team) & (sub.homeTeam == opp)].sort_values("date").tail(1)

            h2h[opp] = {
                "home": _pack_cell(h.iloc[0].to_dict(), True) if len(h) else {"text": None, "res": None},
                "away": _pack_cell(a.iloc[0].to_dict(), False) if len(a) else {"text": None, "res": None},
            }
        data[team] = h2h

    _minidump(data, dst)

# ============================== HOME / AWAY =================================

def export_homeaway_all(xfile: str, dst: Path):
    dt = _read_csv(GID_DATA_TEAM)
    played = dt[pd.notna(dt.homeScore) & pd.notna(dt.awayScore)].copy()
    played["homeScore"] = pd.to_numeric(played["homeScore"], errors="coerce").astype(int)
    played["awayScore"] = pd.to_numeric(played["awayScore"], errors="coerce").astype(int)

    out = {t: {
        "home": {"matches": 0, "W": 0, "G": 0, "V": 0, "points": 0, "GF": 0, "GA": 0},
        "away": {"matches": 0, "W": 0, "G": 0, "V": 0, "points": 0, "GF": 0, "GA": 0}
    } for t in ALLOWED}

    for _, r in played.iterrows():
        h, a, hs, as_ = r.homeTeam, r.awayTeam, int(r.homeScore), int(r.awayScore)

        if h in out:
            o = out[h]["home"]; o["matches"] += 1; o["GF"] += hs; o["GA"] += as_
            if hs > as_: o["W"] += 1; o["points"] += 3
            elif hs == as_: o["G"] += 1; o["points"] += 1
            else: o["V"] += 1

        if a in out:
            o = out[a]["away"]; o["matches"] += 1; o["GF"] += as_; o["GA"] += hs
            if as_ > hs: o["W"] += 1; o["points"] += 3
            elif as_ == hs: o["G"] += 1; o["points"] += 1
            else: o["V"] += 1

    _minidump(out, dst)

# ===================== LEAGUE STATS uit TEAM STATS ==========================

def _league_stats_from_teamstats(ts: pd.DataFrame) -> dict:
    """
    Bouw league-min/avg/max/rank per team voor:
      - goalsFor (GF)
      - goalsAgainst (GA)
      - yellowFor/yellowAgainst alleen als die kolommen bestaan.

    Werkt zowel met oude sheet-kolommen als met jouw nieuwe:
      'Goals For', 'Goals Against', ...
    """
    if "Team" not in ts.columns:
        return {}

    ts = ts[ts["Team"].isin(ALLOWED)].copy()

    # Mogelijke kolommen voor GF / GA / geel
    gf_col = next((c for c in ["GF", "Goals For", "+"] if c in ts.columns), None)
    ga_col = next((c for c in ["GA", "Goals Against", "-"] if c in ts.columns), None)
    yf_col = next((c for c in ["Yellow cards F", "YellowF", "Yellow For"] if c in ts.columns), None)
    ya_col = next((c for c in ["Yellow cards A", "YellowA", "Yellow Against"] if c in ts.columns), None)

    # Naar numeriek casten waar nodig
    for col in [gf_col, ga_col, yf_col, ya_col]:
        if col and col in ts.columns:
            ts[col] = pd.to_numeric(ts[col], errors="coerce")

    out: dict[str, dict] = {t: {} for t in ts["Team"]}

    def blk(col: str, key: str):
        s = ts[col].dropna()
        if s.empty:
            return
        lmin = int(s.min())
        lavg = round(float(s.mean()), 1)
        lmax = int(s.max())
        ranks = s.rank(method="min", ascending=False).astype(int)

        for idx, row in ts.loc[s.index, ["Team", col]].iterrows():
            team = row["Team"]
            out[team][key] = {
                "min": lmin,
                "avg": lavg,
                "max": lmax,
                "rank": int(ranks.loc[idx]),
            }

    if gf_col:
        blk(gf_col, "goalsFor")
    if ga_col:
        blk(ga_col, "goalsAgainst")
    if yf_col:
        blk(yf_col, "yellowFor")
    if ya_col:
        blk(ya_col, "yellowAgainst")

    return out

# ============================ EVENT BINS (compact) ==========================

def export_event_bins_all(xfile: str, dst: Path):
    import statistics

    dm = _read_csv(
        GID_DATA_MATCHEVENT,
        usecols=["team", "team against", "minute", "event", "Goal total event"],
    ).rename(columns={"team against": "opp", "Goal total event": "goal_flag"})

    def parse_minute(x):
        if pd.isna(x):
            return pd.NA
        import re

        m = re.match(r".*?(\d+)(?:\s*\+\s*(\d+))?.*", str(x))
        if not m:
            return pd.NA
        v = int(m.group(1)) + (int(m.group(2)) if m.group(2) else 0)
        return float(90 if v > 90 else (0 if v < 0 else v))

    dm["mnum"] = dm["minute"].map(parse_minute)
    ev = dm["event"].astype(str).str.lower().str.strip()
    is_yellow = ev.isin({"yellow", "yellowcard", "gele kaart", "geel", "yellow card"})
    is_goal = dm["goal_flag"].astype(bool)

    def bins(s):
        s = pd.to_numeric(s, errors="coerce").dropna().astype(float)
        return {
            "0-14": {"count": int((s < 15).sum())},
            "15-30": {"count": int(((s > 14) & (s < 31)).sum())},
            "31-45": {"count": int(((s > 30) & (s < 46)).sum())},
            "46-59": {"count": int(((s > 45) & (s < 60)).sum())},
            "60-75": {"count": int(((s > 59) & (s < 76)).sum())},
            "76-90": {"count": int((s > 75).sum())},
        }

    ts = _read_csv(GID_TEAM_STATS)
    league = _league_stats_from_teamstats(ts)

    # -------- league-telling over alle ALLOWED teams (voor aantallen) -------
    mask_allowed_team = dm["team"].isin(ALLOWED)
    mask_allowed_opp = dm["opp"].isin(ALLOWED)

    gf_league = bins(dm.loc[is_goal & mask_allowed_team, "mnum"])
    ga_league = bins(dm.loc[is_goal & mask_allowed_opp, "mnum"])
    yf_league = bins(dm.loc[is_yellow & mask_allowed_team, "mnum"])
    ya_league = bins(dm.loc[is_yellow & mask_allowed_opp, "mnum"])

    bin_keys = list(gf_league.keys())
    metrics = ["goalsFor", "goalsAgainst", "yellowFor", "yellowAgainst"]

    # hier verzamelen we per metric/bin alle team-percentages
    pct_samples = {m: {b: [] for b in bin_keys} for m in metrics}

    out: dict[str, dict] = {}

    # -------- team-bins + samples voor std -------------------------------
    for t in ALLOWED:
        gf = bins(dm.loc[is_goal & (dm["team"] == t), "mnum"])
        ga = bins(dm.loc[is_goal & (dm["opp"] == t), "mnum"])
        yf = bins(dm.loc[is_yellow & (dm["team"] == t), "mnum"])
        ya = bins(dm.loc[is_yellow & (dm["opp"] == t), "mnum"])

        for name, grp in (
            ("goalsFor", gf),
            ("goalsAgainst", ga),
            ("yellowFor", yf),
            ("yellowAgainst", ya),
        ):
            total = sum(c["count"] for c in grp.values())
            for b, c in grp.items():
                c["pct"] = round(c["count"] / total * 100, 1) if total else 0.0
                pct_samples[name][b].append(c["pct"])

        out[t] = {
            "bins": {
                "goalsFor": gf,
                "goalsAgainst": ga,
                "yellowFor": yf,
                "yellowAgainst": ya,
            },
            "totals": {
                "goalsFor":     sum(v["count"] for v in gf.values()),
                "goalsAgainst": sum(v["count"] for v in ga.values()),
                "yellowFor":    sum(v["count"] for v in yf.values()),
                "yellowAgainst":sum(v["count"] for v in ya.values()),
            },
        }

        # --- NIEUW: gemiddelde & mediaan goalminute per team ---
        mins_for = pd.to_numeric(
            dm.loc[is_goal & (dm["team"] == t), "mnum"], errors="coerce"
        ).dropna()

        mins_against = pd.to_numeric(
            dm.loc[is_goal & (dm["opp"] == t), "mnum"], errors="coerce"
        ).dropna()

        out[t]["timing"] = {
            "goalsFor": {
                "count": int(mins_for.count()),
                "avgMinute": float(mins_for.mean()) if len(mins_for) else None,
                "medianMinute": float(mins_for.median()) if len(mins_for) else None,
            },
            "goalsAgainst": {
                "count": int(mins_against.count()),
                "avgMinute": float(mins_against.mean()) if len(mins_against) else None,
                "medianMinute": float(mins_against.median()) if len(mins_against) else None,
            },
        }



    # -------- leagueBins: mean pct + std pct + league-aantallen ----------
    league_bins: dict[str, dict] = {}

    for name, league_counts in (
        ("goalsFor", gf_league),
        ("goalsAgainst", ga_league),
        ("yellowFor", yf_league),
        ("yellowAgainst", ya_league),
    ):
        league_bins[name] = {}
        for b in bin_keys:
            samples = pct_samples[name][b]
            if samples:
                mean_pct = round(sum(samples) / len(samples), 1)
                std_pct = round(
                    statistics.pstdev(samples), 2
                ) if len(samples) > 1 else 0.0
            else:
                mean_pct = 0.0
                std_pct = 0.0

            league_bins[name][b] = {
                # competitie-aantal in dit tijdvak
                "count": int(league_counts[b]["count"]),
                # league-gemiddelde als % (gemiddelde team%)
                "pct": mean_pct,
                # standaardafwijking in %-punten
                "stdPct": std_pct,
            }

    # leagueStats (min/gem/max/rank) + leagueBins toevoegen per team
    for t in out.keys():
        out[t]["leagueStats"] = league.get(t, {})
        out[t]["leagueBins"] = league_bins

    _minidump(out, dst)

def export_first_scorer_all(xfile: str, dst: Path):
    """
    Per team:
      - hoeveel wedstrijden gespeeld
      - hoe vaak scoren ze eerst (totaal / 1e helft / 2e helft)
      - hoe vaak krijgt de tegenstander het eerste doelpunt
      - resultaten (W/D/L + %) wanneer team eerst scoort
      - resultaten (W/D/L + %) wanneer tegenstander eerst scoort
    """
    dm = _read_csv(
        GID_DATA_MATCHEVENT,
        usecols=[
            "matchurl",
            "home_team",
            "away_team",
            "event",
            "team",
            "minute",
            "home_team_goals",
            "away_team_goals",
            "team against",
            "Goal total event",
        ],
    ).rename(columns={"team against": "opp", "Goal total event": "goal_flag"})

    # minuut parser (45+2 → 47, max 90, min 0)
    def parse_minute(x):
        if pd.isna(x):
            return pd.NA
        import re

        m = re.match(r".*?(\d+)(?:\s*\+\s*(\d+))?.*", str(x))
        if not m:
            return pd.NA
        v = int(m.group(1)) + (int(m.group(2)) if m.group(2) else 0)
        return float(90 if v > 90 else (0 if v < 0 else v))

    dm["mnum"] = dm["minute"].map(parse_minute)
    dm["goal_flag"] = dm["goal_flag"].fillna(0).astype(int)

    # init per team
    stats: dict[str, dict] = {}
    for t in ALLOWED:
        stats[t] = {
            "matches": 0,
            "scoredFirst": {"total": 0, "firstHalf": 0, "secondHalf": 0},
            "concededFirst": {"total": 0, "firstHalf": 0, "secondHalf": 0},
            "resultsWhenScoredFirst": {
                "overall": {"W": 0, "D": 0, "L": 0},
                "firstHalf": {"W": 0, "D": 0, "L": 0},
                "secondHalf": {"W": 0, "D": 0, "L": 0},
            },
            "resultsWhenConcededFirst": {
                "overall": {"W": 0, "D": 0, "L": 0},
                "firstHalf": {"W": 0, "D": 0, "L": 0},
                "secondHalf": {"W": 0, "D": 0, "L": 0},
            },
        }

    # per match de first scorer en eindstand bepalen
    for match_id, grp in dm.groupby("matchurl"):
        row0 = grp.iloc[0]
        home = row0["home_team"]
        away = row0["away_team"]
        participants = [str(home), str(away)]

        # eindscore (max goals in sheet)
        hg = grp["home_team_goals"].max()
        ag = grp["away_team_goals"].max()
        home_goals = int(hg) if pd.notna(hg) else 0
        away_goals = int(ag) if pd.notna(ag) else 0

        # eerste doelpunt (indien aanwezig)
        goals = grp[grp["goal_flag"].astype(bool)]
        first_team = None
        first_min = None
        if len(goals) > 0:
            goals_nonan = goals.dropna(subset=["mnum"])
            if len(goals_nonan) > 0:
                rowg = goals_nonan.loc[goals_nonan["mnum"].idxmin()]
                first_team = str(rowg["team"])
                first_min = float(rowg["mnum"])

        # per team in deze match
        for t in participants:
            if t not in ALLOWED:
                continue
            s = stats[t]
            s["matches"] += 1

            # resultaat vanuit perspectief van t
            if t == home:
                gf, ga = home_goals, away_goals
            else:
                gf, ga = away_goals, home_goals

            if gf > ga:
                res = "W"
            elif gf == ga:
                res = "D"
            else:
                res = "L"

            if first_team is None:
                # geen goals → geen first scorer
                continue

            half = "firstHalf" if (first_min is not None and first_min <= 45) else "secondHalf"

            if first_team == t:
                # team scoort eerst
                s["scoredFirst"]["total"] += 1
                s["scoredFirst"][half] += 1
                s["resultsWhenScoredFirst"]["overall"][res] += 1
                s["resultsWhenScoredFirst"][half][res] += 1
            elif first_team in participants:
                # tegenstander scoort eerst
                s["concededFirst"]["total"] += 1
                s["concededFirst"][half] += 1
                s["resultsWhenConcededFirst"]["overall"][res] += 1
                s["resultsWhenConcededFirst"][half][res] += 1
            else:
                # zou in principe niet mogen gebeuren
                continue

    # percentages berekenen
    def pct(x: int, denom: int) -> float:
        return round(x / denom * 100.0, 1) if denom else 0.0

    def res_block(rb: dict):
        total = rb["W"] + rb["D"] + rb["L"]
        if total == 0:
            return None
        return {
            "count": total,
            "W": rb["W"],
            "D": rb["D"],
            "L": rb["L"],
            "pctW": pct(rb["W"], total),
            "pctD": pct(rb["D"], total),
            "pctL": pct(rb["L"], total),
        }

    out: dict[str, dict] = {}
    for t, s in stats.items():
        m = s["matches"]
        if m == 0:
            continue
        sf = s["scoredFirst"]
        cf = s["concededFirst"]
        resSF = s["resultsWhenScoredFirst"]
        resCF = s["resultsWhenConcededFirst"]

        out[t] = {
            "matches": m,
            "scoredFirst": {
                "total": {"count": sf["total"], "pctOfMatches": pct(sf["total"], m)},
                "firstHalf": {"count": sf["firstHalf"], "pctOfMatches": pct(sf["firstHalf"], m)},
                "secondHalf": {"count": sf["secondHalf"], "pctOfMatches": pct(sf["secondHalf"], m)},
            },
            "concededFirst": {
                "total": {"count": cf["total"], "pctOfMatches": pct(cf["total"], m)},
                "firstHalf": {"count": cf["firstHalf"], "pctOfMatches": pct(cf["firstHalf"], m)},
                "secondHalf": {"count": cf["secondHalf"], "pctOfMatches": pct(cf["secondHalf"], m)},
            },
            "resultsWhenScoredFirst": {
                "overall": res_block(resSF["overall"]),
                "firstHalf": res_block(resSF["firstHalf"]),
                "secondHalf": res_block(resSF["secondHalf"]),
            },
            "resultsWhenConcededFirst": {
                "overall": res_block(resCF["overall"]),
                "firstHalf": res_block(resCF["firstHalf"]),
                "secondHalf": res_block(resCF["secondHalf"]),
            },
        }

    _minidump(out, dst)

def export_halftime_fulltime_all(xfile: str, dst: Path):
    """
    Per team:
      - aantal gespeelde matchen
      - aantallen per HT/FT-scenario (W/D/L aan rust vs W/D/L op fulltime)
    """
    dm = _read_csv(
        GID_DATA_MATCHEVENT,
        usecols=[
            "matchurl",
            "home_team",
            "away_team",
            "minute",
            "home_team_goals",
            "away_team_goals",
        ],
    )

    def parse_minute(x):
        if pd.isna(x):
            return pd.NA
        import re

        m = re.match(r".*?(\d+)(?:\s*\+\s*(\d+))?.*", str(x))
        if not m:
            return pd.NA
        v = int(m.group(1)) + (int(m.group(2)) if m.group(2) else 0)
        return float(90 if v > 90 else (0 if v < 0 else v))

    dm["mnum"] = dm["minute"].map(parse_minute)

    out: dict[str, dict] = {}
    for t in ALLOWED:
        out[t] = {
            "matches": 0,
            # bvb "W-W": {"count": 3, "pctOfMatches": 25.0}
            "scenarios": {},
        }

    def res_from_scores(gf: int, ga: int) -> str:
        if gf > ga:
            return "W"
        if gf == ga:
            return "D"
        return "L"

    # per match rustresultaat + eindresultaat berekenen
    for match_id, grp in dm.groupby("matchurl"):
        row0 = grp.iloc[0]
        home = str(row0["home_team"])
        away = str(row0["away_team"])
        participants = [home, away]

        # FT-score
        hg = grp["home_team_goals"].max()
        ag = grp["away_team_goals"].max()
        home_ft = int(hg) if pd.notna(hg) else 0
        away_ft = int(ag) if pd.notna(ag) else 0

        # HT-score (alles t/m minuut 45)
        grp_ht = grp[grp["mnum"] <= 45]
        if len(grp_ht) > 0:
            hg_ht = grp_ht["home_team_goals"].max()
            ag_ht = grp_ht["away_team_goals"].max()
            home_ht = int(hg_ht) if pd.notna(hg_ht) else 0
            away_ht = int(ag_ht) if pd.notna(ag_ht) else 0
        else:
            home_ht = 0
            away_ht = 0

        for t in participants:
            if t not in ALLOWED:
                continue
            rec = out[t]
            rec["matches"] += 1

            if t == home:
                gf_ht, ga_ht = home_ht, away_ht
                gf_ft, ga_ft = home_ft, away_ft
            else:
                gf_ht, ga_ht = away_ht, home_ht
                gf_ft, ga_ft = away_ft, home_ft

            ht_res = res_from_scores(gf_ht, ga_ht)   # "W","D","L"
            ft_res = res_from_scores(gf_ft, ga_ft)   # "W","D","L"
            key = f"{ht_res}-{ft_res}"               # bvb "W-L"

            if key not in rec["scenarios"]:
                rec["scenarios"][key] = {"count": 0}
            rec["scenarios"][key]["count"] += 1

    # percentages tov aantal matchen
    def pct(x: int, denom: int) -> float:
        return round(x / denom * 100.0, 1) if denom else 0.0

    for t, rec in out.items():
        m = rec["matches"]
        for key, v in rec["scenarios"].items():
            v["pctOfMatches"] = pct(v["count"], m)

    _minidump(out, dst)


# ============================ PLAYER STATS ==================================

def export_player_stats_all(xfile: str, dst: Path):
    df = _read_csv(GID_PLAYER_STATS)

    # Gebruik RAPM_per90 als impact-metric in de app
    # → we schrijven die in de kolom "MVP p>20/90min", want App.jsx
    #   verwacht die key voor "Impact / 90min" op de Y-as.
    if "RAPM_per90" in df.columns:
        df["MVP p>20/90min"] = df["RAPM_per90"]



    # helper: kolom ophalen als die bestaat
    def pick(name: str):
        return df[name] if name in df.columns else None


    # kolommen zoals ze in data_raw/player_stats.csv staan
    # én zoals App.jsx ze verwacht
    cols = {
        "Speler": "Speler",
        "Team": "Team",
        "Selecties": "Selecties",
        "Gestart": "Gestart",
        "Ingevallen": "Ingevallen",
        "Vervangen": "Vervangen",
        "Speelminuten": "Speelminuten",
        "Goals": "Goals",
        "Penalties": "Penalties",
        "Own Goals": "Own Goals",
        "Geel": "Geel",
        "Dubbelgeel": "Dubbelgeel",
        "Rood": "Rood",
        "Clean sheets": "Clean sheets",
        # rechtstreeks uit build_player_stats.py
        "Kapitein": "Kapitein",
        "Type": "Type",
        "MVP p>20/90min": "MVP p>20/90min",   # nu RAPM
        "Goals/90min": "Goals/90min",
        "Geel/90min": "Geel/90min",
        "RAPM_per90": "RAPM_per90",           # extra key als je later apart wil tonen
        "RAPM_off_per90": "RAPM_off_per90",
        "RAPM_def_per90": "RAPM_def_per90",
        # 🔽 NIEUW: onzekerheidsinfo
        "RAPM_SE_per90": "RAPM_SE_per90",
        "RAPM_CI_low": "RAPM_CI_low",
        "RAPM_CI_high": "RAPM_CI_high",
        "RAPM_z": "RAPM_z",
        "xPPM_per90": "xPPM_per90",
        "xPPM_SE": "xPPM_SE",
        "xPPM_CI_low": "xPPM_CI_low",
        "xPPM_CI_high": "xPPM_CI_high",
        "xPPM_z": "xPPM_z",


    }


    # basis-dataframe opbouwen
    base = {k: pick(v) for k, v in cols.items() if pick(v) is not None}
    work = pd.DataFrame(base)
    work = work[
        work.get("Team").isin(ALLOWED) &
        work.get("Speler").notna()
    ].copy()

    # Type normaliseren (keeper/speler)
    if "Type" in work:
        work["Type"] = work["Type"].astype(str).str.strip()
    else:
        work["Type"] = "Speler"

    # ints forceren
    intcols = [
        "Selecties", "Gestart", "Ingevallen", "Vervangen",
        "Speelminuten", "Goals", "Penalties", "Own Goals",
        "Geel", "Dubbelgeel", "Rood", "Clean sheets", "Kapitein",
    ]
    for c in intcols:
        if c in work:
            work[c] = pd.to_numeric(work[c], errors="coerce").fillna(0).astype(int)

    # metrics (float)
    metric_cols = [
        "MVP p>20/90min",   # = RAPM_per90 (kopie, voor backwards compat)
        "Goals/90min",
        "Geel/90min",
        "RAPM_per90",
        "RAPM_off_per90",
        "RAPM_def_per90",
        # 🔽 NIEUW: onzekerheid
        "RAPM_SE_per90",
        "RAPM_CI_low",
        "RAPM_CI_high",
        "RAPM_z",
        "xPPM_per90",
        "xPPM_SE",
        "xPPM_CI_low",
        "xPPM_CI_high",
        "xPPM_z",
    ]



    for c in metric_cols:
        if c in work:
            work[c] = pd.to_numeric(work[c], errors="coerce").fillna(0.0).astype(float)

    # laatste-5-kolommen uit de CSV halen
    l5_map = {
        "Selecties_L5":  "Selecties L5",
        "Gestart_L5":    "Gestart L5",
        "Ingevallen_L5": "Ingevallen L5",
        "Vervangen_L5":  "Vervangen L5",
        "Min_L5":        "Speelminuten L5",
        "Goals_L5":      "Goals L5",
        "Pens_L5":       "Penalties L5",
        "OG_L5":         "Own goals L5",
        "Geel_L5":       "Geel L5",
        "DblG_L5":       "Dubbelgeel L5",
        "Rood_L5":       "Rood L5",
        "CS_L5":         "Clean sheet L5",
        "Kapitein_L5":   "Kapitein L5",
    }
    for out_name, src_col in l5_map.items():
        if src_col in df.columns:
            work[out_name] = pd.to_numeric(df[src_col], errors="coerce").fillna(0).astype(int)
        else:
            work[out_name] = 0

    # sorteren: per team, meeste minuten eerst
    if "Speelminuten" in work:
        work = work.sort_values(["Team", "Speelminuten"], ascending=[True, False])
    else:
        work = work.sort_values(["Team"], ascending=[True])

    # output: dict[team] -> lijst spelers
    out = {}
    for team, g in work.groupby("Team"):
        out[team] = g.drop(columns=["Team"]).to_dict(orient="records")

    _minidump(out, dst)

# ===================== RAPM segments =========================

def export_rapm_segments_all(xfile: str, dst: Path):
    """
    Schrijft per team:
      - spelers (gesorteerd op RAPM_per90)
      - alle segmenten (over alle matchen) met:
          * match-id
          * datum
          * doelpuntensaldo voor dat team in het segment (gd)
          * duur van het segment (minuten)
          * lijst spelers van dat team die op het veld stonden
    JSON-bestand: public/data/team_rapm_segments.json
    """
    # --- player_matchdata inladen + booleans normaliseren zoals in build_player_stats ---
    pm = pd.read_csv(PLAYER_INPUT)

    def to_bool(s):
        return str(s).strip().lower() in ("true", "1", "yes")

    for col in ["Starting Player", "Substituted In", "Substituted Out",
                "Is Goalkeeper", "Is Captain", "Clean Sheet"]:
        if col in pm.columns:
            pm[col] = pm[col].apply(to_bool)
        else:
            pm[col] = False

    me = pd.read_csv(MATCH_EVENTS)

    # RAPM + ruwe segmenten
    rapm, seg_df = compute_rapm_from_logs(pm, me, return_segments=True)

    if seg_df is None or seg_df.empty:
        _minidump({}, dst)
        return

    # datum bij de segmenten (via kalender)
    cal = load_calendar()  # kolommen: url, date
    seg_df = seg_df.merge(
        cal.rename(columns={"url": "match"}),
        on="match",
        how="left"
    )
    seg_df["date"] = pd.to_datetime(seg_df["date"], errors="coerce")
    seg_df = seg_df.sort_values(["date", "match"], kind="stable").reset_index(drop=True)

    out: dict[str, dict] = {}

    for team in ALLOWED:
        rows = seg_df[(seg_df["home"] == team) | (seg_df["away"] == team)].copy()
        if rows.empty:
            continue

        segments_json = []
        team_players: set[str] = set()

        for _, r in rows.iterrows():
            is_home = (r["home"] == team)
            gd_team = float(r["gd_delta"]) if is_home else float(-r["gd_delta"])
            players_on = list(r["home_players"] if is_home else r["away_players"])
            dt = r.get("date")
            date_str = (
                dt.strftime("%Y-%m-%d")
                if isinstance(dt, pd.Timestamp) and pd.notna(dt)
                else None
            )
            opp = str(r["away"] if is_home else r["home"])

            segments_json.append({
                "match": str(r["match"]),
                "date": date_str,
                "gd": gd_team,
                "duration": int(r["duration"]),
                "players": players_on,
                "opp": opp,
                "isHome": bool(is_home),
            })
            team_players.update(players_on)


        # spelers van deze ploeg, gesorteerd op RAPM_per90
        players_list = sorted(
            team_players,
            key=lambda p: float(rapm.get(p, 0.0)),
            reverse=True,
        )
        players_json = [
            {"name": p, "rapm_per90": float(rapm.get(p, 0.0))}
            for p in players_list
        ]

        out[team] = {
            "players": players_json,
            "segments": segments_json,
        }

    _minidump(out, dst)



# ===================== POINTS SERIES (current/prev) =========================

def export_points_series(xfile: str, dst: Path):
    """
    Bouwt per team de cumulatieve puntenreeks per speeldag (ALLEEN huidig seizoen).
    Bron: data_raw/data_team.csv via GID_DATA_TEAM.
    'prev' blijft leeg zolang we geen vorig seizoen hebben.
    """
    def calc_series(df: pd.DataFrame) -> dict:
        if df is None or df.empty:
            return {}
        need = ["date", "homeTeam", "homeScore", "awayTeam", "awayScore"]
        missing = [c for c in need if c not in df.columns]
        if missing:
            return {}

        d = df.copy()
        d["date"] = pd.to_datetime(d["date"], errors="coerce", dayfirst=True)
        d = d[pd.notna(d["homeScore"]) & pd.notna(d["awayScore"])].sort_values("date", kind="stable")
        d["homeScore"] = pd.to_numeric(d["homeScore"], errors="coerce")
        d["awayScore"] = pd.to_numeric(d["awayScore"], errors="coerce")

        rows = []
        for _, r in d.iterrows():
            hs, as_ = int(r["homeScore"]), int(r["awayScore"])
            if hs > as_:
                ph, pa = 3, 0
            elif hs == as_:
                ph, pa = 1, 1
            else:
                ph, pa = 0, 3
            rows.append((r["date"], r["homeTeam"], ph))
            rows.append((r["date"], r["awayTeam"], pa))

        if not rows:
            return {}
        s = pd.DataFrame(rows, columns=["date", "team", "pts"]).sort_values(["team", "date"], kind="stable")

        out = {}
        for team, g in s.groupby("team"):
            if team not in ALLOWED:
                continue
            g = g.reset_index(drop=True)
            g["cum"] = g["pts"].cumsum().astype(int)
            rounds = list(range(1, len(g) + 1))
            out[team] = {"rounds": rounds, "cum": g["cum"].tolist()}
        return out

    # Huidig seizoen uit data_team.csv
    cur_map = calc_series(_read_csv(GID_DATA_TEAM))

    # Optioneel: vorig seizoen uit data_team_prev.csv
    try:
        prev_df = pd.read_csv("data_raw/data_team_prev.csv")
    except FileNotFoundError:
        prev_df = None

    prev_map = calc_series(prev_df) if prev_df is not None else {}

    teams = set(cur_map.keys()) | set(prev_map.keys())
    out = {}
    for t in teams:
        out[t] = {
            "current": cur_map.get(t, {"rounds": [], "cum": []}),
            "prev": prev_map.get(t, {"rounds": [], "cum": []}),
        }

    _minidump(out, dst)

# ================================== ELO =====================================

def export_elo_series(xfile: str, out_file: Path):
    """
    Schrijft public/data/team_elo.json
    Per team: chronologische reeks met eigen ELO (indien per-match beschikbaar),
    tegenstander-ELO, en resultaat (W/G/V).
    """
    import numpy as np  # lokaal importeren

    def find_col(df: pd.DataFrame, candidates):
        low = {str(c).strip().lower(): c for c in df.columns}
        for name in candidates:
            hit = low.get(name.lower())
            if hit is not None:
                return hit
        return None

    dt = _read_csv(GID_DATA_TEAM)
    needed = ["date", "homeTeam", "homeScore", "awayTeam", "awayScore"]
    miss = [c for c in needed if c not in dt.columns]
    if miss:
        raise RuntimeError(f"Ontbrekende kolommen in 'Data Team': {miss}")

    # Per-match ELO (optioneel)
    ELOH = "elo_home_before"
    ELOA = "elo_away_before"



    d = dt.copy()
    d["date"] = pd.to_datetime(d["date"], errors="coerce", dayfirst=True)
    d = d[pd.notna(d["homeScore"]) & pd.notna(d["awayScore"])].sort_values("date", kind="stable")
    d["homeScore"] = pd.to_numeric(d["homeScore"], errors="coerce")
    d["awayScore"] = pd.to_numeric(d["awayScore"], errors="coerce")
    if ELOH: d["eloH"] = pd.to_numeric(d[ELOH], errors="coerce")
    if ELOA: d["eloA"] = pd.to_numeric(d[ELOA], errors="coerce")

    # Fallback tegenstander-ELO uit 'Team Stats'
    ts = _read_csv(GID_TEAM_STATS)
    ts = ts[ts["Team"].isin(ALLOWED)].copy()

    # zoek de juiste ELO-kolom: 'ELO' of 'Current ELO'
    elo_col = find_col(ts, ["ELO", "Current ELO"])
    if elo_col is None:
        raise RuntimeError(
            "Geen ELO-kolom gevonden in team_stats.csv (verwacht 'ELO' of 'Current ELO')."
        )

    ts_map = dict(zip(ts["Team"], pd.to_numeric(ts[elo_col], errors="coerce")))


    out = {t: {"rounds": [], "elo": [], "opp": [], "oppName": [], "res": [], "gd": []} for t in ALLOWED}

    for _, r in d.iterrows():
        h, a = r["homeTeam"], r["awayTeam"]
        hs, as_ = int(r["homeScore"]), int(r["awayScore"])
        resH = "W" if hs > as_ else ("G" if hs == as_ else "V")
        resA = "W" if as_ > hs else ("G" if as_ == hs else "V")
        gdH = hs - as_
        gdA = as_ - hs

        # HOME perspectief
        if h in out:
            out[h]["rounds"].append(len(out[h]["rounds"]) + 1)
            own_elo = float(r["eloH"]) if ("eloH" in r and pd.notna(r["eloH"])) else None
            out[h]["elo"].append(own_elo)
            opp_elo = float(r["eloA"]) if ("eloA" in r and pd.notna(r["eloA"])) else (float(ts_map.get(a)) if pd.notna(ts_map.get(a)) else None)
            out[h]["opp"].append(opp_elo)
            out[h]["res"].append(resH)
            out[h]["gd"].append(int(gdH))
            out[h]["oppName"].append(a)

        # AWAY perspectief
        if a in out:
            out[a]["rounds"].append(len(out[a]["rounds"]) + 1)
            own_elo = float(r["eloA"]) if ("eloA" in r and pd.notna(r["eloA"])) else None
            out[a]["elo"].append(own_elo)
            opp_elo = float(r["eloH"]) if ("eloH" in r and pd.notna(r["eloH"])) else (float(ts_map.get(h)) if pd.notna(ts_map.get(h)) else None)
            out[a]["opp"].append(opp_elo)
            out[a]["res"].append(resA)
            out[a]["gd"].append(int(gdA))
            out[a]["oppName"].append(h)

    out_file.write_text(json.dumps(out, ensure_ascii=False, indent=2))

# ================================= CLI ======================================

def main():
    # xfile blijft voor compatibiliteit, maar wordt niet gebruikt in CSV-modus
    x = sys.argv[1] if len(sys.argv) > 1 else ""
    od = outdir()
    export_team_stats(x, od / "team_stats.json")
    export_h2h_all(x, od / "h2h.json")
    export_homeaway_all(x, od / "team_homeaway.json")
    export_event_bins_all(x, od / "team_event_bins.json")
    export_first_scorer_all(x, od / "team_first_scorer.json")
    export_halftime_fulltime_all(x, od / "team_halftime_fulltime.json")
    export_player_stats_all(x, od / "player_stats.json")
    export_points_series(x, od / "team_points.json")
    export_elo_series(x, od / "team_elo.json")
    export_rapm_segments_all(x, od / "team_rapm_segments.json")
    print(
        "OK → team_stats, h2h, homeaway, event_bins, first_scorer, "
        "halftime_fulltime, player_stats, team_points, team_elo, team_rapm_segments"
    )


if __name__ == "__main__":
    main()
