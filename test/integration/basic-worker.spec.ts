import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryStorage } from "../../src/storage/memory.js";
import { Queuewright } from "../../src/client.js";
import { Worker } from "../../src/worker.js";
import { defineJob, resetRegistryForTests } from "../../src/registry.js";
import { FatalJobError, DuplicateJobError, UnregisteredJobTypeError } from "../../src/errors.js";

let qw: Queuewright;
let worker: Worker;

beforeEach(() => {
  resetRegistryForTests();
  qw = new Queuewright({
    storageInstance: new MemoryStorage(),
    concurrency: 2,
    pollIntervalMs: 10,
    visibilityTimeoutMs: 1000,
  });
});

afterEach(async () => {
  if (worker) await worker.stop();
  await qw.close();
});

describe("end-to-end execution", () => {
  it("runs a defined job and records success", async () => {
    const ran: string[] = [];
    const greet = defineJob<{ name: string }>("test.greet", async (p) => {
      ran.push(p.name);
    });
    await qw.init();
    await qw.enqueue(greet, { name: "ada" });
    worker = qw.createWorker();
    worker.start();
    await waitFor(() => ran.length === 1);
    expect(ran).toEqual(["ada"]);
    await waitFor(async () => (await qw.storage.getJob((await firstJobId())) ?? null) === null ? false : true);
    const job = await qw.getJob(await firstJobId());
    expect(job!.state).toBe("succeeded");
  });

  it("retries failures with backoff until success", async () => {
    let attempts = 0;
    const flaky = defineJob<{ ok: boolean }>("test.flaky", {
      retry: { strategy: "fixed", baseDelayMs: 20 },
      maxAttempts: 3,
    }, async () => {
      attempts++;
      if (attempts < 3) throw new Error("flaky upstream");
    });
    await qw.init();
    const job = await qw.enqueue(flaky, { ok: false });
    worker = qw.createWorker();
    worker.start();
    await waitFor(async () => (await qw.getJob(job.id))!.state === "succeeded", 3000);
    expect(attempts).toBe(3);
    const done = await qw.getJob(job.id);
    expect(done!.attemptsHistory.map((a) => a.outcome)).toEqual(["failed", "failed", "succeeded"]);
    expect(done!.attemptsHistory[0]!.stack).toContain("Error: flaky upstream");
  });

  it("sends fatal errors to failed without retries and normal exhaustion to dead", async () => {
    const fatal = defineJob("test.fatal", { maxAttempts: 5 }, async () => {
      throw new FatalJobError("bad region");
    });
    const exhaust = defineJob("test.exhaust", { maxAttempts: 2, retry: { strategy: "fixed", baseDelayMs: 10 } }, async () => {
      throw new Error("nope");
    });
    await qw.init();
    const f = await qw.enqueue(fatal, {});
    const e = await qw.enqueue(exhaust, {});
    worker = qw.createWorker();
    worker.start();
    await waitFor(async () => (await qw.getJob(f.id))!.state === "failed", 2000);
    expect((await qw.getJob(f.id))!.attempts).toBe(1);
    await waitFor(async () => (await qw.getJob(e.id))!.state === "dead", 4000);
    expect((await qw.getJob(e.id))!.attempts).toBe(2);
  });

  it("interrupts a hung async handler at its timeout while the worker keeps going", async () => {
    let hungStarted = false;
    let secondRan = false;
    defineJob("test.hang", { timeoutMs: 120 }, () => {
      hungStarted = true;
      return new Promise<void>(() => {});
    });
    const quick = defineJob("test.quick", async () => {
      secondRan = true;
    });
    await qw.init();
    await qw.rawEnqueue("test.hang", "{}");
    worker = qw.createWorker();
    worker.start();
    await waitFor(() => hungStarted);
    await qw.enqueue(quick, {});
    await waitFor(() => secondRan, 3000);
    await waitFor(async () => {
      const j = await qw.listJobs({ states: ["retrying"], limit: 10, cursor: null, order: "created_desc" });
      return j.jobs.some((x) => x.type === "test.hang");
    }, 3000);
    const jobsPage = await qw.listJobs({ states: ["retrying", "queued"], limit: 10, cursor: null, order: "created_desc" });
    const hang = jobsPage.jobs.find((j) => j.type === "test.hang");
    expect(hang).toBeDefined();
    expect(hang!.attemptsHistory[0]!.outcome).toBe("timeout");
  });

  it("graceful shutdown finishes in-flight work and requeues the rest without loss", async () => {
    const finished: number[] = [];
    let startedCount = 0;
    const slow = defineJob<{ n: number }>("test.slow", {
      queue: "default",
      timeoutMs: 30_000,
    }, async (p) => {
      startedCount++;
      await sleep(150);
      finished.push(p.n);
    });
    await qw.init();
    for (const n of [1, 2]) await qw.enqueue(slow, { n });
    worker = qw.createWorker();
    worker.start();
    await waitFor(() => startedCount >= 1);
    await worker.stop();
    expect(finished.length).toBeGreaterThanOrEqual(1);
    const page = await qw.listJobs({ states: ["queued"], limit: 10, cursor: null, order: "created_desc" });
    expect(page.jobs.length + finished.length).toBe(2);
  });

  it("collapses concurrent duplicate enqueues onto one active job", async () => {
    const work = defineJob<{ k: string }>("test.dedupe", {}, async () => {});
    await qw.init();
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        qw.enqueue(work, { k: "x" }, { dedupeKey: "only-one" }),
      ),
    );
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    rejected.forEach((r) => expect((r as PromiseRejectedResult).reason).toBeInstanceOf(DuplicateJobError));
  });

  it("gives an actionable error for unregistered types on raw enqueue", async () => {
    await qw.init();
    await expect(qw.rawEnqueue("missing.thing", "{}")).rejects.toBeInstanceOf(UnregisteredJobTypeError);
  });

  it("rejects oversized payloads with a clear error", async () => {
    const big = defineJob<{ blob: string }>("test.big", {}, async () => {});
    await qw.init();
    const huge = { blob: "x".repeat(300 * 1024) };
    await expect(qw.enqueue(big, huge)).rejects.toThrow(/exceeding the maximum/);
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function firstJobId(): Promise<string> {
  const page = await qw.listJobs({ states: ["queued", "running", "succeeded"], limit: 1, cursor: null, order: "created_desc" });
  return page.jobs[0]!.id;
}

export async function waitFor(
  cond: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await cond()) return;
    await sleep(15);
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}
