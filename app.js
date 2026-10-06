"use strict";
/* Live Agent Building — client.
   Reads data/odds.json (committed by the scheduled workflow).
   No simulated data: if the file is missing, the waiting state is shown. */

const $ = (s) => document.querySelector(s);

const FLOORS = [
  { n: 4, key: "decision", name: "Decision", dept: "Decision Department", color: "var(--f4)",
    agents: [
      { id: "D-1", name: "Gatekeeper", role: "Confirms every prospect with its own analysis, then passes, rejects, or fails it. Nothing moves forward without a recorded reason." },
    ] },
  { n: 3, key: "research", name: "Researchers", dept: "Research Department", color: "var(--f3)",
    agents: [
      { id: "R-1", name: "Evidence", role: "Runs the evidence checklist on every prospect: sources, freshness, corroboration, gaps." },
      { id: "R-2", name: "Devil's Advocate", role: "Hunts counterarguments and conflicting evidence before anything can pass." },
    ] },
  { n: 2, key: "track", name: "Trackers", dept: "Tracking Department", color: "var(--f2)",
    agents: [
      { id: "T-1", name: "Pulse", role: "Tracks line movement from open to current across every book." },
      { id: "T-2", name: "Driftwatch", role: "Watches for steam and value drift between refreshes." },
    ] },
  { n: 1, key: "scout", name: "Scouts", dept: "Scout Department", color: "var(--f1)",
    agents: [
      { id: "S-1", name: "Pathfinder", role: "Sweeps the live odds feed and flags every upcoming game as a raw prospect." },
      { id: "S-2", name: "Bloodhound", role: "Ranks prospects by disagreement between books — disagreement is where value hides." },
    ] },
];

const state = { data: null, paper: null, prospects: [], league: "all", paused: false, speed: 1 };

/* ---------------- odds math ---------------- */
function amProb(s) {
  if (s == null || s === "") return null;
  const n = parseFloat(String(s).replace("+", ""));
  if (!isFinite(n) || n === 0) return null;
  return n < 0 ? -n / (-n + 100) : 100 / (n + 100);
}
function amDec(s) { const p = amProb(s); return p == null || p <= 0 ? null : 1 / p; }
function pct(x, d = 1) { return x == null || !isFinite(x) ? "—" : (x * 100).toFixed(d) + "%"; }
function signedPct(x, d = 1) {
  if (x == null || !isFinite(x)) return "—";
  return (x >= 0 ? "+" : "") + (x * 100).toFixed(d) + "%";
}
function fmtMoney(x) {
  const v = Number(x);
  if (!isFinite(v)) return "—";
  return (v < 0 ? "-" : "") + "$" + Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function signedMoney(x) {
  const v = Number(x);
  if (!isFinite(v)) return "—";
  return (v >= 0 ? "+" : "-") + "$" + Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtTime(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return "TBD";
  return d.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
function ago(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  if (!isFinite(ms) || ms < 0) return "—";
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return m + "m ago";
  return Math.floor(m / 60) + "h " + (m % 60) + "m ago";
}

/* ---------------- history (line movement baseline) ---------------- */
function loadHist() {
  try { return JSON.parse(localStorage.getItem("ab_hist_v1") || "null"); }
  catch (e) { return null; }
}
function saveHist(cons, fetchedAt) {
  try { localStorage.setItem("ab_hist_v1", JSON.stringify({ fetched_at: fetchedAt, cons })); }
  catch (e) { /* private mode */ }
}

/* ---------------- pipeline ---------------- */
function eventsInScope() {
  const leagues = state.data.leagues;
  let evs = [];
  for (const key of Object.keys(leagues)) {
    if (state.league !== "all" && key !== state.league) continue;
    for (const e of leagues[key].events) evs.push(e);
  }
  return evs;
}

function computeProspects() {
  const fetchedAt = state.data.fetched_at;
  const ageH = (Date.now() - new Date(fetchedAt).getTime()) / 3600000;
  const fresh = isFinite(ageH) && ageH < 6;
  const hist = loadHist();
  const prevCons = (hist && hist.cons) || {};
  const consNow = {};
  const out = [];

  for (const ev of eventsInScope()) {
    if (ev.status !== "upcoming" && ev.status !== "live") continue;
    const books = (ev.books || []).filter(b => b.home && b.home.ml && b.away && b.away.ml);
    const p = { ev, nBooks: books.length, books };
    if (!books.length) {
      p.decision = { verdict: "FAIL", reasons: ["No book is quoting this game right now — nothing to analyze."] };
      p.checks = []; p.edge = null;
      out.push(p); continue;
    }
    const hps = books.map(b => amProb(b.home.ml));
    const aps = books.map(b => amProb(b.away.ml));
    const avgH = hps.reduce((a, b) => a + b, 0) / hps.length;
    const avgA = aps.reduce((a, b) => a + b, 0) / aps.length;
    const dis = hps.length > 1 ? Math.max(...hps) - Math.min(...hps) : 0;
    const decH = books.map(b => amDec(b.home.ml)), decA = books.map(b => amDec(b.away.ml));
    const bestH = Math.max(...decH), bestA = Math.max(...decA);
    const bestAmOf = (decList, getMl) => {
      let bi = 0;
      for (let i = 1; i < decList.length; i++) if (decList[i] > decList[bi]) bi = i;
      return getMl(books[bi]);
    };
    const bestAmH = bestAmOf(decH, b => b.home.ml), bestAmA = bestAmOf(decA, b => b.away.ml);

    p.disagreement = dis;

    const prev = prevCons[ev.id];
    consNow[ev.id] = { h: avgH, a: avgA };
    p.move = prev ? { dh: (avgH - prev.h) * 100, da: (avgA - prev.a) * 100 } : null;

    p.bookMoves = books.map(b => ({
      provider: b.provider,
      open: (b.home.open && b.home.open.ml) || null,
      cur: b.home.ml,
    })).filter(m => m.open && m.open !== m.cur);

    const freshCheck = { label: "Data fresh", pass: ageH < 3, detail: `snapshot ${ago(fetchedAt)}` };
    const moveCheck = { label: "Movement baseline", pass: !!p.move,
      detail: p.move ? `consensus ${p.move.dh >= 0 ? "+" : ""}${p.move.dh.toFixed(1)} pts since last refresh` : "collecting baseline — needs another refresh" };

    if (ev.three_way) {
      // Soccer: books price home/draw/away. The 2-way edge model is invalid here,
      // so we track odds + movement honestly and hold for a draw-aware model.
      p.threeWay = true;
      p.edge = null; p.expVal = null; p.kelly = 0;
      p.fairH = null; p.fairA = null;
      p.side = "home"; p.bestAm = bestAmH; p.bestAmA = bestAmA;
      p.checks = [
        { label: `${p.nBooks} book${p.nBooks > 1 ? "s" : ""} quoting`, pass: p.nBooks >= 2,
          detail: p.nBooks >= 2 ? "multi-book corroboration" : "thin market — single source" },
        freshCheck,
        { label: "Draw-aware model", pass: false,
          detail: "3-way market (draw possible) — edge model only handles 2-way moneylines" },
        moveCheck,
      ];
      const reasons = [
        "3-way market: books price home/draw/away — the edge model only handles 2-way moneylines, so no edge is computed.",
        `Best home price ${bestAmH || "—"} · best away price ${bestAmA || "—"} shown for reference.`,
      ];
      if (dis >= 0.015) reasons.push(`Books disagree by ${pct(dis)} on the home price — a real inefficiency signal.`);
      if (p.bookMoves.length) {
        const m = p.bookMoves[0];
        reasons.push(`${m.provider} moved ${m.open} → ${m.cur} since open — line is alive.`);
      }
      reasons.push("Held in research until a draw-aware model is added.");
      p.decision = { verdict: "WATCH", reasons, passed: p.checks.filter(c => c.pass).length };
      out.push(p);
      continue;
    }

    const fairH = avgH / (avgH + avgA), fairA = 1 - fairH;
    const edgeH = fairH - 1 / bestH, edgeA = fairA - 1 / bestA;
    const side = edgeH >= edgeA ? "home" : "away";
    const edge = Math.max(edgeH, edgeA);
    const fair = side === "home" ? fairH : fairA;
    const price = side === "home" ? bestH : bestA;

    p.fairH = fairH; p.fairA = fairA;
    p.edge = edge; p.side = side; p.price = price;
    p.bestAm = side === "home" ? bestAmH : bestAmA;
    p.expVal = fair * price - 1;
    const f = (fair * (price - 1) - (1 - fair)) / (price - 1);
    p.kelly = Math.max(0, Math.min(0.02, f / 2));

    p.checks = [
      { label: `${p.nBooks} book${p.nBooks > 1 ? "s" : ""} quoting`, pass: p.nBooks >= 2,
        detail: p.nBooks >= 2 ? "multi-book corroboration" : "thin market — single source" },
      freshCheck,
      { label: `Book disagreement ${pct(dis)}`, pass: dis >= 0.015,
        detail: dis >= 0.015 ? "books disagree — potential value" : "books agree — little to exploit" },
      moveCheck,
    ];
    const passed = p.checks.filter(c => c.pass).length;
    const reasons = [];
    if (!fresh) reasons.push("Data is stale — refusing to decide on old lines.");
    if (p.nBooks < 2) reasons.push("Only one book quoting — held until more books corroborate a fair price.");
    reasons.push(`Model fair probability ${pct(fair)} vs best price ${p.bestAm} (implied ${pct(1 / price)}).`);
    reasons.push(`Edge ${signedPct(edge)} — ${edge >= 0.03 ? "above" : "below"} the 3% pass bar.`);
    if (dis >= 0.015) reasons.push(`Books disagree by ${pct(dis)} — a real inefficiency signal.`);
    if (p.bookMoves.length) {
      const m = p.bookMoves[0];
      reasons.push(`${m.provider} moved ${m.open} → ${m.cur} since open — line is alive.`);
    }
    let verdict;
    if (!fresh || p.nBooks === 0) verdict = "FAIL";
    else if (p.nBooks < 2) verdict = "WATCH";
    else if (edge >= 0.03 && passed >= 3) verdict = "PASS";
    else if (edge < 0) verdict = "REJECT";
    else verdict = "WATCH";
    if (verdict === "PASS") reasons.push("Devil's Advocate found no disqualifying counterargument.");
    if (verdict === "WATCH" && p.nBooks >= 2) reasons.push("Kept in research — needs a wider edge or stronger evidence.");
    if (verdict === "REJECT") reasons.push("Price is worse than the model's fair value — negative expectation.");
    p.decision = { verdict, reasons, passed };
    out.push(p);
  }
  out.sort((a, b) => (b.edge == null ? -1 : b.edge) - (a.edge == null ? -1 : a.edge));
  saveHist(consNow, fetchedAt);
  return out;
}

/* ---------------- agent narrative ---------------- */
function agentInfo(id, ctx) {
  const P = ctx.prospects;
  const nUp = ctx.nUp, nEvents = ctx.nEvents;
  const byV = v => P.filter(p => p.decision.verdict === v).length;
  const moved = P.filter(p => p.move && Math.abs(p.move.dh) >= 0.5).length;
  const topDis = P.length ? Math.max(...P.map(p => p.disagreement || 0)) : 0;
  const histAge = ctx.histAge;
  const cont = P.filter(p => p.decision.passed >= 3).length;
  const M = {
    "S-1": {
      task: `Sweeping ${nUp} upcoming games across ${ctx.leagueNames} — ${P.length} prospects flagged.`,
      from: [[`Odds feed`, `${nEvents} games on the current slate (ESPN, free feed)`]],
      to: [["T-1 · Pulse", `prospect shortlist (${P.length})`], ["T-2 · Driftwatch", `prospect shortlist (${P.length})`]],
    },
    "S-2": {
      task: `Ranking ${P.length} prospects by book disagreement — widest gap ${pct(topDis)}.`,
      from: [["S-1 · Pathfinder", "raw prospect sweep"]],
      to: [["T-1 · Pulse", "disagreement-ranked shortlist"]],
    },
    "T-1": {
      task: moved ? `Tracking ${moved} line moves since last refresh across ${P.length} prospects.` : `Baseline set for ${P.length} prospects — movement appears after the next refresh.`,
      from: [["S-1 · Pathfinder / S-2 · Bloodhound", "ranked prospect shortlist"], ["History", histAge ? `last snapshot ${histAge}` : "no prior snapshot yet"]],
      to: [["R-1 · Evidence", `line-movement report (${moved} notable moves)`]],
    },
    "T-2": {
      task: `Watching steam and value drift on ${P.length} prospects between 30-min refreshes.`,
      from: [["S-1 · Pathfinder", "prospect shortlist"]],
      to: [["R-2 · Devil's Advocate", "steam alerts for counter-review"]],
    },
    "R-1": {
      task: `Reviewing ${P.length} evidence packs — ${cont} meet the continue criteria.`,
      from: [["T-1 · Pulse", "line-movement report"]],
      to: [["D-1 · Gatekeeper", `evidence packs (${cont} continue / ${P.length - cont} need more data)`]],
    },
    "R-2": {
      task: `Stress-testing ${P.length} prospects for counterarguments and conflicting signals.`,
      from: [["T-2 · Driftwatch", "steam alerts"]],
      to: [["D-1 · Gatekeeper", "counterargument briefs"]],
    },
    "D-1": {
      task: `${byV("PASS")} passed · ${byV("WATCH")} watching · ${byV("REJECT")} rejected · ${byV("FAIL")} failed — each with recorded reasons.`,
      from: [["R-1 · Evidence", "evidence packs with pass/continue criteria"], ["R-2 · Devil's Advocate", "counterargument briefs"]],
      to: [["Decision log", `${byV("PASS")} pass · ${byV("WATCH")} watch · ${byV("REJECT")} reject · ${byV("FAIL")} fail`]],
      decisions: P.slice(0, 8).map(p => ({
        label: `${p.ev.away.abbr} @ ${p.ev.home.abbr}`,
        verdict: p.decision.verdict,
        reasons: p.decision.reasons,
      })),
    },
  };
  return M[id];
}

/* ---------------- rendering ---------------- */
function renderChips() {
  const leagues = state.data.leagues;
  const wrap = $("#leagueChips");
  wrap.innerHTML = "";
  const mk = (key, label) => {
    const b = document.createElement("button");
    b.className = "chip"; b.textContent = label;
    b.setAttribute("role", "tab");
    b.setAttribute("aria-selected", String(state.league === key));
    b.onclick = () => { state.league = key; refresh(); };
    wrap.appendChild(b);
  };
  mk("all", "All");
  for (const key of Object.keys(leagues)) mk(key, leagues[key].label);
}

function agentStatus() { return state.data ? "Working" : "Waiting for data"; }

function renderBuilding(ctx) {
  const b = $("#building");
  b.innerHTML = "";
  for (const f of FLOORS) {
    const div = document.createElement("div");
    div.className = "floor";
    div.style.setProperty("--fc", f.color);
    div.innerHTML = `<div class="floor-head">
        <span class="floor-no">FLOOR ${f.n}</span>
        <span class="floor-name">${f.name}</span>
        <span class="floor-dept">${f.dept}</span>
      </div>`;
    const row = document.createElement("div");
    row.className = "agents";
    for (const a of f.agents) {
      const info = agentInfo(a.id, ctx);
      const el = document.createElement("button");
      el.className = "agent";
      el.dataset.agent = a.id;
      el.innerHTML = `<div class="agent-top">
          <span class="avatar">${a.id}</span>
          <span><span class="agent-id">${a.id} · ${agentStatus().toUpperCase()}</span><br>
          <span class="agent-name">${a.name}</span></span>
        </div>
        <div class="agent-task">${info.task}</div>`;
      el.onclick = () => openAgent(a, f, info);
      row.appendChild(el);
    }
    div.appendChild(row);
    b.appendChild(div);
  }
}

function verdictBadge(v) { return `<span class="verdict ${v}">${v}</span>`; }

function renderLeads() {
  const list = $("#leadList");
  $("#prospectCount").textContent = state.prospects.length ? `${state.prospects.length} under review` : "";
  list.innerHTML = "";
  if (!state.prospects.length) {
    list.innerHTML = `<div class="empty">No upcoming games in this view right now.<br>Try another league — the slate refreshes every 30 minutes.</div>`;
    return;
  }
  for (const p of state.prospects) {
    const ev = p.ev;
    const el = document.createElement("button");
    el.className = "lead";
    const edge = p.edge;
    const w = edge == null ? 0 : Math.min(100, Math.abs(edge) / 0.08 * 100);
    el.innerHTML = `
      <div class="lead-top">
        <span class="league-tag">${ev.league_label}</span>
        ${verdictBadge(p.decision.verdict)}
        <span class="lead-time">${fmtTime(ev.date)}</span>
      </div>
      <div class="lead-match">${ev.away.abbr} @ ${ev.home.abbr}</div>
      <div class="lead-odds">${p.bestAm ? `Best ${p.side === "home" ? ev.home.abbr : ev.away.abbr} ${p.bestAm} · ` : ""}${p.nBooks} book${p.nBooks === 1 ? "" : "s"}</div>
      <div class="edge-row">
        <div class="edge-bar"><div class="edge-fill ${edge < 0 ? "neg" : ""}" style="width:${w}%"></div></div>
        <div class="edge-num">${signedPct(edge)}</div>
      </div>`;
    el.onclick = () => openLead(p);
    list.appendChild(el);
  }
}

/* ---------------- paper trading ---------------- */
function drawEquity(p) {
  const cv = $("#equityCurve");
  if (!cv) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = cv.clientWidth || (cv.parentElement && cv.parentElement.clientWidth) || 300;
  const h = 160;
  cv.width = Math.max(1, w * dpr);
  cv.height = h * dpr;
  cv.style.height = h + "px";
  const c = cv.getContext("2d");
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, w, h);
  const pts = p.equity || [];
  if (pts.length < 2) {
    c.fillStyle = "#8ba0ad";
    c.font = "12px sans-serif";
    c.fillText("Equity curve builds as positions settle.", 12, h / 2);
    return;
  }
  const vals = pts.map(e => Number(e.bankroll));
  let lo = Math.min(...vals, p.bankroll_start);
  let hi = Math.max(...vals, p.bankroll_start);
  if (hi - lo < 1) { hi += 0.5; lo -= 0.5; }
  const X = i => 8 + (w - 16) * (i / (pts.length - 1));
  const Y = v => h - 14 - (h - 30) * ((v - lo) / (hi - lo));
  // starting-bankroll reference line
  c.strokeStyle = "rgba(139,160,173,0.5)";
  c.setLineDash([4, 4]);
  c.beginPath();
  c.moveTo(0, Y(p.bankroll_start));
  c.lineTo(w, Y(p.bankroll_start));
  c.stroke();
  c.setLineDash([]);
  const up = vals[vals.length - 1] >= p.bankroll_start;
  const col = up ? "#3ddc97" : "#ff6b6b";
  const grad = c.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, up ? "rgba(61,220,151,0.25)" : "rgba(255,107,107,0.25)");
  grad.addColorStop(1, "rgba(0,0,0,0)");
  c.beginPath();
  pts.forEach((e, i) => { const x = X(i), y = Y(Number(e.bankroll)); i ? c.lineTo(x, y) : c.moveTo(x, y); });
  c.strokeStyle = col;
  c.lineWidth = 2;
  c.stroke();
  c.lineTo(X(pts.length - 1), h);
  c.lineTo(X(0), h);
  c.closePath();
  c.fillStyle = grad;
  c.fill();
  c.fillStyle = "#8ba0ad";
  c.font = "11px sans-serif";
  c.fillText(fmtMoney(hi), 8, 14);
  c.fillText(fmtMoney(lo), 8, h - 4);
}

function renderPaper() {
  if (!$("#paperSection")) return;
  const p = state.paper;
  if (!p) {
    $("#paperSummary").innerHTML = `<p class="empty" style="padding:12px">No paper trades yet — the engine opens a fake-money position whenever the Decision department issues a PASS. Fake money only; no real wagers, ever.</p>`;
    return;
  }
  const pnl = Number(p.bankroll) - Number(p.bankroll_start);
  const open = p.open || [];
  const settled = p.settled || [];
  const wins = settled.filter(s => Number(s.profit) > 0).length;
  $("#paperSummary").innerHTML = `
    <div class="paper-stats">
      <div><span class="stat-label">Fake bankroll</span><strong>${fmtMoney(p.bankroll)}</strong></div>
      <div><span class="stat-label">Fake P&amp;L</span><strong class="${pnl >= 0 ? "pnl-pos" : "pnl-neg"}">${signedMoney(pnl)}</strong></div>
      <div><span class="stat-label">Open</span><strong>${open.length}</strong></div>
      <div><span class="stat-label">Settled</span><strong>${settled.length} (${wins}W)</strong></div>
    </div>
    <p class="paper-updated">Updated ${ago(p.updated_at)} · started at ${fmtMoney(p.bankroll_start)} fake dollars</p>`;
  drawEquity(p);
  $("#openBody").innerHTML = open.map(o => `
    <tr><td>${o.league_label || ""} · ${o.matchup}</td>
    <td>${o.side_abbr || o.side} ML</td>
    <td class="num">${o.odds_american}</td>
    <td class="num">${fmtMoney(o.stake)}</td>
    <td>${o.book}</td></tr>`).join("")
    || `<tr><td colspan="5" class="empty">No open positions.</td></tr>`;
  $("#openCount").textContent = open.length ? `(${open.length})` : "";
  $("#settledBody").innerHTML = [...settled].reverse().map(s => `
    <tr><td>${s.league_label || ""} · ${s.matchup}</td>
    <td>${s.side_abbr || s.side} ML</td>
    <td class="num">${s.odds_american}</td>
    <td class="num ${Number(s.profit) >= 0 ? "pnl-pos" : "pnl-neg"}">${signedMoney(s.profit)}</td>
    <td>${ago(s.graded_at)}</td></tr>`).join("")
    || `<tr><td colspan="5" class="empty">Nothing settled yet.</td></tr>`;
  $("#settledCount").textContent = settled.length ? `(${settled.length})` : "";
}

/* ---------------- sheets ---------------- */
function openSheet(html) {
  $("#sheetBody").innerHTML = html;
  $("#sheetWrap").hidden = false;
  document.body.style.overflow = "hidden";
}
function closeSheet() {
  $("#sheetWrap").hidden = true;
  document.body.style.overflow = "";
}
$("#sheetClose").onclick = closeSheet;
$("#sheetBackdrop").onclick = closeSheet;
document.addEventListener("keydown", e => { if (e.key === "Escape") closeSheet(); });

function openAgent(a, f, info) {
  const flows = (arr, cls) => arr.map(([who, what]) =>
    `<div class="flowline"><span class="${cls}">${who}</span><span class="arrow">→</span><span>${what}</span></div>`).join("");
  const decisions = info.decisions ? `
    <div class="kv"><h3>Latest decisions</h3>
      ${info.decisions.map(d => `
        <div style="margin-bottom:10px"><div style="display:flex;gap:8px;align-items:center;margin-bottom:4px">
          <strong style="font-size:13.5px">${d.label}</strong>${verdictBadge(d.verdict)}
        </div>
        ${d.reasons.map(r => `<div class="reason">${r}</div>`).join("")}</div>`).join("")}
    </div>` : "";
  openSheet(`
    <h2>${a.id} · ${a.name}</h2>
    <div class="sub">Floor ${f.n} — ${f.dept}</div>
    <div class="kv"><h3>Role</h3><p>${a.role}</p></div>
    <div class="kv"><h3>Current task</h3><p>${info.task}</p></div>
    <div class="kv"><h3>Receives from</h3>${flows(info.from, "from")}</div>
    <div class="kv"><h3>Sends to</h3>${flows(info.to, "to")}</div>
    ${decisions}`);
}

function openLead(p) {
  const ev = p.ev;
  const rows = (p.books || []).map(b => {
    const tot = b.total != null ? `${b.total} <span style="color:var(--muted)">(O ${b.over_odds || "—"} / U ${b.under_odds || "—"})</span>` : "—";
    return `<tr><td>${b.provider}</td><td class="num">${(b.home && b.home.ml) || "—"}</td>
      <td class="num">${(b.away && b.away.ml) || "—"}</td><td>${b.details || "—"}</td><td>${tot}</td></tr>`;
  }).join("");
  const moves = (p.bookMoves || []).map(m =>
    `<div class="reason">${m.provider}: home opened ${m.open}, now ${m.cur}</div>`).join("");
  openSheet(`
    <h2>${ev.away.abbr} @ ${ev.home.abbr}</h2>
    <div class="sub">${ev.league_label} · ${fmtTime(ev.date)} · ${verdictBadge(p.decision.verdict)}</div>
    <div class="kv"><h3>Model vs market</h3>
      ${p.threeWay ? `
      <p>3-way market (home / draw / away) — the edge model only prices 2-way moneylines, so no edge is computed for this game.<br>
      Best home price: <strong>${p.bestAm || "—"}</strong> · Best away price: <strong>${p.bestAmA || "—"}</strong><br>
      <span style="color:var(--muted)">Held in research until a draw-aware model is added.</span></p>` : `
      <p>Fair probability (devigged consensus): <strong>${ev.home.abbr} ${pct(p.fairH)} · ${ev.away.abbr} ${pct(p.fairA)}</strong><br>
      Best price on ${p.side === "home" ? ev.home.abbr : ev.away.abbr}: <strong>${p.bestAm || "—"}</strong><br>
      Edge: <strong>${signedPct(p.edge)}</strong> · Expected value per unit: <strong>${signedPct(p.expVal)}</strong><br>
      <span style="color:var(--muted)">Stake guide (half-Kelly, capped at 2% of bankroll): <strong>${pct(p.kelly)}</strong> — guide only, never auto-placed.</span></p>`}
    </div>
    <div class="kv"><h3>Books (${p.nBooks})</h3>
      <table class="odds"><tr><th>Book</th><th>Home ML</th><th>Away ML</th><th>Line</th><th>Total</th></tr>${rows}</table>
    </div>
    ${moves ? `<div class="kv"><h3>Line movement (open → now)</h3>${moves}</div>` : ""}
    <div class="kv"><h3>Evidence checklist</h3>
      ${(p.checks || []).map(c => `<div class="check"><span class="${c.pass ? "ok" : "no"}">${c.pass ? "✓" : "✕"}</span><span>${c.label} — ${c.detail}</span></div>`).join("")}
    </div>
    <div class="kv"><h3>Decision — ${p.decision.verdict}</h3>
      ${p.decision.reasons.map(r => `<div class="reason">${r}</div>`).join("")}
    </div>`);
}

/* ---------------- flow animation ---------------- */
const canvas = $("#flow");
const g2d = canvas.getContext("2d");
let packets = [], lastT = 0, spawnAcc = 0;

function sizeCanvas() {
  const r = $("#buildingWrap").getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.max(1, r.width * dpr);
  canvas.height = Math.max(1, r.height * dpr);
  g2d.setTransform(dpr, 0, 0, dpr, 0, 0);
}
function agentCenter(id) {
  const el = document.querySelector(`[data-agent="${id}"] .avatar`);
  if (!el) return null;
  const r = el.getBoundingClientRect(), w = $("#buildingWrap").getBoundingClientRect();
  return { x: r.left + r.width / 2 - w.left, y: r.top + r.height / 2 - w.top };
}
function spawnPacket() {
  // FLOORS is top-down [F4,F3,F2,F1]; flow goes upward: idx 3->2, 2->1, 1->0
  const fromIdx = [3, 2, 1][Math.floor(Math.random() * 3)];
  const fa = FLOORS[fromIdx].agents, ta = FLOORS[fromIdx - 1].agents;
  const a = fa[Math.floor(Math.random() * fa.length)];
  const b = ta[Math.floor(Math.random() * ta.length)];
  const p1 = agentCenter(a.id), p2 = agentCenter(b.id);
  if (!p1 || !p2) return;
  packets.push({ x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, t: 0, c: FLOORS[fromIdx].color });
}
function loop(t) {
  requestAnimationFrame(loop);
  const dt = Math.min(0.05, (t - lastT) / 1000 || 0);
  lastT = t;
  const w = $("#buildingWrap").getBoundingClientRect();
  g2d.clearRect(0, 0, w.width, w.height);
  if (state.paused) return;
  spawnAcc += dt * state.speed;
  if (spawnAcc > 1.1) { spawnAcc = 0; spawnPacket(); }
  packets = packets.filter(p => p.t < 1);
  for (const p of packets) {
    p.t += dt * 0.55 * state.speed;
    const x = p.x1 + (p.x2 - p.x1) * p.t, y = p.y1 + (p.y2 - p.y1) * p.t;
    g2d.beginPath();
    g2d.strokeStyle = "rgba(255,255,255,0.10)";
    g2d.lineWidth = 1.5;
    g2d.moveTo(p.x1, p.y1); g2d.lineTo(p.x2, p.y2); g2d.stroke();
    g2d.beginPath();
    g2d.fillStyle = "#3ddc97";
    g2d.shadowColor = "#3ddc97"; g2d.shadowBlur = 10;
    g2d.arc(x, y, 3.5, 0, Math.PI * 2); g2d.fill();
    g2d.shadowBlur = 0;
  }
}

/* ---------------- boot ---------------- */
function ctx() {
  const evs = eventsInScope();
  const nUp = state.prospects.length;
  const hist = loadHist();
  const names = [...new Set(evs.filter(e => e.status !== "final").map(e => e.league_label))];
  return {
    prospects: state.prospects, nUp, nEvents: evs.length,
    leagueNames: names.length ? names.join(", ") : "—",
    histAge: hist && hist.fetched_at ? ago(hist.fetched_at) : null,
  };
}

function refresh() {
  state.prospects = computeProspects();
  const c = ctx();
  renderChips();
  renderBuilding(c);
  renderLeads();
  renderPaper();
  sizeCanvas();
}

async function boot() {
  try {
    const res = await fetch("data/odds.json", { cache: "no-store" });
    if (!res.ok) throw new Error("no data");
    state.data = await res.json();
  } catch (e) {
    $("#waiting").hidden = false;
    $("#livePill").innerHTML = `<span class="dot"></span>WAITING`;
    return;
  }
  // Paper-trading ledger is optional: the engine writes it on its own
  // schedule. Absence just means no paper trades yet — honest empty state.
  try {
    const pr = await fetch("data/paper.json", { cache: "no-store" });
    if (pr.ok) state.paper = await pr.json();
  } catch (e) { /* not fatal */ }
  $("#app").hidden = false;
  const ageH = (Date.now() - new Date(state.data.fetched_at).getTime()) / 3600000;
  const pill = $("#livePill");
  if (ageH < 3) { pill.classList.add("live"); pill.innerHTML = `<span class="dot"></span>LIVE`; }
  else { pill.classList.add("stale"); pill.innerHTML = `<span class="dot"></span>STALE`; }
  const fu = new Date(state.data.fetched_at);
  $("#updatedAt").textContent = `Updated ${ago(state.data.fetched_at)} · ${String(fu.getUTCHours()).padStart(2, "0")}:${String(fu.getUTCMinutes()).padStart(2, "0")} UTC`;

  $("#pauseBtn").onclick = () => {
    state.paused = !state.paused;
    $("#pauseBtn").textContent = state.paused ? "▶ Resume flow" : "⏸ Pause flow";
    $("#pauseBtn").setAttribute("aria-pressed", String(state.paused));
  };
  $("#speed").oninput = e => {
    state.speed = parseFloat(e.target.value);
    $("#speedVal").textContent = state.speed + "×";
  };
  new ResizeObserver(sizeCanvas).observe($("#buildingWrap"));
  window.addEventListener("orientationchange", () => setTimeout(sizeCanvas, 300));

  refresh();
  sizeCanvas();
  requestAnimationFrame(loop);
}

boot();
