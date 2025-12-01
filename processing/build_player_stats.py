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
    d["date"] = d["date"].apply(parse_dutch_date)
    return d[["url", "date"]]


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


    # 6) wegschrijven
    out.to_csv(OUTPUT_PATH, index=False, encoding="utf8")
    print(f"Saved: {OUTPUT_PATH}")


if __name__ == "__main__":
    build_player_stats()
