import { beforeEach, describe, expect, it } from "vitest";
import { FakeClock } from "../../src/util.js";
import { MemoryStorage } from "../../src/storage/memory.js";
import { Queuewright } from "../../src/client.js";
import { Scheduler } from "../../src/scheduler.js";
import { defineJob, resetRegistryForTests } from "../../src/registry.js";

let clock: FakeClock;
let qw: Queuewright;
let sched: Scheduler;
const noop = (): Promise<void> => Promise.resolve();

beforeEach(() => {
  resetRegistryForTests();
  clock = new FakeClock(Date.parse("2026-08-22T12:00:30Z"));
  qw = new Queuewright({ storageInstance: new MemoryStorage({ now: () => clock.now() }), now: () => clock.now() });
  defineJob("sched.work", {}, noop);
  sched = new Scheduler(qw, "w_test");
});

async function createdJobs(): Promise<number> {
  const page = await qw.listJobs({ states: ["queued"], limit: 1000, cursor: null, order: "created_asc" });
  return page.jobs.length + page.cursor === null ? page.jobs.length : page.jobs.length;
}

describe("scheduler", () => {
  it("fires on the next matching slot and records next fire", async () => {
    await qw.init();
    await qw.createSchedule({ id: "s1", cron: "* * * * *", jobType: "sched.work" });
    await sched.tickOnceForTests();
    expect(await createdJobs()).toBe(0);
    clock.advance(35_000); // 12:01:05
    await sched.tickOnceForTests();
    const jobs = await qw.listJobs({ states: ["queued"], limit: 10, cursor: null, order: "created_asc" });
    expect(jobs.jobs.length).toBe(1);
    const s = await qw.storage.getSchedule("s1");
    expect(s!.nextFireAt).toBe(Date.parse("2026-08-22T12:02:00Z"));
  });

  it("run_once collapses a long downtime into a single fire", async () => {
    await qw.init();
    await qw.createSchedule({ id: "s2", cron: "* * * * *", jobType: "sched.work", onMissed: "run_once" });
    await sched.tickOnceForTests(); // prime nextFireAt = 12:01
    clock.advance(10 * 60_000 + 5000); // down for ~10 slots -> 12:11:05
    await sched.tickOnceForTests();
    const jobs = await qw.listJobs({ states: ["queued"], limit: 1000, cursor: null, order: "created_asc" });
    expect(jobs.jobs.length).toBe(1);
  });

  it("catch_up enqueues one job per missed slot", async () => {
    await qw.init();
    await qw.createSchedule({ id: "s3", cron: "* * * * *", jobType: "sched.work", onMissed: "catch_up" });
    await sched.tickOnceForTests();
    clock.advance(5 * 60_000 + 1000); // missed 12:01..12:05 -> 12:05:31
    await sched.tickOnceForTests();
    const jobs = await qw.listJobs({ states: ["queued"], limit: 1000, cursor: null, order: "created_asc" });
    expect(jobs.jobs.length).toBe(5);
  });

  it("skip drops missed slots entirely", async () => {
    await qw.init();
    await qw.createSchedule({ id: "s4", cron: "* * * * *", jobType: "sched.work", onMissed: "skip" });
    await sched.tickOnceForTests();
    clock.advance(4 * 60_000 + 1000);
    await sched.tickOnceForTests();
    const jobs = await qw.listJobs({ states: ["queued"], limit: 1000, cursor: null, order: "created_asc" });
    expect(jobs.jobs.length).toBe(0);
    const s = await qw.storage.getSchedule("s4");
    expect(s!.nextFireAt).toBe(Date.parse("2026-08-22T12:05:00Z"));
  });

  it("paused schedules never fire", async () => {
    await qw.init();
    await qw.createSchedule({ id: "s5", cron: "* * * * *", jobType: "sched.work", paused: true });
    await sched.tickOnceForTests();
    clock.advance(3 * 60_000);
    await sched.tickOnceForTests();
    expect(await createdJobs()).toBe(0);
  });

  it("timezone-aware schedule skips nonexistent local times across DST", () => {
    return (async () => {
      await qw.init();
      // Created before the Mar 28 slot; 2026-03-29 02:30 does not exist in
      // Berlin (spring forward).
      clock.set(Date.parse("2026-03-27T20:00:00Z"));
      await qw.createSchedule({
        id: "dst",
        cron: "30 2 * * *",
        timezone: "Europe/Berlin",
        jobType: "sched.work",
      });
      await sched.tickOnceForTests();
      // Jump past both Mar 28 02:30 CET (valid) and Mar 29 (nonexistent).
      clock.set(Date.parse("2026-03-29T20:00:00Z"));
      await sched.tickOnceForTests();
      const s = await qw.storage.getSchedule("dst");
      expect(s!.lastFiredAt).toBe(Date.parse("2026-03-28T01:30:00Z"));
      expect(s!.nextFireAt).toBe(Date.parse("2026-03-30T00:30:00Z"));
    })();
  });

  it("rejects invalid cron and unknown job types when creating schedules", async () => {
    await qw.init();
    await expect(
      qw.createSchedule({ id: "bad", cron: "99 * * * *", jobType: "sched.work" }),
    ).rejects.toThrow(/minute/);
    await expect(
      qw.createSchedule({ id: "bad2", cron: "* * * * *", jobType: "nope.missing" }),
    ).rejects.toThrow(/not registered/);
  });
});
