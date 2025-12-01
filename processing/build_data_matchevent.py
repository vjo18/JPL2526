import pandas as pd
import numpy as np

INPUT_PATH = "data_raw/match_events.csv"
OUTPUT_PATH = "data_raw/data_matchevent.csv"

GOAL_EVENTS = {"Goal", "Penalty", "Own Goal"}


def build_data_matchevent():
    # 1) Inladen ruwe events
    df = pd.read_csv(INPUT_PATH)

    # 2) team against
    def team_against(row):
        val = row["is_home"]
        is_home = (val == 1) or (val is True)
        return row["away_team"] if is_home else row["home_team"]

    df["team against"] = df.apply(team_against, axis=1)

    # 3) Goal total event (1 bij Goal / Penalty / Own Goal)
    df["Goal total event"] = df["event"].isin(GOAL_EVENTS).astype(int)

    # 4) Goal new diff: goals van het scorende team - tegengoals
    def goal_new_diff(row):
        if row["Goal total event"] != 1:
            return np.nan

        val = row["is_home"]
        is_home = (val == 1) or (val is True)

        home_g = row["home_team_goals"]
        away_g = row["away_team_goals"]

        if is_home:
            return home_g - away_g
        else:
            return away_g - home_g

    df["Goal new diff"] = df.apply(goal_new_diff, axis=1)

    # 5) CSV wegschrijven (zoals vroeger)
    df.to_csv(OUTPUT_PATH, index=False, encoding="utf8")
    print(f"Saved: {OUTPUT_PATH}")


if __name__ == "__main__":
    build_data_matchevent()
