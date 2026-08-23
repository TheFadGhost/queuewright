import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { FakeClock } from "../../src/util.js";
import { MemoryStorage } from "../../src/storage/memory.js";
import { SqliteStorage } from "../../src/storage/sqlite.js";
import type { StorageBackend } from "../../src/storage/interface.js";
import { Queuewright } from "../../src/client.js";
import { Scheduler } from "../../src/scheduler.js";
import { defineJob, resetRegistryForTests } from "../../src/registry.js";

let clock: FakeClock;

function makeQw(storage: StorageBackend): Queuewright {
  return new Queuewright({ storageInstance: storage, now: () => clock.now() });
}

beforeEach(() => {
  resetRegistryForTests();
  clock = new FakeClock(Date.parse("2026-08-22T12:00:30Z"));
  defineJob("reg.work", {}, () => Promise.resolve());
});

describe("schedule regression guards", () => {
  it("creates and lists schedules on sqlite (INSERT regression)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qw-sched-"));
    const store = new SqliteStorage({ file: join(dir, "q.db"), now: () => clock.now() });
    const qw = makeQw(store);
    await qw.init();
    const s = await qw.createSchedule({ id: "s1", cron: "* * * * *", jobType: "reg.work" });
    expect(s.nextFireAt).toBe(null);
    const listed = await qw.listSchedules();
    expect(listed).toHaveLength(1);
    expect(listed[0]!.jobType).toBe("reg.work");
    await qw.close();
  });

  it("two concurrent schedulers on one sqlite store never double-fire a slot", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qw-cas-"));
    const dbFile = join(dir, "q.db");
    const storeA = new SqliteStorage({ file: dbFile, now: () => clock.now() });
    const storeB = new SqliteStorage({ file: dbFile, now: () => clock.now() });
    const qa = makeQw(storeA);
    const qb = makeQw(storeB);
    await qa.init();
    await qb.init();
    await qa.createSchedule({ id: "cas", cron: "* * * * *", jobType: "reg.work" });

    const schedA = new Scheduler(qa, "wa");
    const schedB = new Scheduler(qb, "wb");
    // Prime nextFireAt through one instance.
    await schedA.tickOnceForTests();

    // Both instances see the same due slot at the same instant.
    clock.advance(60_000);
    await Promise.all([schedA.tickOnceForTests(), schedB.tickOnceForTests()]);

    const jobsA = await qa.listJobs({ states: ["queued"], limit: 100, cursor: null, order: "created_asc" });
    const jobsB = await qb.listJobs({ states: ["queued"], limit: 100, cursor: null, order: "created_asc" });
    const total = new Set([...jobsA.jobs.map((j) => j.id), ...jobsB.jobs.map((j) => j.id)]).size;
    expect(total).toBe(1);

    await qa.close();
    await qb.close();
  }, 30_000);

  it("memory backend enforces the same single-fire CAS guarantee", async () => {
    const store = new MemoryStorage({ now: () => clock.now() });
    const qw = makeQw(store);
    await qw.init();
    await qw.createSchedule({ id: "m1", cron: "* * * * *", jobType: "reg.work" });
    const sa = new Scheduler(qw, "wa");
    const sb = new Scheduler(qw, "wb");
    await sa.tickOnceForTests();
    clock.advance(60_000);
    await Promise.all([sa.tickOnceForTests(), sb.tickOnceForTests(), sa.tickOnceForTests()]);
    const page = await qw.listJobs({ states: ["queued"], limit: 100, cursor: null, order: "created_asc" });
    expect(page.jobs).toHaveLength(1);
    await qw.close();
  });

  it("idempotency busy path prevents duplicate side effects under concurrency", async () => {
    let executions = 0;
    defineJob("idem.work", {}, async (_p, ctx) => {
      await ctx.idempotency("shared-key", async () => {
        executions++;
        await new Promise((r) => setTimeout(r, 50));
      });
    });
    const store = new MemoryStorage({ now: () => clock.now() });
    const qw = makeQw(store);
    await qw.init();
    const job = await qw.rawEnqueue("idem.work", "{}", {});
    // Simulate two attempts racing on the same key.
    const [a, b] = await Promise.allSettled([
      (async () => {
        const begun = await store.beginIdempotency("shared-key");
        if (begun.status === "run") {
          executions++;
          await new Promise((r) => setTimeout(r, 50));
          await store.completeIdempotency("shared-key", '"a"');
        }
        return begun.status;
      })(),
      store.beginIdempotency("shared-key").then((r) => r.status),
    ]);
    void job;
    const statuses = [a.status === "fulfilled" ? a.value : "rejected", b.status === "fulfilled" ? b.value : "rejected"];
    expect(statuses).toContain("busy");
    expect(executions).toBe(1);
    await qw.close();
  });
});
