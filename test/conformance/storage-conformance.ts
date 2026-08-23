import { describe, expect, it } from "vitest";
import { FakeClock } from "../../src/util.js";
import type { StorageBackend } from "../../src/storage/interface.js";
import type { EnqueueInput } from "../../src/types.js";

export function input(overrides: Partial<EnqueueInput> = {}): EnqueueInput {
  return {
    type: "test.work",
    queue: "default",
    payload: "{}",
    payloadVersion: 1,
    priority: 0,
    runAt: 0,
    maxAttempts: 3,
    timeoutMs: 30_000,
    retry: { strategy: "exponential", baseDelayMs: 1000, maxDelayMs: 60_000, jitter: "none" },
    dedupeKey: null,
    scheduleId: null,
    onSuccess: null,
    ...overrides,
  };
}

export function runConformanceSuite(makeBackend: (clock: FakeClock) => Promise<StorageBackend>): void {
  let clock: FakeClock;
  let store: StorageBackend;

  async function fresh(): Promise<void> {
    clock = new FakeClock();
    store = await makeBackend(clock);
    await store.init();
  }

  async function close(): Promise<void> {
    await store.close();
  }

  describe("enqueue and read", () => {
    it("round-trips a job record", async () => {
      await fresh();
      const job = await store.enqueue(input({ priority: 3 }));
      expect(job.state).toBe("queued");
      expect(job.attempts).toBe(0);
      const got = await store.getJob(job.id);
      expect(got?.priority).toBe(3);
      expect(got?.events.map((e) => e.event)).toContain("enqueued");
      await close();
    });

    it("delayed enqueue lands in scheduled state", async () => {
      await fresh();
      const job = await store.enqueue(input({ runAt: clock.now() + 60_000 }));
      expect(job.state).toBe("scheduled");
      await close();
    });

    it("rejects duplicate dedupe keys while active and releases them when terminal", async () => {
      await fresh();
      const a = await store.enqueue(input({ dedupeKey: "k1" }));
      await expect(store.enqueue(input({ dedupeKey: "k1" }))).rejects.toThrow(/dedupeKey "k1"/);
      const [claimed] = await store.claim({ workerId: "w", queues: ["default"], limit: 5, visibilityTimeoutMs: 5000 });
      expect(claimed!.id).toBe(a.id);
      await store.completeJob(a.id, "w", null);
      const again = await store.enqueue(input({ dedupeKey: "k1" }));
      expect(again.id).not.toBe(a.id);
      await close();
    });
  });

  describe("claiming", () => {
    it("claims in priority desc then runAt asc order", async () => {
      await fresh();
      const low = await store.enqueue(input({ priority: 1 }));
      const high = await store.enqueue(input({ priority: 9 }));
      const midA = await store.enqueue(input({ priority: 5 }));
      const claimed = await store.claim({ workerId: "w1", queues: ["default"], limit: 10, visibilityTimeoutMs: 5000 });
      expect(claimed.map((j) => j.id)).toEqual([high.id, midA.id, low.id]);
      expect(claimed[0]!.attempts).toBe(1);
      expect(claimed[0]!.leaseOwner).toBe("w1");
      await close();
    });

    it("does not claim future or non-queued jobs", async () => {
      await fresh();
      await store.enqueue(input({ runAt: clock.now() + 60_000 }));
      await store.enqueue(input());
      const claimed = await store.claim({ workerId: "w1", queues: ["default"], limit: 10, visibilityTimeoutMs: 5000 });
      expect(claimed).toHaveLength(1);
      await close();
    });

    it("promotes due scheduled and retrying jobs to queued", async () => {
      await fresh();
      const j = await store.enqueue(input({ runAt: clock.now() + 1000 }));
      clock.advance(2000);
      const [claimed] = await store.claim({ workerId: "w", queues: ["default"], limit: 1, visibilityTimeoutMs: 1000 });
      expect(claimed!.id).toBe(j.id);
      await store.failAttempt({
        jobId: j.id,
        workerId: "w",
        errorName: "E",
        errorMessage: "e",
        stack: null,
        fatal: false,
        timedOut: false,
        nextRunAt: clock.now() + 500,
      });
      expect((await store.getJob(j.id))!.state).toBe("retrying");
      clock.advance(600);
      const again = await store.claim({ workerId: "w2", queues: ["default"], limit: 1, visibilityTimeoutMs: 1000 });
      expect(again.map((x) => x.id)).toEqual([j.id]);
      await close();
    });

    it("never hands one job to two workers", async () => {
      await fresh();
      for (let i = 0; i < 20; i++) await store.enqueue(input());
      const [a, b] = await Promise.all([
        store.claim({ workerId: "wa", queues: ["default"], limit: 20, visibilityTimeoutMs: 5000 }),
        store.claim({ workerId: "wb", queues: ["default"], limit: 20, visibilityTimeoutMs: 5000 }),
      ]);
      const ids = [...a.map((j) => j.id), ...b.map((j) => j.id)];
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toHaveLength(20);
      await close();
    });
  });

  describe("completion and failure", () => {
    it("completes a claimed job and records duration", async () => {
      await fresh();
      const j = await store.enqueue(input());
      const [job] = await store.claim({ workerId: "w", queues: ["default"], limit: 1, visibilityTimeoutMs: 5000 });
      expect(job!.id).toBe(j.id);
      clock.advance(120);
      await store.completeJob(job!.id, "w", '"ok"');
      const done = await store.getJob(job!.id);
      expect(done!.state).toBe("succeeded");
      expect(done!.result).toBe('"ok"');
      expect(done!.attemptsHistory[0]!.durationMs).toBeGreaterThanOrEqual(0);
      await close();
    });

    it("rejects completion without a valid lease", async () => {
      await fresh();
      await store.enqueue(input());
      await expect(store.completeJob("missing", "w", null)).rejects.toThrow();
      await close();
    });

    it("moves to dead after maxAttempts exhausted", async () => {
      await fresh();
      const j = await store.enqueue(input({ maxAttempts: 2 }));
      for (let i = 1; i <= 2; i++) {
        const [claimed] = await store.claim({ workerId: `w${i}`, queues: ["default"], limit: 1, visibilityTimeoutMs: 5000 });
        expect(claimed!.id).toBe(j.id);
        const target = await store.failAttempt({
          jobId: j.id, workerId: `w${i}`, errorName: "Boom", errorMessage: "boom",
          stack: "stack", fatal: false, timedOut: false, nextRunAt: clock.now(),
        });
        if (i < 2) expect(target).toBe("retrying");
      }
      expect((await store.getJob(j.id))!.state).toBe("dead");
      expect((await store.getJob(j.id))!.lastErrorMessage).toBe("boom");
      expect((await store.getJob(j.id))!.attemptsHistory[0]!.stack).toBe("stack");
      await close();
    });

    it("fatal errors move straight to failed without consuming retries", async () => {
      await fresh();
      const j = await store.enqueue(input({ maxAttempts: 5 }));
      const [claimed] = await store.claim({ workerId: "w", queues: ["default"], limit: 1, visibilityTimeoutMs: 5000 });
      await store.failAttempt({
        jobId: claimed!.id, workerId: "w", errorName: "Fatal", errorMessage: "no template",
        stack: null, fatal: true, timedOut: false, nextRunAt: null,
      });
      const done = await store.getJob(j.id);
      expect(done!.state).toBe("failed");
      expect(done!.attempts).toBe(1);
      await close();
    });
  });

  describe("leases and reclamation", () => {
    it("reclaims expired leases exactly once", async () => {
      await fresh();
      const j = await store.enqueue(input());
      await store.claim({ workerId: "dead-worker", queues: ["default"], limit: 1, visibilityTimeoutMs: 1000 });
      clock.advance(999);
      expect(await store.reclaimExpired()).toBe(0);
      clock.advance(2);
      expect(await store.reclaimExpired()).toBe(1);
      expect(await store.reclaimExpired()).toBe(0);
      const job = await store.getJob(j.id);
      expect(job!.state).toBe("queued");
      expect(job!.leaseOwner).toBe(null);
      await close();
    });

    it("heartbeat extends lease and foreign heartbeats fail", async () => {
      await fresh();
      await store.enqueue(input());
      const [job] = await store.claim({ workerId: "w1", queues: ["default"], limit: 1, visibilityTimeoutMs: 1000 });
      clock.advance(900);
      await store.heartbeat(job!.id, "w1", clock.now() + 5000, 60_000);
      clock.advance(3000);
      expect(await store.reclaimExpired()).toBe(0);
      await expect(store.heartbeat(job!.id, "other", clock.now(), 60_000)).rejects.toThrow(/lease/i);
      await close();
    });

    it("releasing worker leases returns jobs to queued preserving attempt counts", async () => {
      await fresh();
      const j = await store.enqueue(input());
      const [job] = await store.claim({ workerId: "w1", queues: ["default"], limit: 1, visibilityTimeoutMs: 60000 });
      expect(job!.id).toBe(j.id);
      const n = await store.releaseWorkerLeases("w1");
      expect(n).toBe(1);
      const back = await store.getJob(job!.id);
      expect(back!.state).toBe("queued");
      expect(back!.attempts).toBe(1);
      await close();
    });
  });

  describe("cancellation, requeue and editing", () => {
    it("cancels queued but not running or succeeded jobs", async () => {
      await fresh();
      const a = await store.enqueue(input());
      await store.cancelJob(a.id);
      expect((await store.getJob(a.id))!.state).toBe("cancelled");
      const b = await store.enqueue(input());
      await store.claim({ workerId: "w", queues: ["default"], limit: 1, visibilityTimeoutMs: 5000 });
      await expect(store.cancelJob(b.id)).rejects.toThrow(/cannot transition/);
      await close();
    });

    it("requeues dead letters resetting attempts and can edit payloads", async () => {
      await fresh();
      const j = await store.enqueue(input({ maxAttempts: 1, payload: '{"v":1}' }));
      const [claimed] = await store.claim({ workerId: "w", queues: ["default"], limit: 1, visibilityTimeoutMs: 5000 });
      await store.failAttempt({
        jobId: claimed!.id, workerId: "w", errorName: "X", errorMessage: "x", stack: null,
        fatal: false, timedOut: false, nextRunAt: null,
      });
      const edited = await store.updatePayload({ jobId: j.id, payload: '{"v":2}', payloadVersion: 2 });
      expect(JSON.parse(edited.payload)["v"]).toBe(2);
      const requeued = await store.requeueJob(j.id, { resetAttempts: true });
      expect(requeued.state).toBe("queued");
      expect(requeued.attempts).toBe(0);
      await close();
    });
  });

  describe("rate limits, concurrency limits and pause", () => {
    it("enforces per-key rate limits during claims", async () => {
      await fresh();
      await store.setRateRules([{ key: "type:test.work", limit: 2, windowMs: 60_000 }]);
      for (let i = 0; i < 5; i++) await store.enqueue(input());
      const first = await store.claim({ workerId: "w", queues: ["default"], limit: 5, visibilityTimeoutMs: 5000 });
      expect(first).toHaveLength(2);
      clock.advance(61_000);
      const second = await store.claim({ workerId: "w", queues: ["default"], limit: 5, visibilityTimeoutMs: 5000 });
      expect(second).toHaveLength(2);
      await close();
    });

    it("enforces concurrency caps per queue", async () => {
      await fresh();
      await store.setConcurrencyLimits([{ key: "queue:default", max: 1 }]);
      await store.enqueue(input({ type: "a.one" }));
      await store.enqueue(input({ type: "b.two" }));
      const c1 = await store.claim({ workerId: "w", queues: ["default"], limit: 5, visibilityTimeoutMs: 50_000 });
      expect(c1).toHaveLength(1);
      const c2 = await store.claim({ workerId: "w2", queues: ["default"], limit: 5, visibilityTimeoutMs: 50_000 });
      expect(c2).toHaveLength(0);
      await store.releaseWorkerLeases("w");
      const c3 = await store.claim({ workerId: "w2", queues: ["default"], limit: 5, visibilityTimeoutMs: 50_000 });
      expect(c3).toHaveLength(1);
      await close();
    });

    it("pause blocks claiming until resumed, including global pause", async () => {
      await fresh();
      await store.enqueue(input());
      await store.setPaused({ scope: "queue", queue: "default", paused: true });
      expect(await store.claim({ workerId: "w", queues: ["default"], limit: 1, visibilityTimeoutMs: 1000 })).toHaveLength(0);
      await store.setPaused({ scope: "queue", queue: "default", paused: false });
      expect(await store.claim({ workerId: "w", queues: ["default"], limit: 1, visibilityTimeoutMs: 1000 })).toHaveLength(1);
      await store.enqueue(input());
      await store.setPaused({ scope: "global", queue: null, paused: true });
      expect(await store.claim({ workerId: "w", queues: ["default"], limit: 1, visibilityTimeoutMs: 1000 })).toHaveLength(0);
      const stats = await store.stats();
      expect(stats.globalPaused).toBe(true);
      await close();
    });

    it("takeRateToken is a standalone bucket", async () => {
      await fresh();
      expect(await store.takeRateToken("k", 2, 60_000)).toBe(true);
      expect(await store.takeRateToken("k", 2, 60_000)).toBe(true);
      expect(await store.takeRateToken("k", 2, 60_000)).toBe(false);
      clock.advance(60_001);
      expect(await store.takeRateToken("k", 2, 60_000)).toBe(true);
      await close();
    });
  });

  describe("idempotency guard", () => {
    it("runs once and caches results", async () => {
      await fresh();
      const first = await store.beginIdempotency("render:88");
      expect(first.status).toBe("run");
      await store.completeIdempotency("render:88", "pdf-bytes");
      const second = await store.beginIdempotency("render:88");
      expect(second.status).toBe("done");
      expect(second.status === "done" && second.result).toBe("pdf-bytes");
      await store.releaseIdempotency("pending-key");
      expect((await store.beginIdempotency("pending-key")).status).toBe("run");
      await close();
    });
  });

  describe("batch enqueue", () => {
    it("is all-or-nothing on duplicate keys", async () => {
      await fresh();
      await store.enqueue(input({ dedupeKey: "taken" }));
      await expect(
        store.enqueueBatch([
          input(),
          input({ dedupeKey: "taken" }),
          input({ type: "never.created" }),
        ]),
      ).rejects.toThrow(/taken/);
      const stats = await store.stats();
      expect(statesTotal(stats.states, ["queued"])).toBe(1);
      await close();
    });
  });

  describe("stats and samples", () => {
    it("reports state and queue breakdowns plus completion samples", async () => {
      await fresh();
      const ok = await store.enqueue(input({ type: "t.ok" }));
      await store.claim({ workerId: "w", queues: ["default"], limit: 5, visibilityTimeoutMs: 5000 });
      await store.completeJob(ok.id, "w", null);
      const bad = await store.enqueue(input({ type: "t.bad", maxAttempts: 1 }));
      await store.claim({ workerId: "w", queues: ["default"], limit: 5, visibilityTimeoutMs: 5000 });
      await store.failAttempt({
        jobId: bad.id, workerId: "w", errorName: "E", errorMessage: "e", stack: null,
        fatal: false, timedOut: false, nextRunAt: null,
      });
      const stats = await store.stats();
      expect(stats.states["succeeded"]).toBe(1);
      expect(stats.states["dead"]).toBe(1);
      const t0 = clock.now();
      const samples = await store.completionSamples(t0 - 60_000, t0 + 1);
      expect(samples).toHaveLength(2);
      expect(samples.filter((s) => s.outcome === "succeeded")).toHaveLength(1);
      await close();
    });

    it("purges terminal jobs past retention", async () => {
      await fresh();
      const j = await store.enqueue(input());
      await store.cancelJob(j.id);
      clock.advance(7 * 24 * 3600_000 + 1);
      await store.enqueue(input());
      expect(await store.purgeRetention(clock.now() - 100)).toBe(1);
      expect(await store.purgeRetention(clock.now() - 100)).toBe(0);
      const stats = await store.stats();
      expect(statesTotal(stats.states, ["cancelled"])).toBe(0);
      await close();
    });
  });

  describe("listing and search", () => {
    it("filters by state/type/search text and paginates", async () => {
      await fresh();
      for (let i = 0; i < 5; i++) await store.enqueue(input({ payload: `{"n":${i}}` }));
      await store.enqueue(input({ type: "special.kind", payload: '{"needle":"yes"}' }));
      const page1 = await store.listJobs({ states: ["queued"], limit: 3, cursor: null, order: "created_asc" });
      expect(page1.jobs).toHaveLength(3);
      expect(page1.cursor).not.toBe(null);
      const page2 = await store.listJobs({ states: ["queued"], limit: 3, cursor: page1.cursor, order: "created_asc" });
      const ids = new Set([...page1.jobs.map((j) => j.id), ...page2.jobs.map((j) => j.id)]);
      expect(ids.size).toBe(page1.jobs.length + page2.jobs.length);
      const needle = await store.listJobs({ search: "needle", limit: 10, cursor: null, order: "created_desc" });
      expect(needle.jobs).toHaveLength(1);
      expect(needle.jobs[0]!.type).toBe("special.kind");
      await close();
    });
  });

  describe("lifecycle events log", () => {
    it("records a full event trail", async () => {
      await fresh();
      const j = await store.enqueue(input());
      await store.claim({ workerId: "w", queues: ["default"], limit: 1, visibilityTimeoutMs: 5000 });
      await store.completeJob(j.id, "w", null);
      const events = await store.getJobEvents(j.id);
      expect(events.map((e) => e.event)).toEqual(["enqueued", "claimed", "completed"]);
      await close();
    });
  });
}

function statesTotal(states: Record<string, number>, keys: string[]): number {
  return keys.reduce((acc, k) => acc + (states[k] ?? 0), 0);
}
