import pandas as pd
import numpy as np
import json

from sklearn.linear_model import Ridge  # RAPM via ridge regression

from collections import defaultdict

PLAYER_INPUT = "data_raw/player_matchdata.csv"
CALENDAR_JSON = "data_raw/match_calendar.json"
OUTPUT_PATH = "data_raw/player_stats.csv"
MATCH_EVENTS = "data_raw/match_events.csv"
TEAM_ELO_JSON = "public/data/team_elo.json"  # <-- NIEUW: ELO JSON

XPPM_RIDGE_ALPHA = 250.0   # sterkere shrinkage dan RAPM; kan je later bijtunen


# zelfde NL-datums als in build_data_team.py
MONTH_MAP_NL = {
    "JANUARI": 1, "FEBRUARI": 2, "MAART": 3, "APRIL": 4, "MEI": 5, "JUNI": 6,
    "JULI": 7, "AUGUSTUS": 8, "SEPTEMBER": 9, "OKTOBER": 10, "NOVEMBER": 11, "DECEMBER": 12,
}

def parse_dutch_date(s: str) -> pd.Timestamp:
    s = str(s).strip()
    if "," in s:
        s = s.split(",", 1)[1].strip()
    parts = s.split()
    day = int(parts[0])
    month = MONTH_MAP_NL[parts[1].upper()]
    year = int(parts[2])
    return pd.Timestamp(year=year, month=month, day=day)


def load_calendar():
    with open(CALENDAR_JSON, "r", encoding="utf8") as f:
        matches = json.load(f)
    d = pd.DataFrame(matches)

    # date (NL) -> Timestamp
    if "date" in d.columns:
        d["date"] = d["date"].apply(parse_dutch_date)
    else:
        d["date"] = pd.NaT

    # 1) Gebruik een bestaande ronde/speeldag kolom indien aanwezig
    round_col = None
    for c in ["round", "Round", "speeldag", "Speeldag", "matchweek", "Matchweek", "gw", "GW"]:
        if c in d.columns:
            round_col = c
            break
    if round_col is not None:
        d["round"] = pd.to_numeric(d[round_col], errors="coerce")
        return d[["url", "date", "round"]]

    # 2) Anders: reconstrueer 'speeldag' uit kalender (round-robin logica)
    #    Nieuwe speeldag start zodra een team voor de 2e keer voorkomt in de lopende speeldag.
    if "homeTeam" in d.columns and "awayTeam" in d.columns and d["date"].notna().any():
        d = d.sort_values(["date", "url"], kind="stable").reset_index(drop=True)

        rounds = []
        current_round = 1
        teams_seen: set[str] = set()

        for _, r in d.iterrows():
            ht = str(r.get("homeTeam", "")).strip()
            at = str(r.get("awayTeam", "")).strip()

            if ht in teams_seen or at in teams_seen:
                current_round += 1
                teams_seen = set()

            rounds.append(current_round)
            if ht:
                teams_seen.add(ht)
            if at:
                teams_seen.add(at)

        d["round"] = rounds
        return d[["url", "date", "round"]]

    # 3) Fallback: dense rank op datum (chronologische matchdays)
    d = d.sort_values(["date", "url"], kind="stable").reset_index(drop=True)
    d["round"] = d["date"].rank(method="dense").astype(int)
    return d[["url", "date", "round"]]



def load_team_elo(path: str = TEAM_ELO_JSON):
    """
    Lees team ELO uit JSON zoals gegenereerd door export_json_local.
    We nemen gewoon de LAATSTE ELO-waarde per team als current strength.
    """
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except Exception as e:
        print(f"[WARN] kon team ELO niet laden uit {path}: {e}")
        return {}, 1500.0

    elo_map = {}
    for team, info in data.items():
        arr = info.get("elo") or []
        if not arr:
            continue
        try:
            elo_map[team] = float(arr[-1])  # laatste elo-waarde
        except Exception:
            continue

    if not elo_map:
        return {}, 1500.0

    mean_elo = sum(elo_map.values()) / len(elo_map)
    return elo_map, mean_elo



# --------------------------------------------------------------------
# RAPM helper: bouw segmenten + ridge regression over doelpuntensaldo
# --------------------------------------------------------------------
def compute_rapm_from_logs(
    player_match_df: pd.DataFrame,
    match_events_df: pd.DataFrame,
    alpha: float = 80.0,
    return_segments: bool = False,
    split_off_def: bool = False,
):
    """
    Regularized Adjusted Plus-Minus per 90 minuten (RAPM_per90).

    Vergeleken met de vorige versie:
    - Matchen zonder goals/wissels/rode kaarten worden niet meer gedropt,
      maar krijgen één 0–0 segment van 90 minuten.
    - Er wordt een extra intercept-kolom toegevoegd aan alle design-matrices,
      zodat het gemiddelde niveau niet in spelerscoefs gepropt wordt.
    - Default alpha is verhoogd naar 80.0 voor stabielere coefs.
    """

    def empty_result():
        if split_off_def:
            s = pd.Series(dtype=float)
            return {"total": s, "off": s, "def": s}
        return pd.Series(dtype=float)

    pm = player_match_df.copy()
    me = match_events_df.copy()

    if me.empty:
        if return_segments:
            return empty_result(), pd.DataFrame()
        return empty_result()

    # minuten als integer
    me["minute"] = pd.to_numeric(me["minute"], errors="coerce").fillna(0).astype(int)

    segments: list[dict] = []

    def goals_delta_minute(df_minute, home_team, away_team):
        """
        Bepaal GF/GA voor deze minuut enkel uit events:
        - Goal / Penalty → goal voor 'team'
        - Own Goal        → goal voor 'team_against'
        """
        gf = ga = 0  # gf = goals home-team, ga = goals away-team
        for _, r in df_minute.iterrows():
            ev = str(r["event"]).strip().lower()
            team = str(r["team"])
            team_against = str(r.get("team_against", ""))

            if ev in ("goal", "penalty"):
                if team == home_team:
                    gf += 1
                elif team == away_team:
                    ga += 1
            elif ev == "own goal":
                # own goal = goal voor tegenstander
                if team == home_team:
                    ga += 1
                elif team == away_team:
                    gf += 1
                elif team_against:
                    if team_against == home_team:
                        gf += 1
                    elif team_against == away_team:
                        ga += 1

        return gf, ga

    # per match segmenten bouwen
    for match_id, ev in me.groupby("matchurl"):
        ev = ev.sort_values("minute")

        home = str(ev["home_team"].iloc[0])
        away = str(ev["away_team"].iloc[0])

        pm_m = pm[pm["Match URL"] == match_id]

        # startopstelling
        home_on = set(pm_m[(pm_m["Team"] == home) & (pm_m["Starting Player"])]["Player Name"])
        away_on = set(pm_m[(pm_m["Team"] == away) & (pm_m["Starting Player"])]["Player Name"])

        # fallback als 'Starting Player' niet goed gevuld is
        if not home_on:
            home_on = set(pm_m[(pm_m["Team"] == home) & (pm_m["Minutes Played"] > 0)]["Player Name"])
        if not away_on:
            away_on = set(pm_m[(pm_m["Team"] == away) & (pm_m["Minutes Played"] > 0)]["Player Name"])

        if not home_on and not away_on:
            # geen betrouwbare line-ups → skip
            continue

        # groepeer events per minuut
        ev_by_minute = {m: g for m, g in ev.groupby("minute")}

        # alleen minuten met een "structurele" gebeurtenis
        # (goal/penalty/own goal, wissel, rode kaart)
        def is_boundary_minute(df_min):
            for _, r in df_min.iterrows():
                ev_type = str(r["event"]).strip().lower()
                if ev_type in ("goal", "penalty", "own goal"):
                    return True
                if "substitute in" in ev_type or "substitute out" in ev_type:
                    return True
                if ev_type in ("red card", "yellow-red card", "yellow card - red card"):
                    return True
            return False

        boundary_minutes = [m for m, g in ev_by_minute.items() if is_boundary_minute(g)]
        minutes_sorted = sorted(boundary_minutes)

        # NIEUW: matchen zonder enige 'boundary minute' → één 0–0 segment van 90'
        if not minutes_sorted:
            segments.append({
                "match": match_id,
                "home": home,
                "away": away,
                "duration": 90.0,
                "gd_delta": 0.0,
                "gf": 0.0,
                "ga": 0.0,
                "home_players": list(home_on),
                "away_players": list(away_on),
                "t_start": 0.0,
                "t_end": 90.0,
                "gd_start": 0.0,
                "gd_end": 0.0,
                "man_diff_start": float(len(home_on) - len(away_on)),
                "man_diff_end": float(len(home_on) - len(away_on)),
            })
            continue


        last_minute = 0
        max_minute = max(minutes_sorted)

        # huidige score & manpower bijhouden
        score_home = 0
        score_away = 0

        for minute in minutes_sorted:
            df_min = ev_by_minute[minute]

            # state bij START van het segment
            t_start = float(last_minute)
            t_end   = float(minute)

            gd_start = float(score_home - score_away)
            man_start = float(len(home_on) - len(away_on))

            # segment [last_minute, minute)
            duration = max(minute - last_minute, 1)
            gf, ga = goals_delta_minute(df_min, home, away)
            gd_delta = gf - ga  # positief = goed voor home

            gd_end = gd_start + gd_delta

            # lineup NA de events (voor volgende segment + end-state)
            home_on_next = set(home_on)
            away_on_next = set(away_on)

            for _, r in df_min.iterrows():
                ev_type = str(r["event"]).strip().lower()
                team_ev = str(r["team"])
                player_ev = str(r["player_name"])

                if "substitute in" in ev_type:
                    if team_ev == home:
                        home_on_next.add(player_ev)
                    elif team_ev == away:
                        away_on_next.add(player_ev)
                elif "substitute out" in ev_type:
                    if team_ev == home:
                        home_on_next.discard(player_ev)
                    elif team_ev == away:
                        away_on_next.discard(player_ev)
                elif ev_type in ("red card", "yellow-red card", "yellow card - red card"):
                    if team_ev == home:
                        home_on_next.discard(player_ev)
                    elif team_ev == away:
                        away_on_next.discard(player_ev)

            man_end = float(len(home_on_next) - len(away_on_next))

            segments.append({
                "match": match_id,
                "home": home,
                "away": away,
                "duration": float(duration),
                "gd_delta": float(gd_delta),
                "gf": float(gf),   # goals home in dit segment
                "ga": float(ga),   # goals away in dit segment
                "home_players": list(home_on),        # spelers tijdens segment
                "away_players": list(away_on),
                "t_start": t_start,
                "t_end": t_end,
                "gd_start": gd_start,
                "gd_end": gd_end,
                "man_diff_start": man_start,
                "man_diff_end": man_end,
            })

            # state updaten voor volgende segment
            score_home += gf
            score_away += ga
            home_on = home_on_next
            away_on = away_on_next
            last_minute = minute

            # events van deze minuut toepassen op on-field sets (voor volgende segment)
            for _, r in df_min.iterrows():
                ev_type = str(r["event"]).strip().lower()
                team_ev = str(r["team"])
                player_ev = str(r["player_name"])

                if "substitute in" in ev_type:
                    if team_ev == home:
                        home_on.add(player_ev)
                    elif team_ev == away:
                        away_on.add(player_ev)
                elif "substitute out" in ev_type:
                    if team_ev == home:
                        home_on.discard(player_ev)
                    elif team_ev == away:
                        away_on.discard(player_ev)
                elif ev_type in ("red card", "yellow-red card", "yellow card - red card"):
                    if team_ev == home:
                        home_on.discard(player_ev)
                    elif team_ev == away:
                        away_on.discard(player_ev)

            last_minute = minute

        # staartsegment tot 90' (enkel speeltijd, geen extra goals)
        end_min = max(max_minute + 1, 90)
        if last_minute < end_min and (home_on or away_on):
            duration = end_min - last_minute

            t_start = float(last_minute)
            t_end   = float(end_min)
            gd_start = float(score_home - score_away)
            gd_end   = gd_start
            man = float(len(home_on) - len(away_on))

            segments.append({
                "match": match_id,
                "home": home,
                "away": away,
                "duration": float(duration),
                "gd_delta": 0.0,
                "gf": 0.0,
                "ga": 0.0,
                "home_players": list(home_on),
                "away_players": list(away_on),
                "t_start": t_start,
                "t_end": t_end,
                "gd_start": gd_start,
                "gd_end": gd_end,
                "man_diff_start": man,
                "man_diff_end": man,
            })


    if not segments:
        if return_segments:
            return empty_result(), pd.DataFrame()
        return empty_result()

    seg_df = pd.DataFrame(segments)

    # zet spelerslijsten naar object zodat iterrows/itertuples goed werken
    seg_df["home_players"] = seg_df["home_players"].apply(list)
    seg_df["away_players"] = seg_df["away_players"].apply(list)

    # alle spelers
    all_players = sorted(
        set(
            p
            for lst in (seg_df["home_players"].tolist() + seg_df["away_players"].tolist())
            for p in lst
        )
    )
    if not all_players:
        if return_segments:
            return empty_result(), seg_df
        return empty_result()

    idx_map = {p: i for i, p in enumerate(all_players)}

    # Extra index voor intercept-kolom (constant 1.0)
    n_seg = len(seg_df)
    n_pl = len(all_players)
    intercept_idx = n_pl  # laatste kolom in design-matrices

    # ---------- TOTALE RAPM (GF - GA) ----------
    X_tot = np.zeros((n_seg, n_pl + 1), dtype=float)
    y_tot = np.zeros(n_seg, dtype=float)
    w_tot = np.zeros(n_seg, dtype=float)

    for i, row in seg_df.iterrows():
        dur = float(row["duration"]) if row["duration"] else 1.0
        gf = float(row.get("gf", 0.0))
        ga = float(row.get("ga", 0.0))

        y_tot[i] = (gf - ga) / dur
        w_tot[i] = dur

        for p in row["home_players"]:
            j = idx_map[p]
            X_tot[i, j] += 1.0
        for p in row["away_players"]:
            j = idx_map[p]
            X_tot[i, j] -= 1.0

        # intercept
        X_tot[i, intercept_idx] = 1.0

    # ---------- OFFENSIEVE RAPM ----------
    # 2 rijen per segment: home-aanval + away-aanval
    n_off = 2 * n_seg
    X_off = np.zeros((n_off, n_pl + 1), dtype=float)
    y_off = np.zeros(n_off, dtype=float)
    w_off = np.zeros(n_off, dtype=float)

    for k, row in enumerate(seg_df.itertuples(index=False)):
        dur = float(row.duration) if row.duration else 1.0
        gf_home = float(row.gf)
        gf_away = float(row.ga)  # goals away = goals tegen home
        home_players = row.home_players
        away_players = row.away_players

        # home als aanvallende ploeg
        r_home = 2 * k
        y_off[r_home] = gf_home / dur
        w_off[r_home] = dur
        for p in home_players:
            X_off[r_home, idx_map[p]] += 1.0
        for p in away_players:
            X_off[r_home, idx_map[p]] -= 1.0
        X_off[r_home, intercept_idx] = 1.0

        # away als aanvallende ploeg
        r_away = 2 * k + 1
        y_off[r_away] = gf_away / dur
        w_off[r_away] = dur
        for p in away_players:
            X_off[r_away, idx_map[p]] += 1.0
        for p in home_players:
            X_off[r_away, idx_map[p]] -= 1.0
        X_off[r_away, intercept_idx] = 1.0

    # ---------- DEFENSIEVE RAPM ----------
    # 2 rijen per segment: home-verdedigt + away-verdedigt
    n_def = 2 * n_seg
    X_def = np.zeros((n_def, n_pl + 1), dtype=float)
    y_def = np.zeros(n_def, dtype=float)
    w_def = np.zeros(n_def, dtype=float)

    for k, row in enumerate(seg_df.itertuples(index=False)):
        dur = float(row.duration) if row.duration else 1.0
        # goals against per team
        ga_home = float(row.ga)  # tegengoals home = goals away
        ga_away = float(row.gf)  # tegengoals away = goals home
        home_players = row.home_players
        away_players = row.away_players

        # home in verdediging
        r_home = 2 * k
        y_def[r_home] = -ga_home / dur  # minder tegengoals = positief
        w_def[r_home] = dur
        for p in home_players:
            X_def[r_home, idx_map[p]] += 1.0
        for p in away_players:
            X_def[r_home, idx_map[p]] -= 1.0
        X_def[r_home, intercept_idx] = 1.0

        # away in verdediging
        r_away = 2 * k + 1
        y_def[r_away] = -ga_away / dur
        w_def[r_away] = dur
        for p in away_players:
            X_def[r_away, idx_map[p]] += 1.0
        for p in home_players:
            X_def[r_away, idx_map[p]] -= 1.0
        X_def[r_away, intercept_idx] = 1.0

        # ---------- ridge regressie ----------
    # Let op: laatste kolom is intercept, die negeren we in de output.
    model_tot = Ridge(alpha=alpha, fit_intercept=False)
    model_tot.fit(X_tot, y_tot, sample_weight=w_tot)
    coef_tot = model_tot.coef_[:n_pl] * 90.0  # per 90 min

    # OFF en DEF zoals voorheen
    model_off = Ridge(alpha=alpha, fit_intercept=False)
    model_off.fit(X_off, y_off, sample_weight=w_off)
    coef_off = model_off.coef_[:n_pl] * 90.0

    model_def = Ridge(alpha=alpha, fit_intercept=False)
    model_def.fit(X_def, y_def, sample_weight=w_def)
    coef_def = model_def.coef_[:n_pl] * 90.0

    # ---------- ONZEKERHEID TOTALE RAPM (SE, CI, z-score) ----------
    # We doen dit enkel voor het totale model (GF - GA).
    try:
        # Gewogen XtWX
        XtW = X_tot.T * w_tot  # (n_pl+1, n_seg)
        XtWX = XtW @ X_tot     # (n_pl+1, n_pl+1)

        # Ridge-matrix en inverse
        ridge_mat = XtWX + alpha * np.eye(XtWX.shape[0])
        ridge_inv = np.linalg.inv(ridge_mat)

        # Residuele variantie schatten
        y_pred = model_tot.predict(X_tot)
        resid = y_tot - y_pred
        rss = float(np.sum(w_tot * resid**2))

        # effectieve vrijheidsgraden (trace van "hat"-matrix)
        hat_mat = XtWX @ ridge_inv
        df_eff = float(np.trace(hat_mat))
        denom = max(len(y_tot) - df_eff, 1.0)
        sigma2 = rss / denom

        # variantie van beta (ongeveer)
        var_beta = np.diag(ridge_inv) * sigma2  # (n_pl+1,)
        se_tot = np.sqrt(var_beta[:n_pl]) * 90.0  # per 90 min

        # 95% CI en z-score
        ci_low = coef_tot - 1.96 * se_tot
        ci_high = coef_tot + 1.96 * se_tot
        z_score = np.divide(
            coef_tot,
            se_tot,
            out=np.zeros_like(coef_tot),
            where=se_tot > 0
        )

        rapm_se = pd.Series(se_tot, index=all_players, name="RAPM_SE_per90")
        rapm_ci_low = pd.Series(ci_low, index=all_players, name="RAPM_CI_low")
        rapm_ci_high = pd.Series(ci_high, index=all_players, name="RAPM_CI_high")
        rapm_z = pd.Series(z_score, index=all_players, name="RAPM_z")
    except Exception as e:
        print(f"[WARN] kon onzekerheid voor RAPM niet berekenen: {e}")
        rapm_se = pd.Series(dtype=float)
        rapm_ci_low = pd.Series(dtype=float)
        rapm_ci_high = pd.Series(dtype=float)
        rapm_z = pd.Series(dtype=float)

    rapm_tot = pd.Series(coef_tot, index=all_players, name="RAPM_per90")
    rapm_off = pd.Series(coef_off, index=all_players, name="RAPM_off_per90")
    rapm_def = pd.Series(coef_def, index=all_players, name="RAPM_def_per90")

    if split_off_def:
        # Let op: we steken extra info in dezelfde dict
        result = {
            "total": rapm_tot,
            "off": rapm_off,
            "def": rapm_def,
            "total_se": rapm_se,
            "total_ci_low": rapm_ci_low,
            "total_ci_high": rapm_ci_high,
            "total_z": rapm_z,
        }
    else:
        result = rapm_tot

    if return_segments:
        return result, seg_df
    return result



def _build_expected_points_lookup(seg_df: pd.DataFrame, smooth_k: float = 20.0):
    """
    Bouwt een gesmoothte lookup:
      key = (minute_bucket, goal_diff_clamped, man_diff_clamped)
      value = geshrinkte gemiddelde eindpunten voor de ploeg vanuit die state.

    - We gebruiken eigen competitie als 'historische' data.
    - We doen Empirical Bayes smoothing:
        EP_hat = (sum_pts + k * global_mean) / (count + k)
      zodat states met weinig waarnemingen naar het gemiddelde toegetrokken worden.
    - We clampen goal_diff en manpower_diff naar een beperkte range
      zodat extreme states automatisch gepoold worden.
    """
    if seg_df is None or seg_df.empty:
        # veilige fallback
        def _ep_const(minute, gd, man):
            return 1.5
        return _ep_const, 1.5

    # --- eindscore en punten per match ---
    match_scores = seg_df.groupby("match")[["gf", "ga"]].sum().reset_index()
    match_pts = {}
    for _, r in match_scores.iterrows():
        hs = int(r["gf"])
        as_ = int(r["ga"])
        if hs > as_:
            ph, pa = 3.0, 0.0
        elif hs == as_:
            ph, pa = 1.0, 1.0
        else:
            ph, pa = 0.0, 3.0
        match_pts[str(r["match"])] = (ph, pa)

    def bucket_min(t: float) -> int:
        t = float(t)
        t = max(0.0, min(89.9, t))
        # bv. 0–14, 15–29, 30–44, 45–59, 60–74, 75–89
        return int(t // 15 * 15)

    def clamp(x: float, lo: int, hi: int) -> int:
        xi = int(round(x))
        return max(lo, min(hi, xi))

    # stats[key] = [sum_points, count]
    stats = defaultdict(lambda: [0.0, 0])

    for row in seg_df.itertuples(index=False):
        mid = str(row.match)
        if mid not in match_pts:
            continue
        ph, pa = match_pts[mid]

        t0 = getattr(row, "t_start", 0.0)
        gd0 = getattr(row, "gd_start", 0.0)
        man0 = getattr(row, "man_diff_start", 0.0)

        mb = bucket_min(t0)
        gd_int = clamp(gd0, -3, 3)      # pool extreme scores
        man_int = clamp(man0, -2, 2)    # pool extreme manpower

        # home-perspectief
        key_home = (mb, gd_int, man_int)
        stats[key_home][0] += ph
        stats[key_home][1] += 1

        # away-perspectief (score en manpower gespiegeld)
        key_away = (mb, -gd_int, -man_int)
        stats[key_away][0] += pa
        stats[key_away][1] += 1

    lookup = {}
    total_sum = 0.0
    total_cnt = 0

    for key, (s, c) in stats.items():
        if c <= 0:
            continue
        total_sum += s
        total_cnt += c

    global_mean = (total_sum / total_cnt) if total_cnt > 0 else 1.5

    # Empirical Bayes smoothing: shrink naar global_mean
    for key, (s, c) in stats.items():
        if c > 0:
            ep_hat = (s + smooth_k * global_mean) / (c + smooth_k)
            lookup[key] = ep_hat

    def get_ep(minute, gd, man):
        mb = bucket_min(minute)
        gd_int = clamp(gd, -3, 3)
        man_int = clamp(man, -2, 2)
        return lookup.get((mb, gd_int, man_int), global_mean)

    return get_ep, global_mean


def compute_xppm_from_segments(seg_df, alpha: float = XPPM_RIDGE_ALPHA):
    """
    Expected Points Plus-Minus (xPPM) per 90 min.

    - gebruikt het gesmoothe expected-points model uit _build_expected_points_lookup
    - bouwt een plus-minus regressie zoals RAPM, maar met ander target:
        y = (ΔEP_home - ΔEP_away) / duur  (per minuut)
    - we schalen de coëfficiënten naar per 90 min
    """
    if seg_df is None or seg_df.empty:
        return {}, pd.Series(dtype=float)

    get_ep, _ = _build_expected_points_lookup(seg_df)


    # --- ELO: opponent strength correction ---
    elo_map, league_mean_elo = load_team_elo()

    def opponent_modifier(opp_team_name, k: float = 0.04):
        """
        Hoeveel moeten we expected points voor deze state verlagen/verhogen
        omdat de tegenstander sterker/zwakker is dan het league-gemiddelde?

        k ~ 0.04 => 100 ELO verschil ≈ 0.04 expected points correctie.
        """
        if not elo_map:
            return 0.0
        elo = elo_map.get(opp_team_name, league_mean_elo)
        return k * (elo - league_mean_elo) / 100.0

    def get_ep_corrected(minute, gd, man, opponent_team):
        """
        Base-EP uit het gesmoothe state-model,
        gecorrigeerd voor ELO van de tegenstander.
        """
        base_ep = get_ep(minute, gd, man)
        return base_ep - opponent_modifier(opponent_team)



    # alle spelers
    all_players = sorted(
        set(p for lst in seg_df["home_players"] for p in lst) |
        set(p for lst in seg_df["away_players"] for p in lst)
    )
    if not all_players:
        return {}, pd.Series(dtype=float)

    idx_map = {p: i for i, p in enumerate(all_players)}
    n_pl = len(all_players)
    n_seg = len(seg_df)
    intercept_idx = n_pl

    # 2 rijen per segment
    n_rows = 2 * n_seg
    X = np.zeros((n_rows, n_pl + 1), dtype=float)
    y = np.zeros(n_rows, dtype=float)
    w = np.zeros(n_rows, dtype=float)

    for k, row in enumerate(seg_df.itertuples(index=False)):
        dur = float(row.duration) if row.duration else 1.0
        if dur <= 0:
            dur = 1.0

        # Expected Points begin/einde
        t0 = getattr(row, "t_start", 0.0)
        t1 = getattr(row, "t_end", t0 + dur)

        gd0 = getattr(row, "gd_start", 0.0)
        gd1 = getattr(row, "gd_end", gd0 + float(row.gd_delta))

        man0 = getattr(row, "man_diff_start", 0.0)
        man1 = getattr(row, "man_diff_end", man0)

        # teamnamen uit segment (zoals je ze in segments hebt gezet)
        home_team = getattr(row, "home", None)
        away_team = getattr(row, "away", None)

        # Expected Points MET ELO-correctie voor tegenstander
        ep_home_start = get_ep_corrected(t0, gd0, man0, away_team)
        ep_home_end   = get_ep_corrected(t1, gd1, man1, away_team)

        ep_away_start = get_ep_corrected(t0, -gd0, -man0, home_team)
        ep_away_end   = get_ep_corrected(t1, -gd1, -man1, home_team)


        d_home = ep_home_end - ep_home_start
        d_away = ep_away_end - ep_away_start

        # target = verschil in EP-verandering per minuut
        y_home_val = (d_home - d_away) / dur

        # Home-rij
        r_home = 2 * k
        y[r_home] = y_home_val
        w[r_home] = dur
        for p in row.home_players:
            X[r_home, idx_map[p]] += 1.0
        for p in row.away_players:
            X[r_home, idx_map[p]] -= 1.0
        X[r_home, intercept_idx] = 1.0

        # Away-rij (spiegel)
        r_away = r_home + 1
        y[r_away] = -y_home_val
        w[r_away] = dur
        for p in row.away_players:
            X[r_away, idx_map[p]] += 1.0
        for p in row.home_players:
            X[r_away, idx_map[p]] -= 1.0
        X[r_away, intercept_idx] = 1.0

    # Ridge-regressie (alleen xPPM, RAPM blijft alpha=80 in een andere functie)
    model = Ridge(alpha=alpha, fit_intercept=False)
    model.fit(X, y, sample_weight=w)

    # coefs per 90 min
    coef = model.coef_[:n_pl] * 90.0

    # -------- onzekerheid (SE, CI, z-score) --------
    try:
        XtW = X.T * w           # (p+1, n_rows)
        XtWX = XtW @ X          # (p+1, p+1)

        ridge_mat = XtWX + alpha * np.eye(XtWX.shape[0])
        ridge_inv = np.linalg.inv(ridge_mat)

        y_pred = model.predict(X)
        resid = y - y_pred
        rss = float(np.sum(w * resid**2))

        hat_mat = XtWX @ ridge_inv
        df_eff = float(np.trace(hat_mat))
        denom = max(len(y) - df_eff, 1.0)
        sigma2 = rss / denom

        var_beta = np.diag(ridge_inv) * sigma2
        se = np.sqrt(var_beta[:n_pl]) * 90.0

        ci_low = coef - 1.96 * se
        ci_high = coef + 1.96 * se
        z = np.divide(
            coef,
            se,
            out=np.zeros_like(coef),
            where=se > 0,
        )

        se_s = pd.Series(se, index=all_players)
        ci_low_s = pd.Series(ci_low, index=all_players)
        ci_high_s = pd.Series(ci_high, index=all_players)
        z_s = pd.Series(z, index=all_players)
    except Exception as e:
        print(f"[WARN] kon onzekerheid voor xPPM niet berekenen: {e}")
        se_s = pd.Series(dtype=float)
        ci_low_s = pd.Series(dtype=float)
        ci_high_s = pd.Series(dtype=float)
        z_s = pd.Series(dtype=float)

    return {
        "xppm": pd.Series(coef, index=all_players),
        "se": se_s,
        "ci_low": ci_low_s,
        "ci_high": ci_high_s,
        "z": z_s,
    }, seg_df




# --------------------------------------------------------------------
# hoofd-functie: aggregaties per speler + RAPM_per90
# --------------------------------------------------------------------
def build_player_stats():
    # 1) data inladen
    df = pd.read_csv(PLAYER_INPUT)

    # booleans normaliseren
    def to_bool(s):
        return str(s).strip().lower() in ("true", "1", "yes")

    for col in ["Starting Player", "Substituted In", "Substituted Out",
                "Is Goalkeeper", "Is Captain", "Clean Sheet"]:
        if col in df.columns:
            df[col] = df[col].apply(to_bool)
        else:
            df[col] = False

    num_cols = [
        "Minutes Played", "Goals Scored", "Penalties Scored", "Own Goals Scored",
        "Yellow Cards", "YellowRed Cards", "Red Cards", "Result P",
    ]
    for c in num_cols:
        if c in df.columns:
            df[c] = pd.to_numeric(df[c], errors="coerce")
        else:
            df[c] = np.nan

    # 2) datum erbij via kalender
    cal = load_calendar()
    df = df.merge(cal, left_on="Match URL", right_on="url", how="left")
    df["date"] = pd.to_datetime(df["date"])

    # match events inladen (voor RAPM)
    match_events = pd.read_csv(MATCH_EVENTS)

    # 2b) laatste 5 ploegwedstrijden per team bepalen
    team_last5_urls = {}
    for team_name, tdf in df.groupby("Team"):
        team_matches = (
            tdf[["Match URL", "date"]]
            .drop_duplicates(subset=["Match URL"])
            .sort_values("date")
        )
        last5_matches = team_matches.tail(5)["Match URL"].tolist()
        team_last5_urls[team_name] = set(last5_matches)

    # 3) aggregatie per speler
    records = []

    for (team, player), g in df.groupby(["Team", "Player Name"]):
        g = g.sort_values("date")
        if not team or not player:
            continue

        sel = len(g)
        started = int(g["Starting Player"].sum())
        sub_in = int(g["Substituted In"].sum())
        sub_out = int(g["Substituted Out"].sum())
        minutes = int(g["Minutes Played"].fillna(0).sum())

        goals = int(g["Goals Scored"].fillna(0).sum())
        pens = int(g["Penalties Scored"].fillna(0).sum())
        og = int(g["Own Goals Scored"].fillna(0).sum())
        yellow = int(g["Yellow Cards"].fillna(0).sum())
        y2 = int(g["YellowRed Cards"].fillna(0).sum())
        red = int(g["Red Cards"].fillna(0).sum())

        clean_sheets = int(g["Clean Sheet"].astype(int).sum())
        captain = int(g["Is Captain"].astype(int).sum())
        ptype = "Keeper" if g["Is Goalkeeper"].any() else "Speler"

        # MVP p>20/90min: minuten-gewogen Result P voor wedstrijden met >20 min
        g20 = g[g["Minutes Played"] > 20].copy()
        if not g20.empty:
            rp = g20["Result P"].fillna(0)
            mins_20 = g20["Minutes Played"].fillna(0)
            total_pts = (rp * mins_20).sum()
            total_min_20 = mins_20.sum()
            mvp = round(total_pts / total_min_20, 3) if total_min_20 > 0 else 0.0
        else:
            mvp = 0.0

        if minutes > 0:
            goals90 = round(goals / (minutes / 90.0), 3)
            yellow90 = round(yellow / (minutes / 90.0), 3)
        else:
            goals90 = 0.0
            yellow90 = 0.0

        # laatste 5 ploegwedstrijden
        team_urls = team_last5_urls.get(team, set())
        last5 = g[g["Match URL"].isin(team_urls)].sort_values("date")

        sel_l5 = len(last5)
        started_l5 = int(last5["Starting Player"].sum())
        sub_in_l5 = int(last5["Substituted In"].sum())
        sub_out_l5 = int(last5["Substituted Out"].sum())
        min_l5 = int(last5["Minutes Played"].fillna(0).sum())
        goals_l5 = int(last5["Goals Scored"].fillna(0).sum())
        pens_l5 = int(last5["Penalties Scored"].fillna(0).sum())
        og_l5 = int(last5["Own Goals Scored"].fillna(0).sum())
        yellow_l5 = int(last5["Yellow Cards"].fillna(0).sum())
        y2_l5 = int(last5["YellowRed Cards"].fillna(0).sum())
        red_l5 = int(last5["Red Cards"].fillna(0).sum())
        cs_l5 = int(last5["Clean Sheet"].astype(int).sum())
        cap_l5 = int(last5["Is Captain"].astype(int).sum())

        rec = {
            "Team": team,
            "Speler": player,
            "Selecties": sel,
            "Gestart": started,
            "Ingevallen": sub_in,
            "Vervangen": sub_out,
            "Speelminuten": minutes,
            "Goals": goals,
            "Penalties": pens,
            "Own Goals": og,
            "Geel": yellow,
            "Dubbelgeel": y2,
            "Rood": red,
            "Clean sheets": clean_sheets,
            "Kapitein": captain,
            "Type": ptype,
            "MVP p>20/90min": mvp,      # wordt later in JSON overschreven door RAPM
            "Goals/90min": goals90,
            "Geel/90min": yellow90,

            # laatste 5
            "Selecties L5": sel_l5,
            "Gestart L5": started_l5,
            "Ingevallen L5": sub_in_l5,
            "Vervangen L5": sub_out_l5,
            "Speelminuten L5": min_l5,
            "Goals L5": goals_l5,
            "Penalties L5": pens_l5,
            "Own goals L5": og_l5,
            "Geel L5": yellow_l5,
            "Dubbelgeel L5": y2_l5,
            "Rood L5": red_l5,
            "Clean sheet L5": cs_l5,
            "Kapitein L5": cap_l5,
        }

        records.append(rec)

    # 4) records -> DataFrame
    out = pd.DataFrame(records)

    # 5) RAPM (totaal/offensief/defensief) per speler berekenen en toevoegen
    try:
        match_events = pd.read_csv(MATCH_EVENTS)
        rapm_dict, seg_df = compute_rapm_from_logs(
            df, match_events, split_off_def=True, return_segments=True
        )
        rapm_tot = rapm_dict.get("total", pd.Series(dtype=float))
        rapm_off = rapm_dict.get("off",   pd.Series(dtype=float))
        rapm_def = rapm_dict.get("def",   pd.Series(dtype=float))

        rapm_se = rapm_dict.get("total_se", pd.Series(dtype=float))
        rapm_ci_low = rapm_dict.get("total_ci_low", pd.Series(dtype=float))
        rapm_ci_high = rapm_dict.get("total_ci_high", pd.Series(dtype=float))
        rapm_z = rapm_dict.get("total_z", pd.Series(dtype=float))

        # 🔽 NIEUW: xPPM uit dezelfde segmenten
        xppm_dict, _ = compute_xppm_from_segments(seg_df)

        xppm_val = xppm_dict.get("xppm", pd.Series(dtype=float))
        xppm_se  = xppm_dict.get("se", pd.Series(dtype=float))
        xppm_ci_low  = xppm_dict.get("ci_low", pd.Series(dtype=float))
        xppm_ci_high = xppm_dict.get("ci_high", pd.Series(dtype=float))
        xppm_z   = xppm_dict.get("z", pd.Series(dtype=float))

    except Exception as e:
        print(f"[WARN] RAPM/xPPM kon niet berekend worden: {e}")
        rapm_tot = pd.Series(dtype=float)
        rapm_off = pd.Series(dtype=float)
        rapm_def = pd.Series(dtype=float)
        rapm_se = pd.Series(dtype=float)
        rapm_ci_low = pd.Series(dtype=float)
        rapm_ci_high = pd.Series(dtype=float)
        rapm_z = pd.Series(dtype=float)

        xppm_val = pd.Series(dtype=float)
        xppm_se = pd.Series(dtype=float)
        xppm_ci_low = pd.Series(dtype=float)
        xppm_ci_high = pd.Series(dtype=float)
        xppm_z = pd.Series(dtype=float)


    out["RAPM_per90"]       = out["Speler"].map(rapm_tot).round(3)
    out["RAPM_off_per90"]   = out["Speler"].map(rapm_off).round(3)
    out["RAPM_def_per90"]   = out["Speler"].map(rapm_def).round(3)

    # nieuwe onzekerheidskolommen
    out["RAPM_SE_per90"]    = out["Speler"].map(rapm_se).round(3)
    out["RAPM_CI_low"]      = out["Speler"].map(rapm_ci_low).round(3)
    out["RAPM_CI_high"]     = out["Speler"].map(rapm_ci_high).round(3)
    out["RAPM_z"]           = out["Speler"].map(rapm_z).round(2)

    # 🔽 NIEUW: xPPM
    out["xPPM_per90"]       = out["Speler"].map(xppm_val).round(3)
    out["xPPM_SE"]          = out["Speler"].map(xppm_se).round(3)
    out["xPPM_CI_low"]      = out["Speler"].map(xppm_ci_low).round(3)
    out["xPPM_CI_high"]     = out["Speler"].map(xppm_ci_high).round(3)
    out["xPPM_z"]           = out["Speler"].map(xppm_z).round(2)

    # =========================
    # SAFE IMPACT (conservatief)
    # =========================
    # Idee: als de schatting positief is → neem ondergrens CI (worst case)
    #      als de schatting negatief is → neem bovengrens CI (least bad case)
    # Zo krijg je een "conservatieve" score die je als scout durft te gebruiken.

    rapm = pd.to_numeric(out.get("RAPM_per90"), errors="coerce").fillna(0.0)
    rapm_ci_low = pd.to_numeric(out.get("RAPM_CI_low"), errors="coerce").fillna(0.0)
    rapm_ci_high = pd.to_numeric(out.get("RAPM_CI_high"), errors="coerce").fillna(0.0)

    xppm = pd.to_numeric(out.get("xPPM_per90"), errors="coerce").fillna(0.0)
    xppm_ci_low = pd.to_numeric(out.get("xPPM_CI_low"), errors="coerce").fillna(0.0)
    xppm_ci_high = pd.to_numeric(out.get("xPPM_CI_high"), errors="coerce").fillna(0.0)

    out["RAPM_safe_per90"] = np.where(rapm >= 0, rapm_ci_low, rapm_ci_high).round(3)
    out["xPPM_safe_per90"] = np.where(xppm >= 0, xppm_ci_low, xppm_ci_high).round(3)

    # Optioneel: gecombineerde safe impact (voor eenvoudige shortlists)
    out["SafeImpact_per90"] = (out["RAPM_safe_per90"] + out["xPPM_safe_per90"]).round(3)


    # ========= Scouting metrics: S/N, betrouwbaarheid, impactscore =========

    # veilige numerieke kopieën
    mins = pd.to_numeric(out.get("Speelminuten"), errors="coerce").fillna(0.0)

    rapm = pd.to_numeric(out.get("RAPM_per90"), errors="coerce")
    rapm_se = pd.to_numeric(out.get("RAPM_SE_per90"), errors="coerce").replace(0, np.nan)

    xppm = pd.to_numeric(out.get("xPPM_per90"), errors="coerce")
    xppm_se = pd.to_numeric(out.get("xPPM_SE"), errors="coerce").replace(0, np.nan)

    # signaal/ruis-ratio's
    out["RAPM_SNR"] = (rapm.abs() / rapm_se).replace([np.inf, -np.inf], np.nan).round(3)
    out["xPPM_SNR"] = (xppm.abs() / xppm_se).replace([np.inf, -np.inf], np.nan).round(3)

    # Minutes series (voor minutenfactor & confidence)
    mins_series = pd.to_numeric(
        out.get("Speelminuten", out.get("Minutes Played", 0.0)),
        errors="coerce"
    ).fillna(0.0)

    # --- minutes (robust) ---
    mins_series = pd.to_numeric(
        out.get("Speelminuten", out.get("Minutes Played", 0.0)),
        errors="coerce"
    ).fillna(0.0)


    # Minutenfactor op basis van percentiel (dynamisch doorheen seizoen)
    # Neem bv. p80 als "ongeveer vaste basisspeler" referentie
    mins_ref = float(mins[mins > 0].quantile(0.80)) if (mins > 0).any() else 1.0
    mins_ref = max(mins_ref, 1.0)
    minutes_factor = np.clip(mins / mins_ref, 0, 1)


    def snr_to_conf(snr):
        """
        SNR → betrouwbaarheid. Sterke non-lineaire schaal.
        - snr < 0.5  → bijna geen vertrouwen
        - snr = 1.0  → 40% vertrouwen
        - snr = 2.0  → 67% vertrouwen
        - snr = 3.0  → 75% vertrouwen
        """
        if pd.isna(snr) or snr <= 0:
            return 0.0
        return snr / (snr + 1.5)  # sterkere demping dan +1.0

    
    # SNR → [0,1]
    rapm_snr_factor = out["RAPM_SNR"].apply(snr_to_conf)
    xppm_snr_factor = out["xPPM_SNR"].apply(snr_to_conf)


    # combineer SNR's (als beide bestaan, anders neem wat er is, anders 0)
    snr_combined = np.where(out["RAPM_SNR"].notna(), rapm_snr_factor, 0.0)

    # totale betrouwbaarheid (0–1)
    reliability = np.sqrt(minutes_factor * snr_combined)
    out["Reliability_overall"] = np.round(reliability, 3)

        # -------------------------
    # StabilityScore (los van Reliability)
    # Idee: stabiliteit = laag model-onzekerheid (SE) -> hoge score
    # -------------------------
    rapm_se_num = pd.to_numeric(out.get("RAPM_SE_per90"), errors="coerce").replace(0, np.nan)
    xppm_se_num = pd.to_numeric(out.get("xPPM_SE"), errors="coerce").replace(0, np.nan)

    # combineer onzekerheid (als 1 ontbreekt: neem de andere)
    se_combined = rapm_se_num


    # Zet SE om naar 0–1 stabiliteit (kleinere SE -> dichter bij 1)
    # schaalparameter bepaalt strengheid: 1.0 is redelijk, 0.5 is strenger, 2.0 is milder
    se_scale = 1.0
    stability = 1.0 / (1.0 + (se_combined / se_scale))
    out["StabilityScore"] = pd.Series(stability).fillna(0.0).clip(0, 1).round(3)



    # =========================
    # IMPACTSCORE (voor dashboard) = RAPM_safe_per90
    # =========================
    out["ImpactScore"] = pd.to_numeric(out.get("RAPM_per90"), errors="coerce").fillna(0.0).round(3)


    # =========================
    # FINAL SCOUTING SCORE (FSS) op speler-out
    # =========================
    impact_vals = pd.to_numeric(out.get("ImpactScore"), errors="coerce").fillna(0.0)

    # robust normaliseren via percentielen
    p10 = float(impact_vals.quantile(0.10))
    p90 = float(impact_vals.quantile(0.90))
    denom = (p90 - p10) if (p90 - p10) != 0 else 1.0

    out["Impact_norm"] = ((impact_vals - p10) / denom).clip(0, 1).round(3)

    # minutenfactor: logistiek (900 min ~ kantelpunt)
    mins = pd.to_numeric(out.get("Speelminuten"), errors="coerce").fillna(0.0)
    # Minutes_factor (logistische groei) rond percentiel i.p.v. vaste 900
    mins_series = pd.to_numeric(out["Speelminuten"], errors="coerce").fillna(0.0)

    # Middenpunt: p60 minuten (typische rotatie/basis grens)
    m = float(mins_series[mins_series > 0].quantile(0.60)) if (mins_series > 0).any() else 0.0

    # Schaal: spreiding tussen p60 en p90 (hoe snel de logistiek stijgt)
    p90 = float(mins_series[mins_series > 0].quantile(0.90)) if (mins_series > 0).any() else (m + 1.0)
    s = max((p90 - m) / 2.0, 1.0)  # vermijd 0

    out["Minutes_factor"] = 1 / (1 + np.exp(-(mins_series - m) / s))
    out["Minutes_factor"] = out["Minutes_factor"].clip(0, 1).round(3)


    # Confidence: combineer betrouwbaarheid + stabiliteit + minuten
    rel = pd.to_numeric(out.get("Reliability_overall"), errors="coerce").fillna(0.0).clip(0, 1)
    stab = pd.to_numeric(out.get("StabilityScore"), errors="coerce").fillna(0.0).clip(0, 1)
    mf = pd.to_numeric(out.get("Minutes_factor"), errors="coerce").fillna(0.0).clip(0, 1)

    out["Confidence"] = (np.sqrt(rel * stab) * np.sqrt(mf)).clip(0, 1).round(3)

    out["FinalScoutingScore"] = (out["Impact_norm"] * out["Confidence"] * out["Minutes_factor"]).clip(0, 1).round(3)

    # =========================
    # PERCENTIELEN (voor dynamische filters)
    # =========================
    def pct_rank(s: pd.Series):
        s = pd.to_numeric(s, errors="coerce")
        # pct=True geeft [0,1] percentielen; fillna 0 voor spelers zonder data
        return s.rank(pct=True).fillna(0.0)

    out["Min_pct"]        = pct_rank(out["Speelminuten"]).round(3)
    out["Reliab_pct"]     = pct_rank(out["Reliability_overall"]).round(3)
    out["Impact_pct"]     = pct_rank(out["ImpactScore"]).round(3)
    out["FSS_pct"]        = pct_rank(out["FinalScoutingScore"]).round(3)

    # Safe impact percentielen (nieuw)
    out["RAPM_safe_pct"]  = pct_rank(out["RAPM_safe_per90"]).round(3)
    out["xPPM_safe_pct"]  = pct_rank(out["xPPM_safe_per90"]).round(3)
    out["SafeImpact_pct"] = pct_rank(out["SafeImpact_per90"]).round(3)

    # =========================
    # ROLE HINT (zonder positie)
    # =========================
    started = pd.to_numeric(out.get("Gestart"), errors="coerce").fillna(0.0)
    sub_in  = pd.to_numeric(out.get("Ingevallen"), errors="coerce").fillna(0.0)
    apps    = pd.to_numeric(out.get("Selecties"), errors="coerce").fillna(0.0)

    start_share = np.divide(started, apps, out=np.zeros_like(started), where=apps > 0)
    sub_share   = np.divide(sub_in, apps, out=np.zeros_like(sub_in), where=apps > 0)

    # rol op basis van speelminuten-percentiel en start/sub ratio
    out["Role_hint"] = np.select(
        [
            (out["Min_pct"] >= 0.70) & (start_share >= 0.60),
            (out["Min_pct"] >= 0.40) & (start_share >= 0.35),
            (sub_share >= 0.50) & (out["Min_pct"] < 0.50),
            (out["Min_pct"] < 0.20),
        ],
        [
            "Vaste waarde",
            "Rotatiespeler",
            "Impact-invaller",
            "Fringe / beperkte rol",
        ],
        default="Onbekend profiel",
    )


    # =========================
    # EXPLAINABILITY (percentiel-gedreven)
    # =========================

    # Impact: safe impact is scoutbaar
    out["Explain_Impact"] = np.select(
        [
            out["RAPM_safe_per90"] > 0,
            out["RAPM_per90"] > 0,
            out["RAPM_per90"] < 0,
        ],
        [
            "Conservatief positief: zelfs worst-case blijft RAPM > 0",
            "Positief, maar onzeker: CI kruist 0",
            "Negatief impactsignaal in deze periode",
        ],
        default="Onvoldoende info / geen impactsignaal"
    )

    # Betrouwbaarheid: gebruik percentiel i.p.v. vaste 0.7
    out["Explain_Reliability"] = np.select(
        [
            out["Reliab_pct"] >= 0.75,
            out["Reliab_pct"] >= 0.50,
            out["Reliab_pct"] > 0,
        ],
        [
            "Hoog vertrouwen: veel signaal en/of veel minuten t.o.v. competitie",
            "Matig vertrouwen: bruikbaar maar context/video check aanbevolen",
            "Laag vertrouwen: beperkte sample of veel ruis",
        ],
        default="Geen betrouwbaarheidsschatting"
    )

    # Stability: je StabilityScore is eigenlijk 1/(1+SE) → gebruik percentiel
    out["Explain_Stability"] = np.select(
        [
            pct_rank(out["StabilityScore"]) >= 0.75,
            pct_rank(out["StabilityScore"]) >= 0.50,
            pct_rank(out["StabilityScore"]) > 0,
        ],
        [
            "Stabiel profiel (relatief lage onzekerheid)",
            "Gemiddelde stabiliteit",
            "Volatiel profiel (relatief hoge onzekerheid)",
        ],
        default="Geen stabiliteitsinfo"
    )

    # =========================
    # PROFIELSAMENVATTING (1 zin)
    # =========================
    # “waarom target?” in scout-taal, zonder positie

    # vergelijking RAPM vs xPPM: structuur vs output
    diff = (pd.to_numeric(out["RAPM_z"], errors="coerce").fillna(0.0)
            - pd.to_numeric(out["xPPM_z"], errors="coerce").fillna(0.0))

    style = np.select(
        [diff >= 0.75, diff <= -0.75],
        ["Meer structurele impact (RAPM gedreven)", "Meer output-gedreven (xPPM gedreven)"],
        default="Gemengd impactprofiel"
    )

    out["Profile"] = (
        out["Role_hint"].astype(str)
        + " | " + style.astype(str)
        + " | SafeImpact pctl " + (out["SafeImpact_pct"] * 100).round(0).astype(int).astype(str)
        + " | Betrouwbaarheid pctl " + (out["Reliab_pct"] * 100).round(0).astype(int).astype(str)
    )

    # =========================
    # SHORTLIST FLAGS (rol-presets)
    # =========================

    # 1) Undervalued impact: hoge safe impact, lagere minuten
    out["SL_undervalued"] = (
        (out["SafeImpact_pct"] >= 0.80) &
        (out["Min_pct"] <= 0.50) &
        (out["Reliab_pct"] >= 0.50)
    )

    # 2) Betrouwbare teamverbeteraar: hoge safe impact + hoge betrouwbaarheid
    out["SL_reliable"] = (
        (out["SafeImpact_pct"] >= 0.75) &
        (out["Reliab_pct"] >= 0.75) &
        (out["Min_pct"] >= 0.60)
    )

    # 3) High ceiling / high risk: extreme RAPM, maar onzeker (safe niet positief)
    out["SL_high_ceiling"] = (
        (pct_rank(out["RAPM_per90"]) >= 0.90) &
        (out["RAPM_safe_per90"] <= 0) &
        (out["Min_pct"] <= 0.50)
    )

    # 4) Output merchant: hoge xPPM, maar RAPM niet mee
    out["SL_output_only"] = (
        (out["xPPM_safe_pct"] >= 0.80) &
        (out["RAPM_safe_pct"] <= 0.50)
    )


    # ====== RAPM R² (overall + per speeldag) ======

    # n_seg & n_pl opnieuw bepalen op basis van seg_df en rapm_tot
    if seg_df is not None and not seg_df.empty:
        n_seg = len(seg_df)
        all_players_list = list(rapm_tot.index)
        idx_map = {p: i for i, p in enumerate(all_players_list)}
        n_pl = len(all_players_list)
        intercept_idx = n_pl
    else:
        n_seg = 0
        n_pl = 0

    rapm_r2_overall = None

    try:
        X_tot = np.zeros((n_seg, n_pl + 1), dtype=float)
        y_tot = np.zeros(n_seg, dtype=float)
        w_tot = np.zeros(n_seg, dtype=float)

        for i, row in seg_df.iterrows():
            dur = float(row.get("duration", 0.0)) or 1.0
            if dur <= 0:
                dur = 1.0

            gf = float(row.get("gf", 0.0))
            ga = float(row.get("ga", 0.0))

            y_tot[i] = (gf - ga) / dur
            w_tot[i] = dur

            for p in row["home_players"]:
                j = idx_map.get(p)
                if j is not None:
                    X_tot[i, j] += 1.0
            for p in row["away_players"]:
                j = idx_map.get(p)
                if j is not None:
                    X_tot[i, j] -= 1.0

            X_tot[i, intercept_idx] = 1.0

        model_tot = Ridge(alpha=80.0, fit_intercept=False)
        model_tot.fit(X_tot, y_tot, sample_weight=w_tot)
        y_hat = model_tot.predict(X_tot)

        if w_tot.sum() > 0:
            y_bar = np.average(y_tot, weights=w_tot)
        else:
            y_bar = float(y_tot.mean()) if len(y_tot) else 0.0

        ss_tot = np.sum(w_tot * (y_tot - y_bar) ** 2)
        ss_res = np.sum(w_tot * (y_tot - y_hat) ** 2)
        rapm_r2_overall = float(1.0 - ss_res / ss_tot) if ss_tot > 0 else 0.0

        # ---------- R² per speeldag ----------
        r2_by_round = []

        if "match" in seg_df.columns:
            match_ids = seg_df["match"].tolist()
        else:
            match_ids = None

        if match_ids:
            boundaries = []
            last_id = match_ids[0]
            for idx, mid in enumerate(match_ids, start=1):
                if mid != last_id:
                    boundaries.append(idx - 1)
                    last_id = mid
            boundaries.append(len(match_ids))

            for round_idx, end_idx in enumerate(boundaries, start=1):
                n_used = end_idx
                if n_used < 10:
                    continue

                X_sub = X_tot[:n_used]
                y_sub = y_tot[:n_used]
                w_sub = w_tot[:n_used]

                model_sub = Ridge(alpha=80.0, fit_intercept=False)
                model_sub.fit(X_sub, y_sub, sample_weight=w_sub)
                y_hat_sub = model_sub.predict(X_sub)

                if w_sub.sum() > 0:
                    y_bar_sub = np.average(y_sub, weights=w_sub)
                else:
                    y_bar_sub = float(y_sub.mean()) if len(y_sub) else 0.0

                ss_tot_sub = np.sum(w_sub * (y_sub - y_bar_sub) ** 2)
                ss_res_sub = np.sum(w_sub * (y_sub - y_hat_sub) ** 2)
                r2_val = float(1 - ss_res_sub / ss_tot_sub) if ss_tot_sub > 0 else 0.0

                r2_by_round.append({
                    "round": int(round_idx),
                    "segments": int(n_used),
                    "R2": r2_val,
                })

        if rapm_r2_overall is not None:
            out["RAPM_R2_overall"] = rapm_r2_overall

        if len(r2_by_round) > 0:
            out["RAPM_R2_by_round"] = json.dumps(r2_by_round, ensure_ascii=False)

    except Exception as e:
        print(f"[WARN] kon RAPM_R2_overall niet berekenen: {e}")



    # 6) wegschrijven
    out.to_csv(OUTPUT_PATH, index=False, encoding="utf8")
    print(f"Saved: {OUTPUT_PATH}")



# --------------------------------------------------------------------
# NEW: build a player stats dataframe from arbitrary subsets (for history)
# --------------------------------------------------------------------
def _to_bool_series(s: pd.Series) -> pd.Series:
    return s.astype(str).str.strip().str.lower().isin(["true", "1", "yes"])

def _compute_scouting_scores(out: pd.DataFrame) -> pd.DataFrame:
    """Compute the minimal set of scouting columns used by the dashboard:
    ImpactScore, Confidence, FinalScoutingScore (+ supporting cols).
    This mirrors the season-level logic but is safe for partial-season snapshots.
    """
    out = out.copy()

    # Ensure numerics exist
    for c in [
        "Speelminuten",
        "RAPM_per90","RAPM_SE_per90","RAPM_CI_low","RAPM_CI_high","RAPM_z",
        "xPPM_per90","xPPM_SE","xPPM_CI_low","xPPM_CI_high","xPPM_z",
    ]:
        if c not in out.columns:
            out[c] = 0.0


    # --- minutes series (ALTIJD definiëren; nodig voor snapshots / history) ---
    mins_series = pd.to_numeric(
        out.get("Speelminuten", out.get("Minutes Played", 0.0)),
        errors="coerce"
    ).fillna(0.0)
    out["Speelminuten"] = mins_series

    # =========================
    # SAFE IMPACT (coach-proof, RAPM-only)
    # =========================
    # We gebruiken SE (niet 95% CI) om een conservatieve impact te bouwen.
    # 95% CI op goal-based RAPM binnen 1 seizoen is vaak te breed => onrealistische safe-waarden.
    # Daarom: "1-sigma safe" (≈ 68%) + clamp rond 0.
    # Optioneel: cap extreme SE's (p90) om outliers te vermijden.

    rapm = pd.to_numeric(out.get("RAPM_per90"), errors="coerce").fillna(0.0)
    rapm_se = pd.to_numeric(out.get("RAPM_SE_per90"), errors="coerce").replace(0, np.nan)

    # Cap SE om extreme onzekerheid niet te laten domineren (1 seizoen + goals is noisy)
    se_cap = float(rapm_se.dropna().quantile(0.90)) if rapm_se.notna().any() else np.nan
    rapm_se_cap = rapm_se.clip(upper=se_cap) if pd.notna(se_cap) else rapm_se
    rapm_se_cap = rapm_se_cap.fillna(0.0)

    z_safe = 1.0  # 1-sigma safe (coach-proof; 1.96 is te streng/noisy met goals-only)

    safe_pos = (rapm - z_safe * rapm_se_cap)
    safe_neg = (rapm + z_safe * rapm_se_cap)

    # Clamp rond 0: positieve impact kan niet "conservatief" negatief worden en omgekeerd
    out["RAPM_safe_per90"] = np.where(rapm >= 0, np.maximum(0.0, safe_pos), np.minimum(0.0, safe_neg)).round(3)

    # Voor scouting gebruiken we enkel RAPM-safe als "SafeImpact"
    out["SafeImpact_per90"] = out["RAPM_safe_per90"].round(3)


    # SNR
    rapm_se = pd.to_numeric(out.get("RAPM_SE_per90"), errors="coerce").replace(0, np.nan)
    #xppm_se = pd.to_numeric(out.get("xPPM_SE"), errors="coerce").replace(0, np.nan)

    out["RAPM_SNR"] = (rapm.abs() / rapm_se).replace([np.inf, -np.inf], np.nan)
    out["xPPM_SNR"] = np.nan

    # Minutes factor (dynamic, based on pct within snapshot)
    mins_ref = float(mins_series[mins_series > 0].quantile(0.80)) if (mins_series > 0).any() else 1.0
    mins_ref = max(mins_ref, 1.0)
    minutes_factor_linear = np.clip(mins_series / mins_ref, 0, 1)

    def snr_to_conf(snr):
        if pd.isna(snr) or snr <= 0:
            return 0.0
        return float(snr / (snr + 1.5))

    rapm_snr_factor = out["RAPM_SNR"].apply(snr_to_conf)
    xppm_snr_factor = out["xPPM_SNR"].apply(snr_to_conf)

    snr_combined = np.where(out["RAPM_SNR"].notna(), rapm_snr_factor, 0.0)


    reliability = np.sqrt(minutes_factor_linear * snr_combined)
    out["Reliability_overall"] = np.round(pd.Series(reliability).fillna(0.0).clip(0, 1), 3)

    # Stability (low SE -> high)
    se_combined = pd.Series(rapm_se)

    se_scale = 1.0
    stability = 1.0 / (1.0 + (pd.Series(se_combined) / se_scale))
    out["StabilityScore"] = np.round(pd.Series(stability).fillna(0.0).clip(0, 1), 3)

    # =========================
    # IMPACTSCORE (RAPM estimate) + SAFE (for robustness)
    # =========================
    # Definitie:
    # - ImpactScore = RAPM_per90 (estimate; direction & magnitude)
    # - RAPM_safe_per90 blijft bestaan als conservatieve ondergrens (niet gebruiken als ranking op 1 seizoen)
    #
    # Waarom:
    # RAPM_safe_per90 (lower bound) is met 1 seizoen + goals vaak bijna altijd negatief (te conservatief),
    # wat FSS kan platdrukken. Coaches hebben een bruikbaar "signaal" nodig (ImpactScore) + zekerheid (Confidence).

    # =========================
    # IMPACTSCORE (RAPM estimate) + SAFE (for robustness)
    # =========================
    # ImpactScore = RAPM_per90 (estimate; direction & magnitude).
    # RAPM_safe_per90 blijft bestaan als conservatieve ondergrens (niet gebruiken als ranking op 1 seizoen).

    out["ImpactScore"] = pd.to_numeric(out.get("RAPM_per90"), errors="coerce").fillna(0.0).round(3)

    # Impact confidence: strength of signal (not a ranking metric)
    rapm_vals = pd.to_numeric(out.get("RAPM_per90"), errors="coerce").fillna(0.0)
    rapm_se_vals = pd.to_numeric(out.get("RAPM_SE_per90"), errors="coerce").replace(0, np.nan)
    out["Impact_confidence"] = (
        (rapm_vals.abs() / rapm_se_vals)
        .replace([np.inf, -np.inf], np.nan)
        .fillna(0.0)
        .clip(0, 2)
        .round(3)
    )

    # Robust z-score normalisatie binnen competitie/snapshot:
    # z_robust = (x - median) / MAD, gecapt in [-3, +3]
    impact_vals = pd.to_numeric(out.get("ImpactScore"), errors="coerce").fillna(0.0)
    med = float(impact_vals.median()) if len(impact_vals) else 0.0
    mad = float((impact_vals - med).abs().median()) if len(impact_vals) else 0.0
    mad = mad if mad > 1e-9 else 1.0
    out["Impact_z_robust"] = ((impact_vals - med) / mad).clip(-3, 3).round(3)

    # Impact_norm als robuuste z-score in [-3, +3] (coach-friendly schaal)
    out["Impact_norm"] = out["Impact_z_robust"].round(3)

    # Impact_norm01 in [0,1] (handig voor UI/percentielen indien nodig)
    out["Impact_norm01"] = ((out["Impact_z_robust"] + 3.0) / 6.0).clip(0, 1).round(3)
    # Logistic minutes factor, centered at snapshot p60
    m = float(mins_series[mins_series > 0].quantile(0.60)) if (mins_series > 0).any() else 0.0
    p90m = float(mins_series[mins_series > 0].quantile(0.90)) if (mins_series > 0).any() else (m + 1.0)
    s = max((p90m - m) / 2.0, 1.0)
    out["Minutes_factor"] = (1 / (1 + np.exp(-(mins_series - m) / s))).clip(0, 1).round(3)

    rel = pd.to_numeric(out.get("Reliability_overall"), errors="coerce").fillna(0.0).clip(0, 1)
    stab = pd.to_numeric(out.get("StabilityScore"), errors="coerce").fillna(0.0).clip(0, 1)
    mf = pd.to_numeric(out.get("Minutes_factor"), errors="coerce").fillna(0.0).clip(0, 1)
    out["Confidence"] = (np.sqrt(rel * stab) * np.sqrt(mf)).clip(0, 1).round(3)

    out["FinalScoutingScore"] = (out["Impact_norm"] * out["Confidence"] * out["Minutes_factor"]).round(3)
    return out

def build_player_stats_df(player_match_df: pd.DataFrame, match_events_df: pd.DataFrame, calendar_df: pd.DataFrame | None = None) -> pd.DataFrame:
    """Build a player stats DataFrame for a given subset of matches.
    Intended for per-round snapshots for history export.
    """
    df = player_match_df.copy()

    # booleans
    for col in ["Starting Player", "Substituted In", "Substituted Out", "Is Goalkeeper", "Is Captain", "Clean Sheet"]:
        if col in df.columns:
            df[col] = _to_bool_series(df[col])
        else:
            df[col] = False

    # numerics
    num_cols = ["Minutes Played","Goals Scored","Penalties Scored","Own Goals Scored","Yellow Cards","YellowRed Cards","Red Cards","Result P"]
    for c in num_cols:
        if c in df.columns:
            df[c] = pd.to_numeric(df[c], errors="coerce")
        else:
            df[c] = np.nan

    # date merge
    if calendar_df is None:
        cal = load_calendar()
    else:
        cal = calendar_df.copy()
    if "url" in cal.columns:
        df = df.merge(cal, left_on="Match URL", right_on="url", how="left")
    df["date"] = pd.to_datetime(df.get("date"))

    records = []
    for (team, player), g in df.groupby(["Team", "Player Name"]):
        g = g.sort_values("date")
        if not team or not player:
            continue

        minutes = int(g["Minutes Played"].fillna(0).sum())
        goals = int(g["Goals Scored"].fillna(0).sum())
        yellow = int(g["Yellow Cards"].fillna(0).sum())
        started = int(g["Starting Player"].sum())
        sub_in = int(g["Substituted In"].sum())
        sub_out = int(g["Substituted Out"].sum())

        sel = len(g)
        pens = int(g["Penalties Scored"].fillna(0).sum())
        og = int(g["Own Goals Scored"].fillna(0).sum())
        y2 = int(g["YellowRed Cards"].fillna(0).sum())
        red = int(g["Red Cards"].fillna(0).sum())
        clean_sheets = int(g["Clean Sheet"].astype(int).sum())
        captain = int(g["Is Captain"].astype(int).sum())
        ptype = "Keeper" if g["Is Goalkeeper"].any() else "Speler"

        if minutes > 0:
            goals90 = round(goals / (minutes / 90.0), 3)
            yellow90 = round(yellow / (minutes / 90.0), 3)
        else:
            goals90 = 0.0
            yellow90 = 0.0

        records.append({
            "Team": team,
            "Speler": player,
            "Selecties": sel,
            "Gestart": started,
            "Ingevallen": sub_in,
            "Vervangen": sub_out,
            "Speelminuten": minutes,
            "Goals": goals,
            "Penalties": pens,
            "Own Goals": og,
            "Geel": yellow,
            "Dubbelgeel": y2,
            "Rood": red,
            "Clean sheets": clean_sheets,
            "Kapitein": captain,
            "Type": ptype,
            "Goals/90min": goals90,
            "Geel/90min": yellow90,
        })

    out = pd.DataFrame(records)
    if out.empty:
        return out

    # RAPM / xPPM on subset
    try:
        rapm_dict = compute_rapm_from_logs(df, match_events_df, split_off_def=True, return_segments=False)
        rapm_tot = rapm_dict.get("total", pd.Series(dtype=float))
        rapm_off = rapm_dict.get("off", pd.Series(dtype=float))
        rapm_def = rapm_dict.get("def", pd.Series(dtype=float))
        rapm_se = rapm_dict.get("total_se", pd.Series(dtype=float))
        rapm_ci_low = rapm_dict.get("total_ci_low", pd.Series(dtype=float))
        rapm_ci_high = rapm_dict.get("total_ci_high", pd.Series(dtype=float))
        rapm_z = rapm_dict.get("total_z", pd.Series(dtype=float))
    except Exception as e:
        print(f"[WARN] subset RAPM failed: {e}")
        rapm_tot = pd.Series(dtype=float)
        rapm_off = pd.Series(dtype=float)
        rapm_def = pd.Series(dtype=float)
        rapm_se = pd.Series(dtype=float)
        rapm_ci_low = pd.Series(dtype=float)
        rapm_ci_high = pd.Series(dtype=float)
        rapm_z = pd.Series(dtype=float)

    # xPPM needs segments; we can get them by recomputing with return_segments
    try:
        rapm_dict2, seg_df = compute_rapm_from_logs(df, match_events_df, split_off_def=True, return_segments=True)
        xppm_dict, _ = compute_xppm_from_segments(seg_df)
        xppm_val = xppm_dict.get("xppm", pd.Series(dtype=float))
        xppm_se = xppm_dict.get("se", pd.Series(dtype=float))
        xppm_ci_low = xppm_dict.get("ci_low", pd.Series(dtype=float))
        xppm_ci_high = xppm_dict.get("ci_high", pd.Series(dtype=float))
        xppm_z = xppm_dict.get("z", pd.Series(dtype=float))
    except Exception as e:
        print(f"[WARN] subset xPPM failed: {e}")
        xppm_val = pd.Series(dtype=float)
        xppm_se = pd.Series(dtype=float)
        xppm_ci_low = pd.Series(dtype=float)
        xppm_ci_high = pd.Series(dtype=float)
        xppm_z = pd.Series(dtype=float)

    out["RAPM_per90"] = out["Speler"].map(rapm_tot).fillna(0.0).round(3)
    out["RAPM_off_per90"] = out["Speler"].map(rapm_off).fillna(0.0).round(3)
    out["RAPM_def_per90"] = out["Speler"].map(rapm_def).fillna(0.0).round(3)
    out["RAPM_SE_per90"] = out["Speler"].map(rapm_se).fillna(0.0).round(3)
    out["RAPM_CI_low"] = out["Speler"].map(rapm_ci_low).fillna(0.0).round(3)
    out["RAPM_CI_high"] = out["Speler"].map(rapm_ci_high).fillna(0.0).round(3)
    out["RAPM_z"] = out["Speler"].map(rapm_z).fillna(0.0).round(2)

    out["xPPM_per90"] = out["Speler"].map(xppm_val).fillna(0.0).round(3)
    out["xPPM_SE"] = out["Speler"].map(xppm_se).fillna(0.0).round(3)
    out["xPPM_CI_low"] = out["Speler"].map(xppm_ci_low).fillna(0.0).round(3)
    out["xPPM_CI_high"] = out["Speler"].map(xppm_ci_high).fillna(0.0).round(3)
    out["xPPM_z"] = out["Speler"].map(xppm_z).fillna(0.0).round(2)

    out = _compute_scouting_scores(out)
    return out

if __name__ == "__main__":
    build_player_stats()