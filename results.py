#!/usr/bin/env python3
"""
Grade open paper-trading positions against FINAL scores from ESPN.

*** FAKE MONEY ONLY ***
Reads data/paper.json, fetches scoreboards for the same leagues as
fetch_odds.py, and settles positions whose games are final. Never places
real wagers or touches real money.

Grading simplifications, stated honestly:
  - Moneyline: graded on the final winner as ESPN reports it. (Moneyline
    bets include overtime at every major book, so final score is correct.)
  - Spread/total: graded against the line/total recorded at placement,
    using the final score. An exact tie is a PUSH: the stake is refunded.
  - Lines are taken from the best-price book at placement; real lines move
    between quote and placement — we grade the recorded line, which flatters
    results slightly. Treat the P&L as an upper bound, not a promise.
  - Grading runs once per workflow cycle (every 30 min), after fetch_odds.py
    and before paper.py: old positions are settled before new ones open.
  - Only moneyline positions are opened by paper.py (the edge model only
    prices 2-way moneylines); spread/total grading is implemented in the
    schema and grader for completeness.
  - A game missing from the scoreboard, or final without a reported score,
    stays open and is retried next run.

Stdlib only.
"""

import datetime
import json
import os
import time
import urllib.request

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(ROOT, "data")
PAPER_PATH = os.path.join(DATA_DIR, "paper.json")

# Same leagues as fetch_odds.py — keep in sync.
LEAGUES = [
    ("football", "nfl", "NFL"),
    ("basketball", "nba", "NBA"),
    ("baseball", "mlb", "MLB"),
    ("hockey", "nhl", "NHL"),
    ("soccer", "eng.1", "EPL"),
]

HEADERS = {
    "User-Agent": "live-agent-building/1.0 (github pages research project)",
    "Accept": "application/json",
}


def utcnow():
    return datetime.datetime.now(datetime.timezone.utc)


def iso_z(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def load_json(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def write_json(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, indent=2, ensure_ascii=False)
        f.write("\n")
    os.replace(tmp, path)


def get_json(url, timeout=25):
    req = urllib.request.Request(url, headers=HEADERS)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8", "replace"))
    except Exception as exc:
        print(f"  !! fetch failed: {exc}")
        return None


def final_scores():
    """Map event_id -> final score info. Leagues that fail to load are
    skipped this run; their positions simply stay open."""
    out = {}
    for group, league, label in LEAGUES:
        sb = get_json(
            f"https://site.api.espn.com/apis/site/v2/sports/{group}/{league}/scoreboard"
        )
        if not sb:
            print(f"  !! {label} scoreboard unavailable — skipping league this run")
            continue
        for ev in sb.get("events", []):
            comp = (ev.get("competitions") or [{}])[0]
            cmps = comp.get("competitors", [])
            home = next((c for c in cmps if c.get("homeAway") == "home"), {})
            away = next((c for c in cmps if c.get("homeAway") == "away"), {})
            st = ((ev.get("status") or {}).get("type") or {})
            try:
                hs = int(home.get("score"))
            except (TypeError, ValueError):
                hs = None
            try:
                aws = int(away.get("score"))
            except (TypeError, ValueError):
                aws = None
            out[str(ev.get("id"))] = {
                "status": "final" if st.get("completed") else "other",
                "home_abbr": (home.get("team") or {}).get("abbreviation"),
                "away_abbr": (away.get("team") or {}).get("abbreviation"),
                "home_score": hs,
                "away_score": aws,
            }
        time.sleep(0.2)  # be polite
    return out


def grade(pos, ev):
    """
    Return the profit (fake dollars) for a position, or None if it cannot
    be graded yet. Positive = win, negative = loss, 0.0 = push.
    """
    market = pos.get("market", "moneyline")
    side = pos.get("side")
    stake = float(pos.get("stake", 0) or 0)
    hs, aws = ev.get("home_score"), ev.get("away_score")
    if hs is None or aws is None or stake <= 0:
        return None
    dec = float(pos.get("odds_decimal") or 0)
    if dec <= 1:
        return None

    if market == "moneyline":
        mine, theirs = (hs, aws) if side == "home" else (aws, hs)
        if mine > theirs:
            return stake * (dec - 1.0)
        if mine < theirs:
            return -stake
        return 0.0  # tie: impossible in these leagues, refund to be safe

    if market == "spread":
        # line is recorded from the chosen side's perspective
        # (e.g. -2.5 if the side is favored by 2.5).
        line = float(pos.get("line"))
        mine, theirs = (hs, aws) if side == "home" else (aws, hs)
        margin = round(mine - theirs + line, 6)
        if margin > 0:
            return stake * (dec - 1.0)
        if margin < 0:
            return -stake
        return 0.0  # push: exact tie on the number

    if market == "total":
        line = float(pos.get("line"))
        total = hs + aws
        if total == line:
            return 0.0  # push
        won = (total > line) if side == "over" else (total < line)
        return stake * (dec - 1.0) if won else -stake

    return None


def main():
    now = utcnow()
    paper = load_json(PAPER_PATH)
    if not paper or not paper.get("open"):
        print("no open paper positions — nothing to grade")
        return

    scores = final_scores()
    bankroll = round(float(paper.get("bankroll", 1000.0)), 2)
    still_open = []
    settled = paper.get("settled", [])
    n_settled = 0

    for pos in paper["open"]:
        ev = scores.get(str(pos.get("event_id")))
        if not ev or ev.get("status") != "final":
            still_open.append(pos)
            continue
        profit = grade(pos, ev)
        if profit is None:
            still_open.append(pos)  # final but unscorable — retry next run
            continue
        profit = round(profit, 2)
        stake = round(float(pos.get("stake", 0) or 0), 2)
        if profit > 0:
            # Win: stake was deducted at placement; return stake + winnings.
            bankroll = round(bankroll + stake + profit, 2)
        elif profit == 0:
            # Push: stake refunded.
            bankroll = round(bankroll + stake, 2)
        # Loss: stake was already deducted when the position opened.
        rec = dict(pos)
        rec.update(
            {
                "graded_at": iso_z(now),
                "final_score": (
                    f"{ev.get('away_abbr')} {ev.get('away_score')} @ "
                    f"{ev.get('home_abbr')} {ev.get('home_score')}"
                ),
                "profit": profit,
            }
        )
        settled.append(rec)
        n_settled += 1
        print(f"  SETTLED {pos.get('matchup')} {pos.get('side')} profit ${profit:+.2f}")

    paper.update(
        {
            "bankroll": round(bankroll, 2),
            "open": still_open,
            "settled": settled,
            "updated_at": iso_z(now),
        }
    )
    write_json(PAPER_PATH, paper)
    print(
        f"results: settled {n_settled} | open {len(still_open)} | "
        f"fake bankroll ${bankroll:.2f}"
    )


if __name__ == "__main__":
    main()
