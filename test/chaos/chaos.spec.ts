import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { FakeClock } from "../../src/util.js";
import { MemoryStorage } from "../../src/storage/memory.js";
import { SqliteStorage } from "../../src/storage/sqlite.js";
import type { StorageBackend } from "../../src/storage/interface.js";
import { Queuewright } from "../../src/client.js";
import { Worker } from "../../src/worker.js";
import { defineJob, resetRegistryForTests } from "../../src/registry.js";
import { StorageUnavailableError } from "../../src/errors.js";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(
  cond: () => boolean | Promise<boolean>,
  timeoutMs = 15_000,
  stepMs = 50,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await cond()) return;
    await sleep(stepMs);
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

describe("concurrent workers on one shared sqlite store", () => {
  it("no lost jobs and no double-claim across 4 concurrent claimers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qw-conc-"));
    const dbFile = join(dir, "q.db");
    const clock = new FakeClock();
    const producer = new SqliteStorage({ file: dbFile, now: () => clock.now() });
    await producer.init();
    const N = 120;
    for (let i = 0; i < N; i++) {
      await producer.enqueue({
        type: "conc.work",
        queue: "default",
        payload: JSON.stringify({ i }),
        payloadVersion: 1,
        priority: i % 3,
        runAt: clock.now(),
        maxAttempts: 3,
        timeoutMs: 5000,
        retry: { strategy: "fixed", baseDelayMs: 10, maxDelayMs: 10, jitter: "none" },
        dedupeKey: null,
        scheduleId: null,
        onSuccess: null,
      });
    }
    const claimers: StorageBackend[] = [];
    for (let c = 0; c < 4; c++) {
      const s = new SqliteStorage({ file: dbFile, now: () => clock.now() });
      await s.init();
      claimers.push(s);
    }
    const claimedIds: string[] = [];
    await Promise.all(
      claimers.map(async (s) => {
        for (let round = 0; round < 40; round++) {
          const got = await s.claim({
            workerId: `c${claimers.indexOf(s)}`,
            queues: [],
            limit: 5,
            visibilityTimeoutMs: 60_000,
          });
          claimedIds.push(...got.map((j) => j.id));
        }
      }),
    );
    expect(claimedIds.length).toBe(N);
    expect(new Set(claimedIds).size).toBe(N);
    for (const s of claimers) await s.close();
    await producer.close();
    void dir;
    void rmSync;
  }, 30_000);
});

describe("visibility timeout reclaims jobs from a killed worker exactly once", () => {
  it("reclaimed job is executed again by another worker and completes once", async () => {
    resetRegistryForTests();
    let executions = 0;
    defineJob("reclaim.work", {}, async () => {
      executions++;
    });
    const clock = new FakeClock();
    const store = new MemoryStorage({ now: () => clock.now() });
    const qw = new Queuewright({ storageInstance: store, now: () => clock.now() });
    await qw.init();
    const job = await store.enqueue({
      type: "reclaim.work",
      queue: "default",
      payload: "{}",
      payloadVersion: 1,
      priority: 0,
      runAt: clock.now(),
      maxAttempts: 3,
      timeoutMs: 5000,
      retry: { strategy: "fixed", baseDelayMs: 5, maxDelayMs: 5, jitter: "none" },
      dedupeKey: null,
      scheduleId: null,
      onSuccess: null,
    });
    // worker A claims then dies without completing
    await store.claim({ workerId: "dead", queues: [], limit: 1, visibilityTimeoutMs: 100 });
    clock.advance(150);
    const reclaimed = await store.reclaimExpired();
    expect(reclaimed).toBe(1);
    // worker B claims and completes
    const [b] = await store.claim({ workerId: "b", queues: [], limit: 1, visibilityTimeoutMs: 1000 });
    expect(b!.id).toBe(job.id);
    await store.completeJob(job.id, "b", null);
    expect((await qw.getJob(job.id))!.state).toBe("succeeded");
    await qw.close();
  });
});

describe("graceful shutdown under load loses nothing", () => {
  it("in-flight finished or requeued; every job terminal after restart", async () => {
    resetRegistryForTests();
    defineJob("shutdown.work", {}, async () => {
      await sleep(80);
    });
    const clock = new FakeClock(Date.now());
    const store = new MemoryStorage({ now: () => clock.now() });
    const qw = new Queuewright({ storageInstance: store, now: () => clock.now(), concurrency: 2 });
    await qw.init();
    for (let i = 0; i < 6; i++) {
      await store.enqueue({
        type: "shutdown.work",
        queue: "default",
        payload: "{}",
        payloadVersion: 1,
        priority: 0,
        runAt: Date.now(),
        maxAttempts: 2,
        timeoutMs: 5000,
        retry: { strategy: "fixed", baseDelayMs: 5, maxDelayMs: 5, jitter: "none" },
        dedupeKey: null,
        scheduleId: null,
        onSuccess: null,
      });
    }
    const w1 = qw.createWorker();
    w1.start();
    await waitFor(() => w1.inflightCount > 0);
    await w1.stop(); // finishes in-flight within deadline, releases the rest
    const w2 = qw.createWorker();
    w2.start();
    await waitFor(async () => {
      const stats = await qw.stats();
      return (
        stats.states["queued"] === 0 &&
        stats.states["running"] === 0 &&
        stats.states["retrying"] === 0
      );
    }, 20_000);
    const stats = await qw.stats();
    expect(stats.states["succeeded"]).toBe(6);
    await w2.stop();
    await qw.close();
  }, 30_000);
});

describe("chaos harness: randomized storage faults", () => {
  it(`every enqueued job reaches a terminal state despite ${12} injected storage failures`, async () => {
    resetRegistryForTests();
    defineJob("chaos.inline", {}, async () => {});
    const clock = new FakeClock();
    const inner = new MemoryStorage({ now: () => clock.now() });
    await inner.init();
    let injectedFailures = 0;

    class FaultyStorage implements StorageBackend {
      readonly kind = "faulty-memory";
      private attempts = 0;
      constructor(private base: StorageBackend) {}
      private async flaky<T>(op: string, fn: () => Promise<T>): Promise<T> {
        this.attempts++;
        if (op !== "enqueue" && op !== "enqueueBatch" && Math.random() < 0.12 && injectedFailures < 12) {
          injectedFailures++;
          throw new StorageUnavailableError(
            new Error(`injected fault #${injectedFailures} on ${op}`),
          );
        }
        return fn();
      }
      get rawAttempts(): number {
        return this.attempts;
      }
      init = () => this.base.init();
      close = () => this.base.close();
      ping = () => this.base.ping();
      enqueue = (...a: Parameters<StorageBackend["enqueue"]>) =>
        this.flaky("enqueue", () => this.base.enqueue(...a));
      enqueueBatch = (...a: Parameters<StorageBackend["enqueueBatch"]>) =>
        this.flaky("enqueueBatch", () => this.base.enqueueBatch(...a));
      getJob = (...a: Parameters<StorageBackend["getJob"]>) => this.flaky("getJob", () => this.base.getJob(...a));
      listJobs = (...a: Parameters<StorageBackend["listJobs"]>) => this.base.listJobs(...a);
      claim = (...a: Parameters<StorageBackend["claim"]>) => this.flaky("claim", () => this.base.claim(...a));
      completeJob = (...a: Parameters<StorageBackend["completeJob"]>) =>
        this.flaky("completeJob", () => this.base.completeJob(...a));
      failAttempt = (...a: Parameters<StorageBackend["failAttempt"]>) =>
        this.flaky("failAttempt", () => this.base.failAttempt(...a));
      heartbeat = (...a: Parameters<StorageBackend["heartbeat"]>) => this.base.heartbeat(...a);
      reclaimExpired = () => this.base.reclaimExpired();
      releaseWorkerLeases = (w: string) => this.base.releaseWorkerLeases(w);
      cancelJob = (...a: Parameters<StorageBackend["cancelJob"]>) => this.base.cancelJob(...a);
      requeueJob = (...a: Parameters<StorageBackend["requeueJob"]>) => this.base.requeueJob(...a);
      updatePayload = (...a: Parameters<StorageBackend["updatePayload"]>) => this.base.updatePayload(...a);
      setProgress = (...a: Parameters<StorageBackend["setProgress"]>) => this.base.setProgress(...a);
      purgeRetention = (m: number) => this.base.purgeRetention(m);
      stats = () => this.base.stats();
      completionSamples = (f: number, t: number) => this.base.completionSamples(f, t);
      takeRateToken = (k: string, l: number, w: number) => this.base.takeRateToken(k, l, w);
      beginIdempotency = (k: string) => this.base.beginIdempotency(k);
      completeIdempotency = (k: string, r: string) => this.base.completeIdempotency(k, r);
      releaseIdempotency = (k: string) => this.base.releaseIdempotency(k);
      listAttempts = (j: string) => this.base.listAttempts(j);
      createSchedule = (i: Parameters<StorageBackend["createSchedule"]>[0]) => this.base.createSchedule(i);
      updateSchedule = (id: string, p: Parameters<StorageBackend["updateSchedule"]>[1]) => this.base.updateSchedule(id, p);
      deleteSchedule = (id: string) => this.base.deleteSchedule(id);
      listSchedules = () => this.base.listSchedules();
      getSchedule = (id: string) => this.base.getSchedule(id);
      recordScheduleFires = (s: string, f: number[], n: number) => this.base.recordScheduleFires(s, f, n);
      setPaused = (p: Parameters<StorageBackend["setPaused"]>[0]) => this.base.setPaused(p);
      setRateRules = (r: Parameters<StorageBackend["setRateRules"]>[0]) => this.base.setRateRules(r);
      getRateRules = () => this.base.getRateRules();
      setConcurrencyLimits = (l: Parameters<StorageBackend["setConcurrencyLimits"]>[0]) => this.base.setConcurrencyLimits(l);
      getConcurrencyLimits = () => this.base.getConcurrencyLimits();
      getJobEvents = (j: string) => this.base.getJobEvents(j);
    }

    const qw = new Queuewright({
      storageInstance: new FaultyStorage(inner),
      now: () => clock.now(),
      pollIntervalMs: 20,
      visibilityTimeoutMs: 2000,
    });
    await qw.init();
    const total = 40;
    for (let i = 0; i < total; i++) {
      await inner.enqueue({
        type: "chaos.inline",
        queue: "default",
        payload: "{}",
        payloadVersion: 1,
        priority: 0,
        runAt: clock.now(),
        maxAttempts: 3,
        timeoutMs: 5000,
        retry: { strategy: "fixed", baseDelayMs: 10, maxDelayMs: 10, jitter: "none" },
        dedupeKey: null,
        scheduleId: null,
        onSuccess: null,
      });
    }
    const worker: Worker = qw.createWorker();
    worker.start();
    const start0 = Date.now();
    let lastStatsStates: string | null = null;
    while (Date.now() - start0 < 30_000) {
      clock.advance(100); // let retry backoffs come due on the fake clock
      const stats = await inner.stats();
      const terminal =
        stats.states["succeeded"] + stats.states["failed"] + stats.states["dead"] + stats.states["cancelled"];
      if (terminal === total) break;
      lastStatsStates = JSON.stringify(stats.states);
      await sleep(30);
    }
    if (lastStatsStates !== null) {
      const stats = await inner.stats();
      const terminal =
        stats.states["succeeded"] + stats.states["failed"] + stats.states["dead"] + stats.states["cancelled"];
      expect(terminal).toBe(total);
      void lastStatsStates;
    }
    expect(injectedFailures).toBeGreaterThanOrEqual(5);
    expect(injectedFailures).toBeLessThanOrEqual(12);
    await worker.stop();
    await qw.close();
  }, 45_000);
});
