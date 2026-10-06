#!/usr/bin/env python3
"""
Paper-trading engine for the Live Agent Building.

*** FAKE MONEY ONLY ***
This script never places real wagers, never touches a sportsbook account,
and never moves real money. It mirrors the site's decision logic
(app.js -> computeProspects) EXACTLY, feeds it real live ESPN odds from
data/odds.json, and records what WOULD have happened with a fake $1,000
bankroll. Goal: prove whether the edge-finding plan works, risk-free.

Mirrored rules (keep in sync with app.js):
  1. Only events with status "upcoming" or "live" are evaluated.
  2. A book counts only if it quotes BOTH home.ml and away.ml.
  3. 3-way (soccer) markets never earn a PASS: the 2-way edge model cannot
     price draws, so they are held at WATCH (same as the site).
  4. Devigged fair probability: fairH = avgH / (avgH + avgA), where avgH/avgA
     are the mean implied probabilities across quoting books.
  5. Edge on a side = fair_prob - 1/best_decimal_odds; the side with the
     bigger edge is the pick, at the best available price.
  6. Stake = half-Kelly fraction of the CURRENT fake bankroll, capped at 2%.
     Full Kelly f = (fair*(price-1) - (1-fair)) / (price-1);
     kelly = max(0, min(0.02, f/2)).
  7. Checks: (a) 2+ books quoting, (b) snapshot fresh (< 6h old),
     (c) book disagreement on the home price >= 1.5%,
     (d) movement baseline exists from a previous run.
  8. PASS requires edge >= 3% AND at least 3 of the 4 checks passing.
     (FAIL if stale or no books; WATCH if < 2 books; REJECT if edge < 0.)

Positions opened here are moneyline-only, because the mirrored edge model
only prices 2-way moneylines. The position schema (and results.py) also
support spread/total for future extension.

Simplifications vs a real bettor, stated honestly:
  - One paper position max per event (no double exposure on the same game,
    and no re-betting a game after it settles).
  - The stake is "filled" in full at the best quoted price; real books have
    limits and lines move between quote and placement.
  - Grading happens on the next 30-min run after a game goes final.

Stdlib only.
"""

import datetime
import json
import os

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(ROOT, "data")
ODDS_PATH = os.path.join(DATA_DIR, "odds.json")
PAPER_PATH = os.path.join(DATA_DIR, "paper.json")

BANKROLL_START = 1000.0
EQUITY_CAP = 5000  # keep the equity curve file bounded

# Thresholds mirrored from app.js — change them there too.
FRESH_HOURS = 6
MIN_BOOKS = 2
MIN_DISAGREEMENT = 0.015
MIN_EDGE = 0.03
KELLY_CAP = 0.02


def utcnow():
    return datetime.datetime.now(datetime.timezone.utc)


def iso_z(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_dt(s):
    try:
        return datetime.datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except Exception:
        return None


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


def am_prob(s):
    """American odds -> implied probability. Mirrors app.js amProb."""
    if s is None or s == "":
        return None
    try:
        n = float(str(s).replace("+", ""))
    except (TypeError, ValueError):
        return None
    if n == 0 or n != n or n in (float("inf"), float("-inf")):
        return None
    return -n / (-n + 100) if n < 0 else 100 / (n + 100)


def evaluate(ev, fresh, prev_cons):
    """
    Mirror of app.js computeProspects() for one event.
    Returns a dict with verdict + the numbers behind it.
    """
    books = [
        b for b in (ev.get("books") or [])
        if (b.get("home") or {}).get("ml") and (b.get("away") or {}).get("ml")
    ]
    n_books = len(books)
    if n_books == 0:
        return {"verdict": "FAIL", "n_books": 0, "has_books": False}

    # Defensive: drop books whose lines don't parse (app.js would coerce;
    # real ESPN data always parses, so behavior is identical in practice).
    rows = []
    for b in books:
        hp = am_prob(b["home"]["ml"])
        ap = am_prob(b["away"]["ml"])
        if hp and hp > 0 and ap and ap > 0:
            rows.append((b, hp, ap))
    if not rows:
        return {"verdict": "FAIL", "n_books": n_books, "has_books": False}

    n = len(rows)
    avg_h = sum(r[1] for r in rows) / n
    avg_a = sum(r[2] for r in rows) / n
    base = {"n_books": n_books, "has_books": True, "avg_h": avg_h, "avg_a": avg_a}

    if ev.get("three_way"):
        # Mirrors app.js: no edge computed for 3-way markets.
        return dict(base, verdict="WATCH")

    dec_h = [(1.0 / r[1], r[0]) for r in rows]
    dec_a = [(1.0 / r[2], r[0]) for r in rows]
    best_h, book_h = max(dec_h, key=lambda x: x[0])
    best_a, book_a = max(dec_a, key=lambda x: x[0])

    fair_h = avg_h / (avg_h + avg_a)
    fair_a = 1.0 - fair_h
    edge_h = fair_h - 1.0 / best_h
    edge_a = fair_a - 1.0 / best_a

    if edge_h >= edge_a:
        side, edge, fair, price, book = "home", edge_h, fair_h, best_h, book_h
    else:
        side, edge, fair, price, book = "away", edge_a, fair_a, best_a, book_a
    best_am = (book.get(side) or {}).get("ml")

    # Full Kelly -> half-Kelly, floored at 0, capped at 2%. Mirrors app.js.
    f = (fair * (price - 1.0) - (1.0 - fair)) / (price - 1.0) if price != 1.0 else 0.0
    kelly = max(0.0, min(KELLY_CAP, f / 2.0))

    # Book disagreement on the HOME price only. Mirrors app.js.
    hps = [r[1] for r in rows]
    dis = max(hps) - min(hps)

    checks = {
        "books": n_books >= MIN_BOOKS,
        "fresh": fresh,
        "disagreement": dis >= MIN_DISAGREEMENT,
        "baseline": str(ev.get("id")) in prev_cons,
    }
    passed = sum(1 for v in checks.values() if v)

    if not fresh or n_books == 0:
        verdict = "FAIL"
    elif n_books < MIN_BOOKS:
        verdict = "WATCH"
    elif edge >= MIN_EDGE and passed >= 3:
        verdict = "PASS"
    elif edge < 0:
        verdict = "REJECT"
    else:
        verdict = "WATCH"

    return dict(
        base,
        verdict=verdict,
        side=side,
        edge=edge,
        fair=fair,
        price=price,
        kelly=kelly,
        best_am=best_am,
        book=book.get("provider") or "unknown",
        disagreement=dis,
        checks=checks,
        passed=passed,
    )


def fresh_paper():
    return {
        "bankroll_start": BANKROLL_START,
        "fake": True,
        "bankroll": BANKROLL_START,
        "open": [],
        "settled": [],
        "equity": [],
        "consensus": {},
        "updated_at": None,
    }


def main():
    now = utcnow()
    odds = load_json(ODDS_PATH)
    if not odds:
        print("no data/odds.json yet — nothing to evaluate")
        return

    fetched_at = odds.get("fetched_at")
    dt = parse_dt(fetched_at)
    age_h = (now - dt).total_seconds() / 3600 if dt else float("inf")
    fresh = age_h < FRESH_HOURS
    if not fresh:
        print(f"snapshot is stale ({age_h:.1f}h old) — no positions opened, verdicts would FAIL")

    paper = load_json(PAPER_PATH) or fresh_paper()
    bankroll = round(float(paper.get("bankroll", BANKROLL_START)), 2)
    open_pos = paper.get("open", [])
    settled = paper.get("settled", [])
    prev_cons = paper.get("consensus", {}) or {}
    open_ids = {str(p.get("event_id")) for p in open_pos}
    settled_ids = {str(p.get("event_id")) for p in settled}

    new_cons = {}
    opened = 0
    for _league_key, lg in (odds.get("leagues") or {}).items():
        for ev in lg.get("events", []):
            if ev.get("status") not in ("upcoming", "live"):
                continue
            res = evaluate(ev, fresh, prev_cons)
            # Mirror app.js: consensus baseline saved for every evaluated
            # event that has books (even 3-way / non-PASS ones).
            if res.get("has_books"):
                new_cons[str(ev.get("id"))] = {"h": res["avg_h"], "a": res["avg_a"]}
            if res["verdict"] != "PASS":
                continue
            eid = str(ev.get("id"))
            if eid in open_ids or eid in settled_ids:
                continue  # already working this game — no double exposure
            stake = round(res["kelly"] * bankroll, 2)
            if stake < 0.01 or stake > bankroll:
                continue
            bankroll = round(bankroll - stake, 2)
            side = res["side"]
            pos = {
                "id": f"{eid}:{side}:{now.strftime('%Y%m%dT%H%M%SZ')}",
                "placed_at": fetched_at,
                "event_id": eid,
                "league": ev.get("league"),
                "league_label": ev.get("league_label"),
                "matchup": ev.get("short_name") or ev.get("name"),
                "market": "moneyline",
                "side": side,
                "side_abbr": (ev.get(side) or {}).get("abbr"),
                "line": None,
                "odds_american": res["best_am"],
                "odds_decimal": round(res["price"], 4),
                "stake": stake,
                "book": res["book"],
                "fair_prob": round(res["fair"], 4),
                "edge": round(res["edge"], 4),
            }
            open_pos.append(pos)
            open_ids.add(eid)
            opened += 1
            print(
                f"  OPEN {pos['matchup']} {pos['side_abbr']} {res['best_am']} "
                f"stake ${stake:.2f} edge {res['edge'] * 100:.1f}% ({res['book']})"
            )

    equity = paper.get("equity", [])
    equity.append({"t": iso_z(now), "bankroll": round(bankroll, 2)})
    paper.update(
        {
            "bankroll_start": BANKROLL_START,
            "fake": True,
            "bankroll": round(bankroll, 2),
            "open": open_pos,
            "settled": settled,
            "equity": equity[-EQUITY_CAP:],
            "consensus": new_cons,
            "updated_at": iso_z(now),
        }
    )
    write_json(PAPER_PATH, paper)
    print(
        f"paper: fake bankroll ${bankroll:.2f} | open {len(open_pos)} "
        f"| settled {len(settled)} | opened {opened} new"
    )


if __name__ == "__main__":
    main()
