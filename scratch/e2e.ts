import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStorage } from "../src/storage/sqlite.js";
import { Queuewright } from "../src/client.js";
import { DashboardServer } from "../src/server.js";
import { defineJob, resetRegistryForTests } from "../src/registry.js";

resetRegistryForTests();
let attempts = 0;
defineJob<{ n: number }>("e2e.work", {}, async (p) => {
  attempts++;
  if (p.n === 3 && attempts < 3) throw new Error("transient e2e failure");
});
defineJob("e2e.dead", { maxAttempts: 1 }, async () => {
  throw new Error("always fails");
});

const dir = mkdtempSync(join(tmpdir(), "qw-e2e-"));
const qw = new Queuewright({ storageInstance: new SqliteStorage({ file: join(dir, "q.db") }) });
await qw.init();
await qw.applyStartupRules({
  rateRules: [{ key: "queue:default", limit: 1000, windowMs: 1000 }],
});
for (let i = 0; i < 5; i++) {
  await qw.rawEnqueue("e2e.work", JSON.stringify({ n: i }), {});
}
await qw.rawEnqueue("e2e.dead", "{}", {});

const worker = qw.createWorker();
worker.start();
const dashboard = new DashboardServer(qw, join(process.cwd(), "dashboard-assets"), { port: 7799, host: "127.0.0.1" });
await dashboard.start();
console.log("dashboard:", dashboard.address);

async function get(pathname: string): Promise<{ status: number; body: string }> {
  const res = await fetch(`http://127.0.0.1:7799${pathname}`);
  return { status: res.status, body: await res.text() };
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// let the worker drain everything including the dead letter
let stats = JSON.parse((await get("/api/stats")).body) as { states: Record<string, number> };
const deadline = Date.now() + 30_000;
while (Date.now() < deadline) {
  stats = JSON.parse((await get("/api/stats")).body);
  if ((stats.states["succeeded"] ?? 0) >= 5 && (stats.states["dead"] ?? 0) >= 1) break;
  await wait(200);
}
console.log("states:", JSON.stringify(stats.states));
if (stats.states["succeeded"] !== 5 || stats.states["dead"] !== 1) {
  console.error("FAIL: expected 5 succeeded and 1 dead");
  process.exit(1);
}

const jobs = JSON.parse((await get("/api/jobs?states=dead")).body) as { jobs: Array<{ id: string; type: string }> };
if (jobs.jobs.length !== 1 || jobs.jobs[0]!.type !== "e2e.dead") {
  console.error("FAIL: dead-letter listing wrong");
  process.exit(1);
}
const deadId = jobs.jobs[0]!.id;
const detail = await get(`/api/jobs/${deadId}`);
if (detail.status !== 200) {
  console.error("FAIL: detail fetch");
  process.exit(1);
}
const events = await get(`/api/jobs/${deadId}/events`);
if (events.status !== 200) {
  console.error("FAIL: events fetch");
  process.exit(1);
}
const retried = await fetch(`http://127.0.0.1:7799/api/jobs/${deadId}/requeue`, { method: "POST" });
if (retried.status !== 200) {
  console.error("FAIL: requeue of dead letter failed", retried.status, await retried.text());
  process.exit(1);
}
const cancelRaced = await fetch(`http://127.0.0.1:7799/api/jobs/${deadId}/cancel`, { method: "POST" });
const finalState = JSON.parse((await get(`/api/jobs/${deadId}`)).body) as { job: { state: string } };
if (!["queued", "running", "retrying", "succeeded", "cancelled"].includes(finalState.job.state)) {
  console.error("FAIL: unexpected post-requeue state", finalState.job.state);
  process.exit(1);
}
void cancelRaced;

const ts = JSON.parse((await get("/api/timeseries?windowMs=3600000&buckets=60")).body) as {
  points: Array<{ missing: boolean }>;
};
if (ts.points.length !== 60) {
  console.error("FAIL: timeseries bucket count");
  process.exit(1);
}
const health = JSON.parse((await get("/healthz")).body) as { status: string; storage: string };
if (health.status !== "ok" || health.storage !== "ok") {
  console.error("FAIL: healthz", health);
  process.exit(1);
}
const metrics = await get("/metrics");
if (metrics.status !== 200 || !metrics.body.includes("qw_jobs_state{state=\"succeeded\"}")) {
  console.error("FAIL: metrics output missing gauges");
  process.exit(1);
}
const pauseRes = await fetch("http://127.0.0.1:7799/api/pause-all", { method: "POST" });
const statsAfterPause = JSON.parse((await get("/api/stats")).body) as { globalPaused: boolean };
if (!pauseRes.ok || statsAfterPause.globalPaused !== true) {
  console.error("FAIL: global pause via API");
  process.exit(1);
}
await fetch("http://127.0.0.1:7799/api/resume-all", { method: "POST" });

const indexPage = await get("/");
if (indexPage.status !== 200 || !indexPage.body.includes("<!DOCTYPE html")) {
  console.error("FAIL: dashboard index not served");
  process.exit(1);
}

console.log("E2E PASS: api, metrics, health, static assets, dead-letter requeue all verified");
await worker.stop();
await dashboard.stop();
await qw.close();
process.exit(0);
