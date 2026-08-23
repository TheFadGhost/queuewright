import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStorage } from "../src/storage/sqlite.js";
import { MemoryStorage } from "../src/storage/memory.js";
import { Queuewright } from "../src/client.js";
import { defineJob, resetRegistryForTests } from "../src/registry.js";

const PAYLOAD_BYTES = Number(process.argv[2] ?? 512);
const JOBS = Number(process.argv[3] ?? 2000);
const CONCURRENCY = Number(process.argv[4] ?? 4);
const BACKEND = process.argv[5] ?? "sqlite";

resetRegistryForTests();
defineJob("bench.work", {}, async () => {});

const payload = JSON.stringify({ blob: "x".repeat(Math.max(0, PAYLOAD_BYTES - 12)) });
const dir = mkdtempSync(join(tmpdir(), `qw-bench-${BACKEND}-`));
const storage =
  BACKEND === "sqlite"
    ? new SqliteStorage({ file: join(dir, "bench.db") })
    : new MemoryStorage();
const qw = new Queuewright({ storageInstance: storage, concurrency: CONCURRENCY, pollIntervalMs: 5, log: { level: "error" } });
await qw.init();

const enqueueStart = performance.now();
for (let i = 0; i < JOBS; i += 100) {
  for (let j = i; j < Math.min(i + 100, JOBS); j++) {
    await qw.rawEnqueue("bench.work", payload, {});
  }
}
const enqueueMs = performance.now() - enqueueStart;

const worker = qw.createWorker();
worker.start();
const drainStart = performance.now();
const deadline = drainStart + 120_000;
while (performance.now() < deadline) {
  const stats = await qw.stats();
  if (stats.states["succeeded"] >= JOBS) break;
  await new Promise((r) => setTimeout(r, 25));
}
const drainMs = performance.now() - drainStart;
await worker.stop();

const page = await qw.listJobs({ states: ["succeeded"], limit: 500, cursor: null, order: "created_desc" });
const durations = page.jobs
  .flatMap((j) => j.attemptsHistory.map((a) => a.durationMs ?? 0))
  .sort((a, b) => a - b);
const pct = (q: number): number => durations[Math.min(durations.length - 1, Math.ceil(q * durations.length) - 1)] ?? 0;

const result = {
  backend: BACKEND,
  jobs: JOBS,
  payloadBytes: Buffer.byteLength(payload),
  concurrency: CONCURRENCY,
  enqueueJobsPerSec: Math.round((JOBS / enqueueMs) * 1000),
  processedJobsPerSec: Math.round((JOBS / drainMs) * 1000),
  executionLatencyP50Ms: pct(0.5),
  executionLatencyP95Ms: pct(0.95),
  executionLatencyP99Ms: pct(0.99),
};
console.log(JSON.stringify(result, null, 2));

await qw.close();
rmSync(dir, { recursive: true, force: true });
process.exit(0);
