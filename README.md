# Live Agent Building

A mobile-first, visually interactive "agent building" where each floor is a research
department working the live sports-odds feed. Tap any floor, agent, or prospect to see
what's happening and why.

## The building

| Floor | Department | Agents | Job |
|------:|-----------|--------|-----|
| 4 | Decision | **D-1 Gatekeeper** | Confirms each prospect with its own analysis, then **passes**, **rejects**, or **fails** it — every decision ships with recorded reasons. |
| 3 | Researchers | **R-1 Evidence**, **R-2 Devil's Advocate** | Evidence checklists (sources, freshness, corroboration, gaps); counterargument hunting. |
| 2 | Trackers | **T-1 Pulse**, **T-2 Driftwatch** | Line movement open → current, plus drift between 30-minute refreshes. |
| 1 | Scouts | **S-1 Pathfinder**, **S-2 Bloodhound** | Sweeps the feed for prospects; ranks them by disagreement between books. |

Tap an agent to open its detail sheet: current task, what it **receives from** the
previous floor, what it **sends to** the next floor, and the facts behind each
pass / reject / fail. Animated packets show information flowing upward through the
building. The **Prospects** section lists every upcoming game with best prices,
edge bars, and verdict badges — tap any lead for the full book table, model math,
evidence checklist, and decision reasoning.

## Decision gates

- **PASS** — edge ≥ 3% with 3+ evidence checks green and no disqualifying counterargument.
- **WATCH** — kept in research: single-book markets waiting for corroboration, or 3-way (soccer) markets the 2-way model doesn't price yet.
- **REJECT** — negative expected value against a corroborated fair price.
- **FAIL** — stale or missing data; the app refuses to decide instead of guessing.

## Data — free and live, no keys

Odds come from ESPN's free public API (no key, no quota):

- Scoreboard: `https://site.api.espn.com/apis/site/v2/sports/{group}/{league}/scoreboard`
- Per-event odds: `https://sports.core.api.espn.com/v2/sports/{group}/leagues/{league}/events/{eid}/competitions/{cid}/odds`

`fetch_odds.py` (Python stdlib only) pulls the current slate for NFL, NBA, MLB, NHL,
and EPL, including per-book moneylines, spreads, totals, and **opening vs current**
lines, and writes `data/odds.json` with a UTC `fetched_at` timestamp.

## How it stays live

1. **GitHub Actions** (`.github/workflows/refresh.yml`) runs `fetch_odds.py` every
   30 minutes and commits `data/odds.json` back to the repo when it changes.
   It can also be triggered manually via *Run workflow*.
2. **GitHub Pages** serves the static site (`index.html` at the repo root).
   Enable it under *Settings → Pages → Deploy from a branch → `main` / `(root)`.*
3. The site reads `data/odds.json` on load. If the file is missing it shows a
   clear *"waiting for first data refresh"* state — it never fakes live data.
4. Line-movement baselines are kept in the browser's `localStorage`, so Trackers
   can compare each refresh against the last snapshot you saw.

## Setup

```bash
git init
git add .
git commit -m "Live Agent Building"
gh repo create <your-repo> --public --source=. --push
# then enable GitHub Pages as described above
```

No build step, no secrets, no API keys anywhere.

## A note on gambling

Educational simulation — not financial advice. Gambling involves risk. This app
only reads public odds data, computes transparent math you can inspect, and
**never places real wagers**.
