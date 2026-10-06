#!/usr/bin/env python3
"""
Fetch upcoming-event odds from ESPN's free public API (no key, no quota)
and write them to data/odds.json for the Live Agent Building site.

Endpoints used:
  Scoreboard : https://site.api.espn.com/apis/site/v2/sports/{group}/{league}/scoreboard
  Per-event  : https://sports.core.api.espn.com/v2/sports/{group}/leagues/{league}/events/{eid}/competitions/{cid}/odds?lang=en&region=us

Stdlib only. Be polite: small delay between requests.
"""

import datetime
import json
import os
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(ROOT, "data")
OUT_PATH = os.path.join(DATA_DIR, "odds.json")

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


def get_json(url, timeout=25):
    req = urllib.request.Request(url, headers=HEADERS)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8", "replace"))
    except Exception as exc:  # network hiccup -> caller decides
        print(f"  !! fetch failed: {exc}")
        return None


def parse_dt(s):
    try:
        return datetime.datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except Exception:
        return None


def team_info(c):
    t = c.get("team") or {}
    return {
        "abbr": t.get("abbreviation") or t.get("shortDisplayName") or "?",
        "name": t.get("displayName") or t.get("name") or "?",
    }


def event_status(ev, now):
    st = ((ev.get("status") or {}).get("type") or {})
    if st.get("completed"):
        return "final"
    name = str(st.get("name") or "").upper()
    if "IN_PROGRESS" in name or "HALF" in name or "END_PERIOD" in name:
        return "live"
    dt = parse_dt(ev.get("date"))
    if dt and dt < now:
        return "final"
    return "upcoming"


def american_str(v):
    """Normalize a moneyline value to an American-odds string like '-120' or '+100'."""
    if v is None:
        return None
    try:
        n = float(v)
    except (TypeError, Value):
        return None
    n = int(round(n))
    return f"+{n}" if n >= 0 else str(n)


def snapshot(side):
    """Pull moneyline / spread-odds snapshots (open, current, close) for one side."""
    if not side:
        return {}
    out = {}
    ml = american_str(side.get("moneyLine"))
    if ml:
        out["ml"] = ml
    so = american_str(side.get("spreadOdds"))
    if so:
        out["spread_odds"] = so
    for key in ("open", "current", "close"):
        blk = side.get(key) or {}
        snap = {}
        mlb = blk.get("moneyLine") or {}
        if isinstance(mlb, dict):
            a = american_str(mlb.get("american"))
            if a:
                snap["ml"] = a
        spb = blk.get("spread") or {}
        if isinstance(spb, dict):
            a = american_str(spb.get("american"))
            if a:
                snap["spread_odds"] = a
        ps = blk.get("pointSpread") or {}
        if isinstance(ps, dict) and ps.get("american") not in (None, ""):
            snap["point_spread"] = str(ps.get("american"))
        if snap:
            out[key] = snap
    return out


def parse_books(data):
    books = []
    for item in (data or {}).get("items", []):
        prov = item.get("provider") or {}
        rec = {
            "provider": prov.get("name") or prov.get("id") or "unknown",
            "details": item.get("details"),
        }
        home = snapshot(item.get("homeTeamOdds"))
        away = snapshot(item.get("awayTeamOdds"))
        if home:
            rec["home"] = home
        if away:
            rec["away"] = away
        try:
            rec["spread"] = float(item["spread"]) if item.get("spread") is not None else None
        except (TypeError, Value):
            rec["spread"] = None
        try:
            rec["total"] = float(item["overUnder"]) if item.get("overUnder") is not None else None
        except (TypeError, Value):
            rec["total"] = None
        rec["over_odds"] = american_str(item.get("overOdds"))
        rec["under_odds"] = american_str(item.get("underOdds"))
        books.append(rec)
    # de-dupe by provider, keep first
    seen, uniq = set(), []
    for b in books:
        if b["provider"] not in seen:
            seen.add(b["provider"])
            uniq.append(b)
    return uniq


def main():
    now = datetime.datetime.now(datetime.timezone.utc)
    os.makedirs(DATA_DIR, exist_ok=True)
    out = {
        "fetched_at": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": "ESPN public API (site.api.espn.com + sports.core.api.espn.com) - free, no key",
        "leagues": {},
    }
    total_events, total_books = 0, 0
    for group, league, label in LEAGUES:
        print(f"== {label} ({group}/{league})")
        sb = get_json(
            f"https://site.api.espn.com/apis/site/v2/sports/{group}/{league}/scoreboard"
        )
        events = []
        for ev in (sb or {}).get("events", []):
            comp = (ev.get("competitions") or [{}])[0]
            cmps = comp.get("competitors", [])
            home = next((c for c in cmps if c.get("homeAway") == "home"), {})
            away = next((c for c in cmps if c.get("homeAway") == "away"), {})
            rec = {
                "id": str(ev.get("id")),
                "league": league,
                "league_label": label,
                "name": ev.get("name"),
                "short_name": ev.get("shortName"),
                "date": ev.get("date"),
                "status": event_status(ev, now),
                "three_way": group == "soccer",  # home/draw/away: needs a draw-aware model
                "home": team_info(home),
                "away": team_info(away),
                "books": [],
            }
            eid, cid = ev.get("id"), comp.get("id")
            if eid and cid:
                time.sleep(0.2)  # be polite
                odds = get_json(
                    f"https://sports.core.api.espn.com/v2/sports/{group}/leagues/{league}"
                    f"/events/{eid}/competitions/{cid}/odds?lang=en&region=us"
                )
                rec["books"] = parse_books(odds)
                total_books += len(rec["books"])
            events.append(rec)
        # soonest first
        events.sort(key=lambda e: (parse_dt(e.get("date")) or now))
        out["leagues"][league] = {
            "group": group,
            "label": label,
            "events": events,
        }
        total_events += len(events)
        up = sum(1 for e in events if e["status"] in ("upcoming", "live"))
        print(f"  events: {len(events)} (upcoming/live: {up})")

    tmp = OUT_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2, ensure_ascii=False)
        f.write("\n")
    os.replace(tmp, OUT_PATH)
    print(f"Wrote {OUT_PATH}: {total_events} events, {total_books} book entries")


if __name__ == "__main__":
    main()
