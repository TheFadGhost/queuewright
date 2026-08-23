// Read-only design-audit probe: boots DashboardServer on 7799 against an
// in-memory Queuewright seeded with synthetic jobs, then exercises the HTTP
// surface the dashboard depends on. Writes nothing outside scratch-design-audit.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Queuewright } from "../src/client.js";
import { DashboardServer } from "../src/server.js";
import { defineJob } from "../src/registry.js";
import { FatalJobError } from "../src/errors.js";

const BASE = "http://127.0.0.1:7799";
const results: Array<{ name: string; ok: boolean; note?: string }> = [];
function A(cond: unknown, msg: string): void {
  if (!cond) throw new Error("ASSERT FAIL: " + msg);
}
async function step(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log("PASS  " + name);
  } catch (e) {
    const note = e instanceof Error ? e.message : String(e);
    results.push({ name, ok: false, note });
    console.log("FAIL  " + name + " :: " + note);
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function get(path: string): Promise<{ status: number; ct: string; text: string; json(): any }> {
  const res = await fetch(BASE + path);
  const text = await res.text();
  return {
    status: res.status,
    ct: res.headers.get("content-type") ?? "",
    text,
    json: () => JSON.parse(text),
  };
}

defineJob("audit.slow", { timeoutMs: 30000 }, async () => { await sleep(6000); });
defineJob("audit.ok", async () => {});
defineJob("audit.fatal", { maxAttempts: 1 }, async () => { throw new FatalJobError("no template for region"); });
defineJob(
  "audit.flaky",
  { maxAttempts: 3, retry: { strategy: "exponential", baseDelayMs: 1200, jitter: "none" } },
  async () => { throw new Error("upstream timeout"); },
);

const qw = new Queuewright({
  storage: { kind: "memory" },
  concurrency: 2,
  log: { format: "json", level: "error" },
});
await qw.init();

const ids: Record<string, string> = {};
const seed: Array<[string, string, Record<string, unknown>]> = [
  ["slowA", "audit.slow", {}],
  ["slowB", "audit.slow", {}],
  ["ok", "audit.ok", {}],
  ["fatal", "audit.fatal", {}],
  ["flaky", "audit.flaky", {}],
  ["keeper", "audit.ok", {}],
];
for (const [key, type, opts] of seed) {
  const rec = await qw.rawEnqueue(type, JSON.stringify({ hello: "world", marker: key }), opts);
  ids[key] = rec.id;
}
const schedA = await qw.rawEnqueue("audit.ok", "{}", { delayMs: 3_600_000 });
const schedBId = (await qw.rawEnqueue("audit.ok", "{}", { delayMs: 3_600_000 })).id;
const evilPayload = '<script>alert(1)</script><img src=x onerror=alert(1)>';
const xss = await qw.rawEnqueue("audit.ok", JSON.stringify({ p: evilPayload }));

const worker = qw.createWorker();
worker.start();

const assetsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "dashboard-assets");
const srv = new DashboardServer(qw, assetsDir, { port: 7799 });
await srv.start();
console.log("server up:", srv.address);

// ---- Phase 1: while slowA/slowB are running -------------------------------
await sleep(700);
await step("stats: running=2, queued=5, scheduled=2; all 8 state keys", async () => {
  const st = (await get("/api/stats")).json();
  A(st.states.running === 2, "running=" + st.states.running);
  A(st.states.queued === 5, "queued=" + st.states.queued);
  A(st.states.scheduled === 2, "scheduled=" + st.states.scheduled);
  for (const k of ["queued", "scheduled", "running", "succeeded", "retrying", "failed", "dead", "cancelled"])
    A(k in st.states, "state key missing: " + k);
});

await step("cancel endpoint -> 200, state cancelled", async () => {
  const r = await fetch(BASE + "/api/jobs/" + encodeURIComponent(schedA.id) + "/cancel", { method: "POST" });
  A(r.status === 200, "status " + r.status);
  A((await r.json()).job.state === "cancelled", "state not cancelled");
});

await step("jobs list: newest-first, cursor pagination", async () => {
  const p1 = (await get("/api/jobs?limit=3")).json();
  A(p1.jobs.length === 3, "page1 len");
  A(typeof p1.cursor === "string" && p1.cursor.length > 0, "no cursor");
  A(p1.jobs[0].createdAt >= p1.jobs[1].createdAt, "not created_desc");
  const p2 = (await get("/api/jobs?limit=3&cursor=" + encodeURIComponent(p1.cursor))).json();
  A(p2.jobs[0].id !== p1.jobs[0].id, "cursor page overlaps");
});

await step("jobs filter states= / search=", async () => {
  const f = (await get("/api/jobs?states=scheduled")).json();
  A(f.jobs.length === 1 && f.jobs[0].state === "scheduled" && f.jobs[0].id === schedBId, "states=scheduled len=" + f.jobs.length);
  const c = (await get("/api/jobs?states=cancelled")).json();
  A(c.jobs.length === 1 && c.jobs[0].id === schedA.id, "states=cancelled");
  const s = (await get("/api/jobs?search=audit.flaky")).json();
  A(s.jobs.length === 1 && s.jobs[0].type === "audit.flaky", "search filter");
});

await step("job detail: attempt history + stack fields", async () => {
  for (let i = 0; i < 80; i++) {
    const j = (await get("/api/jobs/" + encodeURIComponent(ids.flaky))).json().job;
    if ((j.attemptsHistory ?? []).length >= 1) {
      const h = j.attemptsHistory[0];
      A(h.outcome === "failed", "outcome " + h.outcome);
      A(h.errorName === "Error" && /upstream timeout/.test(h.errorMessage), "error fields");
      A(typeof h.stack === "string" && h.stack.length > 0, "stack");
      A(j.retry.baseDelayMs === 1200, "retry policy echoed");
      return;
    }
    await sleep(100);
  }
  A(false, "flaky never recorded attempt 1");
});

await step("404 shape: {error, fix}", async () => {
  const r = await get("/api/jobs/j_nope123");
  A(r.status === 404, "status " + r.status);
  const b = r.json();
  A(/not found/.test(b.error) && typeof b.fix === "string", "body " + r.text);
});

await step("route regex rejects html-ish job id (404 no route)", async () => {
  const r = await get("/api/jobs/<img>");
  A(r.status === 404, "status " + r.status);
  A(/no route/.test(r.json().error), "unexpected body " + r.text);
});

await step("malformed percent-encoding -> 500 (robustness note)", async () => {
  const r = await get("/api/jobs/%zz");
  A(r.status === 500, "status " + r.status + " (expected 500 to document finding)");
});

await step("XSS payload round-trips verbatim in JSON", async () => {
  const j = (await get("/api/jobs/" + encodeURIComponent(xss.id))).json().job;
  A(JSON.parse(j.payload).p === evilPayload, "payload mutated server-side");
});

await step("timeseries: 60 buckets, honest keys, missing flags, no averages", async () => {
  const r = await get("/api/timeseries?windowMs=900000&buckets=60");
  A(r.status === 200, "status");
  const pts = r.json().points;
  A(pts.length === 60, "len " + pts.length);
  const want = ["bucketStart", "durationsP50", "durationsP95", "durationsP99", "failed", "missing", "succeeded"].sort().join(",");
  for (const p of pts) A(Object.keys(p).sort().join(",") === want, "keys " + Object.keys(p).sort().join(","));
  A(pts.every((p: any) => !p.missing || (p.durationsP50 === null && p.durationsP95 === null && p.durationsP99 === null)), "missing bucket carries percentiles");
  A(pts[1].bucketStart - pts[0].bucketStart === 15000, "bucket size wrong");
  A(!/avg|average|"mean"/i.test(r.text), "average-like field in timeseries body");
});

await step("metrics + healthz", async () => {
  const m = await get("/metrics");
  A(m.status === 200 && /qw_jobs_state/.test(m.text), "metrics body");
  const h = (await get("/healthz")).json();
  A(h.status === "ok" && h.storage === "ok", "healthz " + m.text);
});

await step("static assets served, SPA fallback, content-types", async () => {
  const idx = await get("/");
  A(idx.status === 200 && /text\/html/.test(idx.ct), "index ct " + idx.ct);
  A(/id="last-refreshed"/.test(idx.text) && /data-theme/.test(idx.text), "index content");
  const css = await get("/styles.css");
  A(css.status === 200 && /text\/css/.test(css.ct), "css ct " + css.ct);
  const js = await get("/app.js");
  A(js.status === 200 && /javascript/.test(js.ct), "js ct " + js.ct);
  const fb = await get("/some/spa/route");
  A(fb.status === 200 && /text\/html/.test(fb.ct), "fallback ct " + fb.ct);
});

// ---- Phase 2: after slows finish ------------------------------------------
await sleep(6000);
await step("phase2: succeeded/failed/retrying/cancelled visible", async () => {
  const st = (await get("/api/stats")).json();
  A(st.states.succeeded >= 4, "succeeded=" + st.states.succeeded);
  A(st.states.failed === 1, "failed=" + st.states.failed);
  A(st.states.retrying + st.states.dead >= 1, "flaky not progressing");
  A(st.states.cancelled === 1, "cancelled=" + st.states.cancelled);
});

await step("phase3: flaky exhausts to dead with 3 attempts", async () => {
  let j: any = null;
  for (let i = 0; i < 200; i++) {
    j = (await get("/api/jobs/" + encodeURIComponent(ids.flaky))).json().job;
    if (j.state === "dead") break;
    await sleep(150);
  }
  A(j && j.state === "dead", "state " + (j && j.state));
  A(j.attemptsHistory.length === 3, "attempts " + j.attemptsHistory.length);
});

await step("retry endpoint on succeeded -> 200 queued", async () => {
  const r = await fetch(BASE + "/api/jobs/" + encodeURIComponent(ids.keeper) + "/retry", { method: "POST" });
  A(r.status === 200, "status " + r.status);
  A((await r.json()).job.state === "queued", "not queued after retry");
});

await step("cancel endpoint on terminal -> 409 with fix", async () => {
  const r = await fetch(BASE + "/api/jobs/" + encodeURIComponent(ids.fatal) + "/cancel", { method: "POST" });
  A(r.status === 409, "status " + r.status);
  const b = await r.json();
  A(typeof b.fix === "string" && /queued\/scheduled\/retrying/.test(b.fix), "fix missing: " + JSON.stringify(b));
});

await step("events endpoint", async () => {
  const b = (await get("/api/jobs/" + encodeURIComponent(ids.ok) + "/events")).json();
  A(Array.isArray(b.events) && b.events.length > 0, "no events");
});

await step("pause-all / resume-all endpoints", async () => {
  const p = await fetch(BASE + "/api/pause-all", { method: "POST" });
  A(p.status === 200 && (await p.json()).ok === true, "pause-all");
  A((await get("/api/stats")).json().globalPaused === true, "globalPaused flag");
  const r = await fetch(BASE + "/api/resume-all", { method: "POST" });
  A(r.status === 200, "resume-all");
});

await worker.stop();
await srv.stop();
await qw.close();

const failed = results.filter((r) => !r.ok);
console.log(`\nprobe: ${results.length - failed.length}/${results.length} passed`);
process.exitCode = failed.length ? 1 : 0;
