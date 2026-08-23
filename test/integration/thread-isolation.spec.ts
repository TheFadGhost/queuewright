import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryStorage } from "../../src/storage/memory.js";
import { Queuewright } from "../../src/client.js";
import { Worker } from "../../src/worker.js";
import { defineJob, resetRegistryForTests } from "../../src/registry.js";

let qw: Queuewright;
let worker: Worker;

beforeEach(() => {
  resetRegistryForTests();
  qw = new Queuewright({ storageInstance: new MemoryStorage(), pollIntervalMs: 10 });
});

afterEach(async () => {
  if (worker) await worker.stop();
  await qw.close();
});

describe("thread-isolated execution", () => {
  it("terminates a CPU-spinning handler at its timeout instead of letting it run on", async () => {
    const spinModule = resolve("test/fixtures/cpu-handler.ts");
    defineJob<{ ms: number }>(
      "cpu.spin",
      {
        timeoutMs: 250,
        execution: { thread: { module: spinModule, export: "spin" } },
        retry: { strategy: "fixed", baseDelayMs: 50 },
      },
      async () => {}, // inline handler is NOT used in thread mode
    );
    let afterRan = false;
    const after = defineJob("cpu.after", async () => {
      afterRan = true;
    });
    await qw.init();
    await qw.rawEnqueue("cpu.spin", "30000", {});
    await qw.enqueue(after, {});
    const t0 = Date.now();
    worker = qw.createWorker();
    worker.start();

    const start = Date.now();
    while (Date.now() - start < 15_000 && !afterRan) {
      await new Promise((r) => setTimeout(r, 25));
    }
    const elapsed = Date.now() - t0;
    expect(afterRan).toBe(true);
    expect(elapsed).toBeLessThan(8_000);

    // The spinning job must have been recorded as a timeout attempt.
    const start2 = Date.now();
    let spinJob: Awaited<ReturnType<Queuewright["getJob"]>> = null;
    while (Date.now() - start2 < 5_000) {
      const page = await qw.listJobs({ states: ["retrying", "dead"], limit: 10, cursor: null, order: "created_desc" });
      spinJob = page.jobs.find((j) => j.type === "cpu.spin") ?? null;
      if (spinJob) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(spinJob).toBeDefined();
    expect(spinJob!.attemptsHistory[0]!.outcome).toBe("timeout");
  }, 20_000);

  it("completes normally when the thread handler finishes in time", async () => {
    const mod = resolve("test/fixtures/cpu-handler.ts");
    const job = defineJob<{ n: number }>(
      "cpu.fast",
      { execution: { thread: { module: mod, export: "fastDouble" } } },
      async () => {},
    );
    await qw.init();
    const rec = await qw.enqueue(job, { n: 21 });
    worker = qw.createWorker();
    worker.start();
    const start = Date.now();
    while (Date.now() - start < 10_000) {
      const j = await qw.getJob(rec.id);
      if (j?.state === "succeeded") break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect((await qw.getJob(rec.id))!.state).toBe("succeeded");
  }, 15_000);
});

void mkdtempSync;
void tmpdir;
void join;
