import { FakeClock } from "../src/util.js";
import { MemoryStorage } from "../src/storage/memory.js";
import { Queuewright } from "../src/client.js";
import { Scheduler } from "../src/scheduler.js";
import { defineJob } from "../src/registry.js";

defineJob("sched.work", {}, () => Promise.resolve());
const clock = new FakeClock(Date.parse("2026-08-22T12:00:30Z"));
const qw = new Queuewright({
  storageInstance: new MemoryStorage({ now: () => clock.now() }),
  now: () => clock.now(),
});
await qw.init();
await qw.createSchedule({ id: "s1", cron: "* * * * *", jobType: "sched.work" });
const sched = new Scheduler(qw, "w_test");
await sched.tickOnceForTests();
console.log("after prime:", JSON.stringify(await qw.storage.getSchedule("s1")));
clock.advance(35_000);
await sched.tickOnceForTests();
console.log("after fire:", JSON.stringify(await qw.storage.getSchedule("s1")));
const jobs = await qw.listJobs({ states: ["queued"], limit: 10, cursor: null, order: "created_asc" });
console.log("jobs:", jobs.jobs.length);
