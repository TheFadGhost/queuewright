const SVGNS = "http://www.w3.org/2000/svg";
const STATES = { queued: "QUEUED", scheduled: "SCHED", running: "RUNNING", succeeded: "DONE", retrying: "RETRY", failed: "FAILED", dead: "DEAD", cancelled: "CANCELLED" };
const TERMINAL_STATES = new Set(["succeeded", "failed", "dead", "cancelled"]);
const SUMMARY_KEYS = ["queued", "scheduled", "running", "retrying", "dead"];
const WINDOWS = [
  { label: "15m", ms: 15 * 60 * 1000 },
  { label: "1h", ms: 60 * 60 * 1000 },
  { label: "6h", ms: 6 * 60 * 60 * 1000 },
  { label: "24h", ms: 24 * 60 * 60 * 1000 },
];
const BUCKETS = 60;

function qs(sel) { return document.querySelector(sel); }
function ce(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
function sv(tag, attrs) {
  const n = document.createElementNS(SVGNS, tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  return n;
}
function pad2(n) { return String(n).padStart(2, "0"); }
function fmtAbs(ms) {
  const d = new Date(ms);
  return d.getUTCFullYear() + "-" + pad2(d.getUTCMonth() + 1) + "-" + pad2(d.getUTCDate()) + " " +
    pad2(d.getUTCHours()) + ":" + pad2(d.getUTCMinutes()) + ":" + pad2(d.getUTCSeconds()) + " UTC";
}
function fmtDT(ms) {
  const d = new Date(ms);
  return d.getUTCFullYear() + "-" + pad2(d.getUTCMonth() + 1) + "-" + pad2(d.getUTCDate()) + " " +
    pad2(d.getUTCHours()) + ":" + pad2(d.getUTCMinutes()) + ":" + pad2(d.getUTCSeconds());
}
function fmtTime(ms) {
  const d = new Date(ms);
  return pad2(d.getUTCHours()) + ":" + pad2(d.getUTCMinutes()) + ":" + pad2(d.getUTCSeconds());
}
function fmtHM(ms) {
  const d = new Date(ms);
  return pad2(d.getUTCHours()) + ":" + pad2(d.getUTCMinutes());
}
function rel(ms) {
  if (ms == null) return "";
  const diff = Date.now() - ms, fut = diff < 0, a = Math.abs(diff) / 1000;
  let v, u;
  if (a < 60) { v = Math.max(1, Math.round(a)); u = "s"; }
  else if (a < 3600) { v = Math.round(a / 60); u = "min"; }
  else if (a < 86400) { v = Math.round(a / 3600); u = "h"; }
  else { v = Math.round(a / 86400); u = "d"; }
  return fut ? "in " + v + " " + u : v + " " + u + " ago";
}
function fmtDur(ms) {
  if (ms == null || isNaN(ms)) return "-";
  if (ms < 1000) return Math.round(ms) + "ms";
  const s = ms / 1000;
  if (s < 60) return (s >= 10 ? s.toFixed(0) : s.toFixed(1)) + "s";
  const m = s / 60;
  if (m < 60) return (m >= 10 ? m.toFixed(0) : m.toFixed(1)) + "m";
  const h = m / 60;
  return (h >= 10 ? h.toFixed(0) : h.toFixed(1)) + "h";
}
function midTrunc(s, max) {
  max = max || 18;
  if (!s || s.length <= max) return s;
  const head = Math.ceil((max - 1) / 2), tail = (max - 1) - head;
  return s.slice(0, head) + "\u2026" + s.slice(s.length - tail);
}
function safeStr(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  try { return JSON.stringify(v, null, 2); } catch (e) { return String(v); }
}
function prettyPayload(raw) {
  if (typeof raw !== "string" || raw.length === 0) return raw == null ? "" : String(raw);
  try {
    const p = JSON.parse(raw);
    if (p && typeof p === "object") return JSON.stringify(p, null, 2);
  } catch (e) {}
  return raw;
}
function median(arr) {
  if (!arr.length) return null;
  const a = arr.slice().sort(function (x, y) { return x - y; });
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
function niceCeil(v) {
  if (!(v > 0)) return 10;
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  const steps = [1, 2, 5, 10];
  for (let i = 0; i < steps.length; i++) { const c = steps[i] * exp; if (c >= v) return c; }
  return 10 * exp;
}
function bucketLabel(ms) {
  if (ms < 60000) return (ms / 1000) + "s";
  if (ms < 3600000) return (ms / 60000) + "m";
  return (ms / 3600000) + "h";
}

const GLYPH_SHAPES = {
  queued: () => [sv("circle", { cx: 8, cy: 8, r: 5, fill: "none", stroke: "currentColor", "stroke-width": 1.6 })],
  scheduled: () => [sv("path", { d: "M 8 3 A 5 5 0 0 1 8 13 Z", fill: "currentColor" })],
  running: () => [sv("path", { d: "M 8 2.8 L 13.2 13 L 2.8 13 Z", fill: "currentColor" })],
  succeeded: () => [sv("circle", { cx: 8, cy: 8, r: 5, fill: "currentColor" })],
  retrying: () => [
    sv("path", { d: "M 12.6 5.5 A 5 5 0 1 0 8 3", fill: "none", stroke: "currentColor", "stroke-width": 1.7 }),
    sv("path", { d: "M 8 3 L 10.1 1.7 L 10.1 4.3 Z", fill: "currentColor" }),
  ],
  failed: () => [sv("path", { d: "M 4 4 L 12 12 M 12 4 L 4 12", fill: "none", stroke: "currentColor", "stroke-width": 1.9, "stroke-linecap": "round" })],
  dead: () => [sv("rect", { x: 3.4, y: 3.4, width: 9.2, height: 9.2, fill: "currentColor" })],
  cancelled: () => [
    sv("circle", { cx: 8, cy: 8, r: 5, fill: "none", stroke: "currentColor", "stroke-width": 1.6 }),
    sv("line", { x1: 3.9, y1: 3.9, x2: 12.1, y2: 12.1, stroke: "currentColor", "stroke-width": 1.8, "stroke-linecap": "round" }),
  ],
};

function glyphSvg(shapeKey, size) {
  const svg = sv("svg", { viewBox: "0 0 16 16", width: size || 14, height: size || 14, "aria-hidden": "true", focusable: "false" });
  GLYPH_SHAPES[shapeKey]().forEach(function (p) { svg.appendChild(p); });
  return svg;
}

function stateBadge(st, size) {
  const wrap = ce("span", "state-badge st-" + st);
  wrap.appendChild(glyphSvg(st, size));
  wrap.appendChild(ce("span", "state-label", STATES[st] || String(st).toUpperCase()));
  return wrap;
}

async function api(path, opts) {
  const res = await fetch(path, Object.assign({ headers: { "Accept": "application/json" } }, opts || {}));
  if (!res.ok) {
    let msg = "HTTP " + res.status;
    try { const b = await res.json(); if (b && b.error) msg = b.error; } catch (e) {}
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return res.status === 204 ? null : res.json();
}

const state = {
  view: "list", jobId: null, detailJob: null,
  windowMs: 3600000, stats: null, series: null,
  jobs: [], cursor: null, selectedId: null,
  sortKey: "createdAt", sortDir: "desc",
  filters: { search: "", state: "", queue: "", type: "" },
  expandedAttempts: new Set(),
  liveOn: true, stale: false,
  loadedOnceList: false, loadedOnceDetail: false,
  pollFailShown: false, modalOpen: false, pollTimer: null, lastFocusBeforeModal: null,
};

function announce(msg) {
  const r = qs("#live-region");
  if (r) { r.textContent = ""; r.appendChild(document.createTextNode(msg)); }
}

function preserveFocus(host, build) {
  const active = document.activeElement;
  const inside = !!(active && host.contains(active));
  const sig = inside
    ? (active.getAttribute && (active.getAttribute("data-refocus-key") || active.getAttribute("aria-label") ||
       active.getAttribute("title") || active.getAttribute("href") || active.dataset.state)) || ""
    : null;
  build();
  if (!inside) return;
  const candidates = host.querySelectorAll("[data-refocus-key],[aria-label],[title],[href],[data-state]");
  for (let i = 0; i < candidates.length; i++) {
    const el = candidates[i];
    const s = el.getAttribute("data-refocus-key") || el.getAttribute("aria-label") ||
      el.getAttribute("title") || el.getAttribute("href") || el.dataset.state;
    if (s === sig) { el.focus(); return; }
  }
}

function showBanner(message, withRetry) {
  const b = qs("#banner");
  b.textContent = "";
  b.appendChild(document.createTextNode(message));
  if (withRetry) {
    const btn = ce("button", "btn", "Retry");
    btn.type = "button";
    btn.addEventListener("click", function () { hideBanner(); refreshAll(false); });
    b.appendChild(btn);
  }
  b.hidden = false;
}

function hideBanner() { qs("#banner").hidden = true; }

function setStale(on) {
  state.stale = on;
  ["#stale-header", "#stale-charts", "#stale-table"].forEach(function (sel) { qs(sel).hidden = !on; });
}

function setLastRefreshed() { qs("#last-refreshed").textContent = "last refreshed " + fmtTime(Date.now()) + " UTC"; }

function initTheme() {
  const sel = qs("#theme-select");
  sel.value = document.documentElement.getAttribute("data-theme") || "light";
  sel.addEventListener("change", function () {
    document.documentElement.setAttribute("data-theme", sel.value);
    try { localStorage.setItem("qw-theme", sel.value); } catch (e) {}
  });
}

function winMeta() {
  for (let i = 0; i < WINDOWS.length; i++) if (WINDOWS[i].ms === state.windowMs) return WINDOWS[i];
  return WINDOWS[1];
}

function buildWindowSelect() {
  const host = qs("#window-select");
  host.textContent = "";
  WINDOWS.forEach(function (w) {
    const b = ce("button", "window-btn", w.label);
    b.type = "button";
    b.setAttribute("aria-pressed", w.ms === state.windowMs ? "true" : "false");
    b.addEventListener("click", function () {
      if (state.windowMs === w.ms) return;
      state.windowMs = w.ms;
      buildWindowSelect();
      loadSeries().catch(showLoadError);
    });
    host.appendChild(b);
  });
}

async function loadStats() {
  const data = await api("/api/stats");
  state.stats = data;
  renderSystemStatus(data);
  renderSummary(data);
  renderQueueStrip(data);
  syncFilterOptions(data);
}

function renderSystemStatus(data) {
  const host = qs("#system-status");
  host.textContent = "";
  host.className = "sys-status st-" + (data.globalPaused ? "scheduled" : "succeeded");
  host.appendChild(glyphSvg(data.globalPaused ? "scheduled" : "succeeded", 12));
  host.appendChild(document.createTextNode(data.globalPaused ? "PAUSED" : "ACTIVE"));
  qs("#global-pause-btn").textContent = data.globalPaused ? "Resume all queues" : "Pause all queues";
}

function renderSummary(data) {
  const host = qs("#summary-items");
  preserveFocus(host, function () {
    const prevPressed = {};
    host.querySelectorAll(".summary-item[data-state]").forEach(function (el) {
      prevPressed[el.dataset.state] = el.getAttribute("aria-pressed") === "true";
    });
    host.textContent = "";
  SUMMARY_KEYS.forEach(function (key) {
    const item = ce("button", "summary-item st-" + key);
    item.type = "button";
    item.dataset.state = key;
    item.setAttribute("aria-pressed", prevPressed[key] ? "true" : "false");
    item.title = "Filter table by state " + STATES[key];
    item.appendChild(ce("span", "s-label", STATES[key]));
    item.appendChild(ce("span", "s-value", String(data.states[key] != null ? data.states[key] : 0)));
    item.addEventListener("click", function () {
      setFilter("state", item.getAttribute("aria-pressed") === "true" ? "" : key);
    });
    host.appendChild(item);
  });

  let thr = null, p95 = null, p95Note = "no completions";
  const pts = state.series && state.series.points;
  if (pts) {
    let tot = 0;
    pts.forEach(function (p) { tot += p.succeeded || 0; });
    thr = tot / (state.windowMs / 60000);
    // The most recent completed bucket's true p95 - not a median of bucket
    // p95s, which would understate the tail.
    for (let i = pts.length - 1; i >= 0; i--) {
      if (pts[i] && pts[i].durationsP95 != null) {
        p95 = pts[i].durationsP95;
        p95Note = "last completed minute";
        break;
      }
    }
  }
  [["throughput", "THROUGHPUT/MIN", thr == null ? "-" : (Math.round(thr * 10) / 10).toFixed(1)],
   ["latency", "LATENCY P95", p95 == null ? "-" : fmtDur(p95), p95 == null ? "" : "p95 over " + p95Note]].forEach(function (s) {
    const item = ce("div", "summary-item");
    item.dataset.stat = s[0];
    item.appendChild(ce("span", "s-label", s[1]));
    item.appendChild(ce("span", "s-value", s[2]));
    if (s[3]) item.title = s[3];
    host.appendChild(item);
  });
    syncSummaryPressed();
  });
}

function syncSummaryPressed() {
  qs("#summary-items").querySelectorAll(".summary-item[data-state]").forEach(function (el) {
    el.setAttribute("aria-pressed", state.filters.state === el.dataset.state ? "true" : "false");
  });
}

function renderQueueStrip(data) {
  const host = qs("#queue-strip");
  preserveFocus(host, function () {
    host.textContent = "";
    const pausedSet = new Set(data.pausedQueues || []);
    (data.queues || []).forEach(function (q) {
      const chip = ce("span", "queue-chip");
      chip.title = q.queue + ": " + (q.queued || 0) + " queued";
      chip.appendChild(ce("span", "q-name", q.queue));
      chip.appendChild(ce("span", "q-count", String(q.queued != null ? q.queued : 0)));
      if (pausedSet.has(q.queue)) chip.appendChild(ce("span", "paused-pill", "PAUSED"));
      const action = pausedSet.has(q.queue) ? "resume" : "pause";
      const btn = ce("button", "btn-mini", action);
      btn.type = "button";
      btn.setAttribute("aria-label", action + " queue " + q.queue);
      btn.addEventListener("click", function () {
        api("/api/queues/" + encodeURIComponent(q.queue) + "/" + action, { method: "POST" })
          .then(loadStats)
          .then(function () { announce("Queue " + q.queue + " " + action + "d"); })
          .catch(function (err) { showBanner("Queue " + action + " failed: " + err.message, false); });
      });
      chip.appendChild(btn);
      host.appendChild(chip);
    });
    if (!(data.queues || []).length) host.appendChild(ce("span", "muted", "No queues reported yet."));
  });
}

function drawFrame(svg, plot, yMax, yFmt, windowMs, startMs) {
  [0, yMax / 2, yMax].forEach(function (v) {
    const y = plot.y + plot.h - (v / yMax) * plot.h;
    svg.appendChild(sv("line", { x1: plot.x, y1: y, x2: plot.x + plot.w, y2: y, stroke: "var(--border)", "stroke-width": 1 }));
    const t = sv("text", { x: plot.x - 6, y: y + 3, "text-anchor": "end", "class": "ax-label" });
    t.textContent = yFmt(v);
    svg.appendChild(t);
  });
  [0, 0.5, 1].forEach(function (frac, idx) {
    const x = plot.x + frac * plot.w;
    svg.appendChild(sv("line", { x1: x, y1: plot.y, x2: x, y2: plot.y + plot.h, stroke: "var(--border)", "stroke-width": 1, "stroke-dasharray": "2 4" }));
    const lbl = sv("text", { x: x, y: plot.y + plot.h + 14, "text-anchor": idx === 0 ? "start" : (idx === 1 ? "middle" : "end"), "class": "ax-label" });
    lbl.textContent = fmtHM(startMs + frac * windowMs);
    svg.appendChild(lbl);
  });
}

function newChart() {
  return { svg: sv("svg", { viewBox: "0 0 520 190", role: "img", focusable: "false" }), plot: { x: 42, y: 12, w: 468, h: 154 } };
}

function addNote(chart, text) {
  const note = sv("text", { x: chart.plot.x + chart.plot.w / 2, y: chart.plot.y + chart.plot.h / 2, "text-anchor": "middle", "class": "chart-note" });
  note.textContent = text;
  chart.svg.appendChild(note);
}

function emptyChart(message) {
  const wm = winMeta(), c = newChart();
  addNote(c, message);
  drawFrame(c.svg, c.plot, 10, String, wm.ms, Date.now() - wm.ms);
  return c.svg;
}

function chartFoot(id) {
  const wm = winMeta();
  qs(id).textContent = wm.label + " - " + BUCKETS + " x " + bucketLabel(wm.ms / BUCKETS) + " buckets - UTC";
}

function renderThroughputChart(series) {
  const host = qs("#chart-throughput");
  host.textContent = "";
  chartFoot("#foot-throughput");
  const points = (series && series.points) ? series.points : [];
  if (!points.length) {
    host.appendChild(emptyChart("Not enough data yet - no completions in this window."));
    return;
  }
  const n = points.length;
  const totals = points.map(function (p) { return (p.succeeded || 0) + (p.failed || 0); });
  let peakIdx = 0;
  totals.forEach(function (t, i) { if (t > totals[peakIdx]) peakIdx = i; });
  const succTot = points.reduce(function (a, p) { return a + (p.succeeded || 0); }, 0);
  const failTot = points.reduce(function (a, p) { return a + (p.failed || 0); }, 0);
  const startMs = points[0].bucketStart;
  const spanMs = n * (winMeta().ms / BUCKETS);
  const c = newChart();
  c.svg.setAttribute("aria-label", "Throughput " + winMeta().label + ": peak " + totals[peakIdx] + "/min at " +
    fmtHM(points[peakIdx].bucketStart) + " UTC, total succeeded " + succTot + ", total failed " + failTot + ".");
  const yMax = niceCeil(Math.max.apply(null, totals));
  drawFrame(c.svg, c.plot, yMax, function (v) { return String(Math.round(v)); }, spanMs, startMs);
  if (points.filter(function (p) { return p.missing; }).length / n > 0.2) {
    addNote(c, "incomplete data");
    host.appendChild(c.svg);
    return;
  }
  const bars = sv("g", {});
  const bw = c.plot.w / n, gap = Math.min(2, bw * 0.15);
  points.forEach(function (p, i) {
    if (p.missing) return;
    const x = c.plot.x + i * bw + gap / 2, w = Math.max(bw - gap, 1);
    const succ = p.succeeded || 0, fail = p.failed || 0;
    if (fail > 0) {
      // Failed segments carry a dashed outline in addition to colour so the
      // split is legible without hue (colourblind-safe requirement).
      bars.appendChild(sv("rect", { x: x, y: c.plot.y + c.plot.h - ((succ + fail) / yMax) * c.plot.h, width: w, height: (fail / yMax) * c.plot.h, fill: "var(--st-failed)", stroke: "var(--fg)", "stroke-width": "1", "stroke-dasharray": "2 1" }));
    }
    if (succ > 0) bars.appendChild(sv("rect", { x: x, y: c.plot.y + c.plot.h - (succ / yMax) * c.plot.h, width: w, height: (succ / yMax) * c.plot.h, fill: "var(--st-succeeded)" }));
  });
  c.svg.appendChild(bars);
  host.appendChild(c.svg);
  renderThroughputLegend(host);
}

function renderThroughputLegend(afterEl) {
  let legend = qs("#legend-throughput");
  if (!legend) {
    legend = ce("div");
    legend.id = "legend-throughput";
    legend.className = "legend";
    afterEl.insertAdjacentElement("afterend", legend);
  }
  legend.textContent = "";
  [["succeeded", "var(--st-succeeded)"], ["failed", "var(--st-failed)"]].forEach(function (it) {
    const span = ce("span");
    const s = sv("svg", { width: 12, height: 12, viewBox: "0 0 12 12", "aria-hidden": "true", focusable: "false" });
    if (it[0] === "succeeded") {
      s.appendChild(sv("rect", { x: 1, y: 1, width: 10, height: 10, fill: it[1] }));
    } else {
      s.appendChild(sv("rect", { x: 1, y: 1, width: 10, height: 10, fill: it[1], stroke: "var(--fg)", "stroke-width": "1", "stroke-dasharray": "2 1" }));
    }
    span.appendChild(s);
    span.appendChild(document.createTextNode(" " + it[0]));
    legend.appendChild(span);
  });
}

const LAT_KEYS = ["durationsP50", "durationsP95", "durationsP99"];

function hasLat(p) { return p && !p.missing && LAT_KEYS.some(function (k) { return p[k] != null; }); }

function buildLegend() {
  const host = qs("#legend-latency");
  host.textContent = "";
  [["p50", "var(--fg-muted)", "1.5", null], ["p95", "var(--fg)", "2", null], ["p99", "var(--fg-muted)", "1.5", "4 3"]].forEach(function (it) {
    const span = ce("span");
    const s = sv("svg", { width: 20, height: 8, viewBox: "0 0 20 8", "aria-hidden": "true", focusable: "false" });
    const la = { x1: 1, y1: 4, x2: 19, y2: 4, stroke: it[1], "stroke-width": it[2] };
    if (it[3]) la["stroke-dasharray"] = it[3];
    s.appendChild(sv("line", la));
    span.appendChild(s);
    span.appendChild(document.createTextNode(it[0]));
    host.appendChild(span);
  });
}

function renderLatencyChart(series) {
  const host = qs("#chart-latency");
  host.textContent = "";
  chartFoot("#foot-latency");
  const points = (series && series.points) ? series.points : [];
  const validCount = points.filter(hasLat).length;
  if (!points.length || validCount === 0) {
    buildLegend();
    host.appendChild(emptyChart("Not enough data yet - no completions in this window."));
    return;
  }
  const n = points.length;
  let vmax = 0;
  points.forEach(function (p) {
    if (!hasLat(p)) return;
    LAT_KEYS.forEach(function (k) { if (p[k] != null && p[k] > vmax) vmax = p[k]; });
  });
  const latest = {};
  for (let i = points.length - 1; i >= 0; i--) {
    LAT_KEYS.forEach(function (k) {
      if (latest[k] == null && hasLat(points[i]) && points[i][k] != null) latest[k] = points[i][k];
    });
  }
  const startMs = points[0].bucketStart;
  const spanMs = n * (winMeta().ms / BUCKETS);
  const c = newChart();
  c.svg.setAttribute("aria-label", "Latency percentiles " + winMeta().label + ": latest p50 " + fmtDur(latest.durationsP50) +
    ", p95 " + fmtDur(latest.durationsP95) + ", p99 " + fmtDur(latest.durationsP99) + ".");
  const yMax = niceCeil(vmax);
  drawFrame(c.svg, c.plot, yMax, fmtDur, spanMs, startMs);
  if (validCount / n <= 0.8) {
    buildLegend();
    addNote(c, "incomplete data");
    host.appendChild(c.svg);
    return;
  }
  [{ key: "durationsP50", stroke: "var(--fg-muted)", width: 1.5, dash: null },
   { key: "durationsP95", stroke: "var(--fg)", width: 2, dash: null },
   { key: "durationsP99", stroke: "var(--fg-muted)", width: 1.5, dash: "4 3" }].forEach(function (st) {
    const g = sv("g", { fill: "none", stroke: st.stroke, "stroke-width": st.width });
    if (st.dash) g.setAttribute("stroke-dasharray", st.dash);
    const segs = [];
    let cur = [];
    points.forEach(function (p, i) {
      if (hasLat(p) && p[st.key] != null) {
        cur.push([c.plot.x + (i + 0.5) * (c.plot.w / n), c.plot.y + c.plot.h - (p[st.key] / yMax) * c.plot.h]);
      } else if (cur.length) { segs.push(cur); cur = []; }
    });
    if (cur.length) segs.push(cur);
    segs.forEach(function (segPts) {
      if (segPts.length === 1) {
        g.appendChild(sv("circle", { cx: segPts[0][0], cy: segPts[0][1], r: 2, fill: st.stroke, stroke: "none" }));
        return;
      }
      let d = "M " + segPts[0][0].toFixed(1) + " " + segPts[0][1].toFixed(1);
      for (let i = 1; i < segPts.length; i++) d += " L " + segPts[i][0].toFixed(1) + " " + segPts[i][1].toFixed(1);
      g.appendChild(sv("path", { d: d }));
    });
    c.svg.appendChild(g);
  });
  buildLegend();
  host.appendChild(c.svg);
}

async function loadSeries() {
  const data = await api("/api/timeseries?windowMs=" + state.windowMs + "&buckets=" + BUCKETS);
  state.series = data;
  renderThroughputChart(data);
  renderLatencyChart(data);
  if (state.stats) renderSummary(state.stats);
}

function jobSortValue(job, key) {
  if (key === "attempts") return job.attempts || 0;
  if (key === "duration") {
    const h = job.attemptsHistory || [];
    if (h.length) {
      const last = h[h.length - 1];
      if (last.finishedAt && last.durationMs != null) return last.durationMs;
      if (last.startedAt) return Math.max(0, Date.now() - last.startedAt);
    }
    return -1;
  }
  return job.createdAt || 0;
}

function sortJobs(jobs) {
  const k = state.sortKey, dir = state.sortDir === "asc" ? 1 : -1;
  return jobs.slice().sort(function (a, b) { return (jobSortValue(a, k) - jobSortValue(b, k)) * dir; });
}

function syncSortHeaders() {
  document.querySelectorAll("th[data-sort]").forEach(function (th) {
    th.setAttribute("aria-sort", th.dataset.sort === state.sortKey ? (state.sortDir === "asc" ? "ascending" : "descending") : "none");
  });
}

function skeletonRows() {
  const tb = qs("#jobs-tbody");
  tb.textContent = "";
  for (let i = 0; i < 6; i++) {
    const tr = ce("tr", "skeleton-row");
    for (let c = 0; c < 8; c++) {
      const td = ce("td");
      td.appendChild(ce("span", "skeleton-bar"));
      tr.appendChild(td);
    }
    tb.appendChild(tr);
  }
}

function nextRunCell(job) {
  const td = ce("td", "mono");
  const ts = TERMINAL_STATES.has(job.state)
    ? ((job.attemptsHistory || []).length ? job.attemptsHistory[job.attemptsHistory.length - 1].finishedAt : null) || job.updatedAt
    : job.runAt;
  if (ts != null) {
    // Absolute with explicit timezone, relative form visible beneath - never ambiguous.
    td.appendChild(document.createTextNode(fmtDT(ts) + " UTC"));
    const relSpan = ce("span", "ts-rel", rel(ts));
    td.appendChild(relSpan);
    td.title = fmtAbs(ts) + " UTC";
  } else {
    td.textContent = "-";
  }
  return td;
}

function durationCell(job) {
  const td = ce("td", "num mono");
  const h = job.attemptsHistory || [];
  if (h.length) {
    const last = h[h.length - 1];
    if (last.finishedAt && last.durationMs != null) { td.textContent = fmtDur(last.durationMs); return td; }
    if (last.startedAt && !last.finishedAt) {
      td.textContent = fmtDur(Math.max(0, Date.now() - last.startedAt));
      td.title = "running attempt";
      return td;
    }
  }
  td.textContent = "-";
  return td;
}

function jobRow(job) {
  const tr = ce("tr");
  tr.tabIndex = -1;
  tr.dataset.id = job.id;
  const tdState = ce("td");
  tdState.appendChild(stateBadge(job.state));
  tr.appendChild(tdState);
  const tdId = ce("td");
  const link = ce("a", "mono", midTrunc(job.id, 18));
  link.href = "#/jobs/" + encodeURIComponent(job.id);
  link.title = job.id;
  tdId.appendChild(link);
  tr.appendChild(tdId);
  tr.appendChild(ce("td", "", job.type || "-"));
  const tdQ = ce("td", "", job.queue || "-");
  if (job.priority != null) {
    tdQ.appendChild(document.createTextNode(" "));
    tdQ.appendChild(ce("span", "muted", "p" + job.priority)).title = "priority " + job.priority;
  }
  tr.appendChild(tdQ);
  tr.appendChild(ce("td", "num mono", (job.attempts != null ? job.attempts : 0) + "/" + (job.maxAttempts != null ? job.maxAttempts : "?")));
  tr.appendChild(nextRunCell(job));
  tr.appendChild(durationCell(job));
  const tdC = ce("td", "num mono");
  if (job.createdAt != null) {
    tdC.appendChild(document.createTextNode(fmtDT(job.createdAt) + " UTC"));
    tdC.title = fmtAbs(job.createdAt) + " UTC (" + rel(job.createdAt) + ")";
  } else {
    tdC.textContent = "-";
  }
  tr.appendChild(tdC);
  tr.addEventListener("click", function () { selectRow(tr.dataset.id, false); });
  return tr;
}

function renderJobsTable() {
  const tb = qs("#jobs-tbody");
  syncSortHeaders();
  preserveFocus(tb, function () {
    tb.textContent = "";
    if (!state.jobs.length) {
      const tr = ce("tr"), td = ce("td", "cell-empty");
      td.colSpan = 8;
      td.appendChild(document.createTextNode("No jobs match the current filters. "));
      const clear = ce("button", "btn", "Clear filters");
      clear.type = "button";
      clear.addEventListener("click", clearFilters);
      td.appendChild(clear);
      tr.appendChild(td);
      tb.appendChild(tr);
      return;
    }
    sortJobs(state.jobs).forEach(function (job) { tb.appendChild(jobRow(job)); });
    const rows = tb.querySelectorAll("tr[data-id]");
    rows.forEach(function (r) { if (r.dataset.id === state.selectedId) r.classList.add("selected"); });
  });
  qs("#row-count").textContent = state.jobs.length ? state.jobs.length + (state.cursor ? "+" : "") + " jobs shown" : "";
  qs("#load-more").hidden = !state.cursor || !state.jobs.length;
}

function applySelection(row) {
  qs("#jobs-tbody").querySelectorAll("tr.selected").forEach(function (r) { r.classList.remove("selected"); });
  if (row) row.classList.add("selected");
}

function selectRow(id, scroll) {
  state.selectedId = id;
  let target = null;
  qs("#jobs-tbody").querySelectorAll("tr[data-id]").forEach(function (r) { if (r.dataset.id === id) target = r; });
  applySelection(target);
  if (target && scroll) target.scrollIntoView({ block: "nearest" });
}

function moveSelection(delta) {
  const rows = Array.prototype.slice.call(qs("#jobs-tbody").querySelectorAll("tr[data-id]"));
  if (!rows.length) return;
  let idx = -1;
  for (let i = 0; i < rows.length; i++) if (rows[i].dataset.id === state.selectedId) { idx = i; break; }
  idx = Math.min(Math.max(idx + delta, 0), rows.length - 1);
  selectRow(rows[idx].dataset.id, true);
}

async function loadJobs(reset) {
  if (reset) {
    state.cursor = null;
    state.jobs = [];
    if (!state.loadedOnceList) skeletonRows();
  }
  const f = state.filters, params = new URLSearchParams();
  if (f.state) params.set("states", f.state);
  if (f.queue) params.set("queue", f.queue);
  if (f.type) params.set("type", f.type);
  if (f.search) params.set("search", f.search);
  params.set("limit", "50");
  if (state.cursor) params.set("cursor", state.cursor);
  const data = await api("/api/jobs?" + params.toString());
  state.jobs = reset ? (data.jobs || []) : state.jobs.concat(data.jobs || []);
  state.cursor = data.cursor || null;
  state.loadedOnceList = true;
  renderJobsTable();
}

async function loadMoreJobs() {
  if (state.cursor) await loadJobs(false);
}

function clearFilters() {
  ["#filter-search", "#filter-state", "#filter-queue", "#filter-type"].forEach(function (sel) { qs(sel).value = ""; });
  state.filters = { search: "", state: "", queue: "", type: "" };
  syncSummaryPressed();
  loadJobs(true).then(function () { announce("Filters cleared"); }).catch(showLoadError);
}

function setFilter(key, value) {
  state.filters[key] = value;
  const map = { search: "#filter-search", state: "#filter-state", queue: "#filter-queue", type: "#filter-type" };
  qs(map[key]).value = value;
  syncSummaryPressed();
  loadJobs(true).catch(showLoadError);
}

function rebuildOptions(sel, emptyLabel, values) {
  const cur = sel.value || "";
  sel.textContent = "";
  const optEmpty = ce("option", "", emptyLabel);
  optEmpty.value = "";
  sel.appendChild(optEmpty);
  values.forEach(function (v) {
    const o = ce("option", "", v);
    o.value = v;
    sel.appendChild(o);
  });
  if (values.indexOf(cur) >= 0) sel.value = cur;
}

function syncFilterOptions(stats) {
  if (!stats) return;
  rebuildOptions(qs("#filter-queue"), "All queues", (stats.queues || []).map(function (q) { return q.queue; }));
  rebuildOptions(qs("#filter-type"), "All types", (stats.types || []).map(function (t) { return t.type; }));
}

function wireFilters() {
  let deb = null;
  qs("#filter-search").addEventListener("input", function (ev) {
    clearTimeout(deb);
    deb = setTimeout(function () { setFilter("search", ev.target.value.trim()); }, 300);
  });
  qs("#filter-state").addEventListener("change", function (ev) { setFilter("state", ev.target.value); });
  qs("#filter-queue").addEventListener("change", function (ev) { setFilter("queue", ev.target.value); });
  qs("#filter-type").addEventListener("change", function (ev) { setFilter("type", ev.target.value); });
  qs("#clear-filters").addEventListener("click", clearFilters);
  qs("#load-more").addEventListener("click", function () { loadMoreJobs().catch(showLoadError); });
  document.querySelectorAll("th[data-sort] .th-btn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      const key = btn.closest("th").dataset.sort;
      if (state.sortKey === key) state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
      else { state.sortKey = key; state.sortDir = "desc"; }
      renderJobsTable();
    });
  });
  qs("#jobs-tbody").addEventListener("dblclick", function (ev) {
    const tr = ev.target.closest("tr[data-id]");
    if (tr) location.hash = "#/jobs/" + encodeURIComponent(tr.dataset.id);
  });
}

const OUTCOME_GLYPHS = { running: "running", succeeded: "succeeded", failed: "failed", timeout: "retrying", interrupted: "cancelled" };
const OUTCOME_LABELS = { running: "RUNNING", succeeded: "DONE", failed: "FAILED", timeout: "TIMEOUT", interrupted: "INTERRUPTED" };

function detailField(dl, label, valueNode) {
  dl.appendChild(ce("dt", "", label));
  dl.appendChild(ce("dd")).appendChild(valueNode);
}

function absRelNode(ms) {
  const wrap = ce("span", "mono", ms != null ? fmtAbs(ms) : "-");
  if (ms != null) wrap.appendChild(ce("span", "rel-note", rel(ms)));
  return wrap;
}

function renderDetail(job) {
  const host = qs("#detail-view");
  const hadFocus = host.contains(document.activeElement) ? document.activeElement : null;
  const focusKey = hadFocus ? hadFocus.dataset.refocusKey : null;
  host.textContent = "";

  const back = ce("a", "back-link", "< Back to jobs");
  back.href = "#/jobs";
  host.appendChild(back);

  const header = ce("div", "detail-header");
  header.appendChild(stateBadge(job.state));
  header.appendChild(ce("h2", "detail-title", job.type || "(unknown type)"));
  header.appendChild(ce("span", "mono muted detail-id", job.id));
  header.appendChild(ce("span", "queue-chip", job.queue || "-"));
  host.appendChild(header);

  const dl = ce("dl", "detail-grid");
  detailField(dl, "ID", ce("span", "mono", job.id));
  detailField(dl, "Created", absRelNode(job.createdAt));
  detailField(dl, "Updated", absRelNode(job.updatedAt));
  if (!TERMINAL_STATES.has(job.state)) detailField(dl, "Next run", absRelNode(job.runAt));
  detailField(dl, "Attempts", ce("span", "num", (job.attempts != null ? job.attempts : 0) + " / " + (job.maxAttempts != null ? job.maxAttempts : "?")));
  if (job.timeoutMs != null) detailField(dl, "Timeout", ce("span", "num", fmtDur(job.timeoutMs)));
  if (job.retry) {
    detailField(dl, "Retry", ce("span", "", (job.retry.strategy || "-") + ", base " + fmtDur(job.retry.baseDelayMs) +
      ", max " + fmtDur(job.retry.maxDelayMs) + ", jitter " + (job.retry.jitter || "-")));
  }
  if (job.leaseUntil) detailField(dl, "Lease until", absRelNode(job.leaseUntil));
  if (job.dedupeKey) detailField(dl, "Dedupe key", ce("span", "mono", job.dedupeKey));
  if (job.scheduleId) detailField(dl, "Schedule", ce("span", "mono", job.scheduleId));
  if (job.progress) {
    const pd = ce("span");
    const frac = Math.max(0, Math.min(1, Number(job.progress.fraction) || 0));
    const track = ce("span", "progress-track");
    const fill = ce("span", "progress-fill");
    fill.style.width = (frac * 100).toFixed(1) + "%";
    track.appendChild(fill);
    pd.appendChild(track);
    const pctSpan = ce("span", "num", " " + Math.round(frac * 100) + "%");
    pd.appendChild(pctSpan);
    if (job.progress.note) pd.appendChild(ce("span", "muted", " " + job.progress.note));
    if (job.progress.at) pd.appendChild(absRelNode(job.progress.at));
    detailField(dl, "Progress", pd);
  }
  host.appendChild(dl);

  const actions = ce("div", "actions-row");
  const canRetry = ["failed", "dead", "cancelled", "succeeded"].indexOf(job.state) >= 0;
  const canCancel = ["queued", "scheduled", "retrying"].indexOf(job.state) >= 0;
  function addButton(label, cls, refocusKey, title, bodyText, kind) {
    const b = ce("button", "btn " + cls, label);
    b.type = "button";
    b.dataset.refocusKey = refocusKey;
    b.addEventListener("click", function () {
      openConfirm({
        title: title, body: (job.type || "") + " " + job.id + ". " + bodyText,
        confirmLabel: label.split(" ")[0], danger: kind === "cancel",
        onConfirm: function () { return performJobAction(kind, job.id); },
      });
    });
    actions.appendChild(b);
  }
  if (canRetry) addButton("Retry", "", "act-retry", "Retry this job?", "The job will be re-enqueued and run again.", "retry");
  if (canCancel) addButton("Cancel", "btn-danger", "act-cancel", "Cancel this job?", "The job will not run.", "cancel");
  if (job.state === "dead") addButton("Requeue from dead", "", "act-requeue", "Requeue this dead job?", "The dead letter will be moved back to the queue.", "requeue");
  const resultSpan = ce("span", "action-result");
  resultSpan.id = "action-result";
  resultSpan.setAttribute("aria-live", "polite");
  actions.appendChild(resultSpan);
  if (actions.childElementCount > 1) host.appendChild(actions);

  const payloadSec = ce("div", "detail-section");
  payloadSec.appendChild(ce("h3", "", "Payload"));
  const pre = ce("pre", "block");
  pre.textContent = prettyPayload(job.payload);
  payloadSec.appendChild(pre);
  host.appendChild(payloadSec);

  const errSec = ce("div", "detail-section");
  errSec.appendChild(ce("h3", "", "Result of last attempt"));
  const errPre = ce("pre", "block");
  if (job.lastErrorName || job.lastErrorMessage) {
    errPre.appendChild(ce("span", "error-line", (job.lastErrorName || "Error") + ": " + (job.lastErrorMessage || "")));
  } else if (job.result != null) {
    errPre.appendChild(ce("span", "result-line", safeStr(job.result)));
  } else {
    errPre.appendChild(ce("span", "muted", "No result or error recorded."));
  }
  errSec.appendChild(errPre);
  host.appendChild(errSec);

  const attSec = ce("div", "detail-section");
  attSec.appendChild(ce("h3", "", "Attempt history"));
  const hist = job.attemptsHistory || [];
  if (hist.length) attSec.appendChild(buildAttemptsTable(hist));
  else attSec.appendChild(ce("p", "muted", "No attempts recorded yet."));
  host.appendChild(attSec);

  if (focusKey) {
    const again = host.querySelector('[data-refocus-key="' + focusKey + '"]');
    if (again) again.focus();
  }
}

function buildAttemptsTable(hist) {
  const table = ce("table", "attempts-table");
  const thead = ce("thead"), hr = ce("tr");
  ["#", "Started", "Duration", "Outcome", "Error"].forEach(function (label, i) {
    const th = ce("th", "", label);
    if (i === 2) th.className = "num";
    hr.appendChild(th);
  });
  thead.appendChild(hr);
  table.appendChild(thead);
  const tbody = ce("tbody");
  hist.forEach(function (att, idx) {
    const tr = ce("tr");
    const stackKey = String(att.attempt != null ? att.attempt : idx);
    const expanded = state.expandedAttempts.has(stackKey);
    const tdN = ce("td");
    const ex = ce("button", "expander", expanded ? "\u2212" : "+");
    ex.type = "button";
    ex.setAttribute("aria-expanded", expanded ? "true" : "false");
    ex.setAttribute("aria-controls", "stack-" + idx);
    ex.setAttribute("aria-label", "Toggle stack trace for attempt " + (att.attempt != null ? att.attempt : idx + 1));
    ex.dataset.refocusKey = "exp-" + stackKey;
    ex.addEventListener("click", function () { toggleStack(stackKey, idx); });
    tdN.appendChild(ex);
    tdN.appendChild(document.createTextNode(" " + (att.attempt != null ? att.attempt : idx + 1)));
    tr.appendChild(tdN);
    tr.appendChild(ce("td", "mono", att.startedAt != null ? fmtDT(att.startedAt) : "-"));
    let durTxt = "-";
    if (att.finishedAt && att.durationMs != null) durTxt = fmtDur(att.durationMs);
    else if (att.startedAt && att.outcome === "running") durTxt = fmtDur(Math.max(0, Date.now() - att.startedAt));
    tr.appendChild(ce("td", "num mono", durTxt));
    const gk = OUTCOME_GLYPHS[att.outcome] || "queued";
    const badge = ce("span", "state-badge st-" + gk);
    badge.appendChild(glyphSvg(gk, 12));
    badge.appendChild(ce("span", "state-label", OUTCOME_LABELS[att.outcome] || String(att.outcome || "?").toUpperCase()));
    const tdO = ce("td");
    tdO.appendChild(badge);
    tr.appendChild(tdO);
    tr.appendChild(ce("td", "", att.errorMessage ? (att.errorName ? att.errorName + ": " : "") + att.errorMessage : "-"));
    tbody.appendChild(tr);
    const pre = ce("pre", "block", "");
    pre.id = "stack-" + idx;
    pre.textContent = (att.errorName ? att.errorName + ": " : "") + (att.errorMessage || "") + (att.stack ? "\n\n" + att.stack : "");
    const stackTd = ce("td", "stack-cell");
    stackTd.colSpan = 5;
    stackTd.appendChild(pre);
    const stackTr = ce("tr");
    stackTr.appendChild(stackTd);
    stackTr.hidden = !expanded;
    stackTr.dataset.stackFor = stackKey;
    tbody.appendChild(stackTr);
  });
  table.appendChild(tbody);
  return table;
}

function toggleStack(stackKey, idx) {
  const open = state.expandedAttempts.has(stackKey);
  if (open) state.expandedAttempts.delete(stackKey);
  else state.expandedAttempts.add(stackKey);
  const tbody = qs("#detail-view tbody");
  if (!tbody) return;
  const btn = tbody.querySelector('button[data-refocus-key="exp-' + stackKey + '"]');
  if (btn) {
    btn.textContent = open ? "+" : "\u2212";
    btn.setAttribute("aria-expanded", open ? "false" : "true");
  }
  const row = tbody.querySelector('tr[data-stack-for="' + stackKey + '"]');
  if (row) row.hidden = open;
}

async function loadDetail(id) {
  const data = await api("/api/jobs/" + encodeURIComponent(id));
  state.loadedOnceDetail = true;
  state.detailJob = data.job;
  renderDetail(data.job);
}

async function performJobAction(kind, id) {
  try {
    const data = await api("/api/jobs/" + encodeURIComponent(id) + "/" + kind, { method: "POST" });
    const msg = "Job " + kind + " accepted at " + fmtTime(Date.now()) + " UTC.";
    const resEl = qs("#action-result");
    if (resEl) resEl.textContent = msg;
    announce(msg);
    if (state.view === "detail" && state.jobId === id && data && data.job) renderDetail(data.job);
    loadStats().catch(function () {});
    loadSeries().catch(function () {});
  } catch (err) {
    const msg = "Action failed (" + (err.status || "network") + "): " + err.message;
    const resEl = qs("#action-result");
    if (resEl) resEl.textContent = msg;
    announce(msg);
    if (err.status !== 409) throw err;
  }
}

function openConfirm(opts) {
  const root = qs("#modal-root");
  root.textContent = "";
  state.modalOpen = true;
  state.lastFocusBeforeModal = document.activeElement;

  const overlay = ce("div", "overlay");
  overlay.addEventListener("click", closeConfirm);
  const box = ce("div", "dialog");
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");
  box.setAttribute("aria-labelledby", "dialog-title");
  box.appendChild(ce("h2", "", opts.title)).id = "dialog-title";
  box.appendChild(ce("p", "", opts.body));

  const btnRow = ce("div", "dialog-buttons");
  const cancelBtn = ce("button", "btn", "Cancel");
  cancelBtn.type = "button";
  cancelBtn.addEventListener("click", closeConfirm);
  const okBtn = ce("button", "btn" + (opts.danger ? " btn-danger" : ""), opts.confirmLabel);
  okBtn.type = "button";
  btnRow.appendChild(cancelBtn);
  btnRow.appendChild(okBtn);
  box.appendChild(btnRow);

  function doConfirm() {
    closeConfirm();
    Promise.resolve(opts.onConfirm()).catch(function (err) {
      showBanner("Action failed: " + err.message, false);
    });
  }
  okBtn.addEventListener("click", doConfirm);
  box.addEventListener("keydown", function (ev) {
    if (ev.key === "Enter") { ev.preventDefault(); doConfirm(); }
    else if (ev.key === "Escape") { ev.preventDefault(); closeConfirm(); }
    else if (ev.key === "Tab") {
      const f = [cancelBtn, okBtn], i = f.indexOf(document.activeElement);
      ev.preventDefault();
      let next = ev.shiftKey ? i - 1 : i + 1;
      if (next < 0) next = f.length - 1;
      if (next >= f.length) next = 0;
      f[next].focus();
    }
  });
  root.appendChild(overlay);
  root.appendChild(box);
  okBtn.focus();
}

function closeConfirm() {
  if (!state.modalOpen) return;
  state.modalOpen = false;
  qs("#modal-root").textContent = "";
  if (state.lastFocusBeforeModal && document.contains(state.lastFocusBeforeModal)) state.lastFocusBeforeModal.focus();
}

function confirmKeys(ev, job) {
  if (ev.key === "r" && ["failed", "dead", "cancelled", "succeeded"].indexOf(job.state) >= 0) {
    openConfirm({ title: "Retry this job?", body: (job.type || "") + " " + job.id + ". The job will be re-enqueued and run again.", confirmLabel: "Retry", onConfirm: function () { return performJobAction("retry", job.id); } });
  } else if (ev.key === "c" && ["queued", "scheduled", "retrying"].indexOf(job.state) >= 0) {
    openConfirm({ title: "Cancel this job?", body: (job.type || "") + " " + job.id + ". The job will not run.", confirmLabel: "Cancel", danger: true, onConfirm: function () { return performJobAction("cancel", job.id); } });
  } else if (ev.key === "x" && job.state === "dead") {
    openConfirm({ title: "Requeue this dead job?", body: (job.type || "") + " " + job.id + ". The dead letter will be moved back to the queue.", confirmLabel: "Requeue", onConfirm: function () { return performJobAction("requeue", job.id); } });
  }
}

function wireGlobalKeys(ev) {
  if (ev.defaultPrevented || state.modalOpen) return;
  const t = ev.target;
  const editable = !!(t && t.matches && (t.matches("input, textarea, select") || t.isContentEditable));
  if (ev.key === "/" && !editable) { ev.preventDefault(); qs("#filter-search").focus(); return; }
  if (ev.key === "Escape") {
    if (editable) { t.blur(); return; }
    if (state.view === "detail") location.hash = "#/jobs";
    return;
  }
  if (editable) return;
  if (ev.key === "Enter" && t.closest && t.closest("button, a")) return;

  if (state.view === "list") {
    if (ev.key === "j" || ev.key === "ArrowDown") { ev.preventDefault(); moveSelection(1); return; }
    if (ev.key === "k" || ev.key === "ArrowUp") { ev.preventDefault(); moveSelection(-1); return; }
    if (ev.key === "Enter" && state.selectedId) {
      ev.preventDefault();
      location.hash = "#/jobs/" + encodeURIComponent(state.selectedId);
      return;
    }
    const sel = state.jobs.find(function (j) { return j.id === state.selectedId; });
    if (sel) confirmKeys(ev, sel);
  } else if (state.view === "detail" && state.detailJob) {
    confirmKeys(ev, state.detailJob);
  }
}

function inputFocused() {
  const a = document.activeElement;
  return !!a && a.matches && (a.matches("input, textarea, select") || a.isContentEditable);
}

function parseHash() {
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  return parts[0] === "jobs" && parts[1]
    ? { view: "detail", id: decodeURIComponent(parts[1]) }
    : { view: "list" };
}

function applyRoute() {
  const r = parseHash();
  state.view = r.view;
  state.jobId = r.view === "detail" ? r.id : null;
  if (r.view !== "detail") state.detailJob = null;

  const listView = qs("#list-view"), detailView = qs("#detail-view"), crumb = qs("#crumb-current");
  if (r.view === "detail") {
    listView.hidden = true;
    detailView.hidden = false;
    crumb.hidden = false;
    crumb.textContent = "Job " + midTrunc(r.id, 22);
    if (!state.loadedOnceDetail) {
      detailView.textContent = "";
      detailView.appendChild(ce("p", "muted", "Loading job\u2026"));
    }
    loadDetail(r.id).catch(function (err) {
      detailView.textContent = "";
      detailView.appendChild(ce("p", "", err.status === 404 ? "Job not found: " + r.id : "Failed to load job: " + err.message));
      const back = ce("a", "back-link", "< Back to jobs");
      back.href = "#/jobs";
      detailView.appendChild(back);
    });
  } else {
    detailView.hidden = true;
    listView.hidden = false;
    crumb.hidden = true;
    if (!state.loadedOnceList) skeletonRows();
  }
}

function showLoadError(err) {
  showBanner("Failed to load data (" + (err.status || "network") + "): " + err.message, true);
  setStale(true);
}

async function refreshAll(manual) {
  const tasks = [loadStats(), loadSeries()];
  if (state.view === "detail" && state.jobId) tasks.push(loadDetail(state.jobId));
  else tasks.push(loadJobs(true));
  try {
    await Promise.all(tasks);
    state.pollFailShown = false;
    hideBanner();
    setStale(false);
    setLastRefreshed();
  } catch (err) {
    if (manual) showLoadError(err);
    else if (!state.pollFailShown) {
      showBanner("Live updates unavailable - retrying", false);
      state.pollFailShown = true;
      setStale(true);
    }
  }
}

function schedulePoll() {
  clearTimeout(state.pollTimer);
  if (!state.liveOn) return;
  state.pollTimer = setTimeout(function () {
    if (document.hidden || state.modalOpen || inputFocused()) { schedulePoll(); return; }
    refreshAll(false);
    schedulePoll();
  }, 5000);
}

function setLive(on) {
  state.liveOn = on;
  qs("#live-toggle").checked = on;
  if (on) { refreshAll(false); schedulePoll(); }
  else clearTimeout(state.pollTimer);
}

function wireHeaderControls() {
  qs("#live-toggle").addEventListener("change", function (ev) { setLive(ev.target.checked); });
  qs("#global-pause-btn").addEventListener("click", function () {
    const paused = state.stats && state.stats.globalPaused;
    openConfirm({
      title: paused ? "Resume all queues?" : "Pause all queues?",
      body: paused ? "Workers will start claiming jobs again." : "Workers will stop claiming new jobs across every queue.",
      confirmLabel: paused ? "Resume all" : "Pause all",
      danger: !paused,
      onConfirm: function () {
        return api(paused ? "/api/resume-all" : "/api/pause-all", { method: "POST" }).then(function () {
          announce(paused ? "All queues resumed" : "All queues paused");
          return loadStats();
        });
      },
    });
  });
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden && state.liveOn) { refreshAll(false); schedulePoll(); }
  });
}

function init() {
  initTheme();
  buildWindowSelect();
  wireFilters();
  wireHeaderControls();
  if (!location.hash) location.hash = "#/jobs";
  applyRoute();
  window.addEventListener("hashchange", applyRoute);
  document.addEventListener("keydown", wireGlobalKeys);
  setLive(true);
}

init();
