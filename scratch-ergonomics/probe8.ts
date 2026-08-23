// Probe 8: why doesn't the cron fire? Matrix of schedule shapes on memory, 70s budget.
import { Queuewright, defineJob } from "../src/index";

const qw = new Queuewright({ storage: { kind: "memory" } });
await qw.init();
let fired = 0;
const j = defineJob<{ v: string }>("p.cron8", async (p) => {
  fired++;
  console.log("FIRED", p.v);
});
const w = qw.createWorker();
w.start(); // start BEFORE creating schedules this time

await qw.createSchedule({ id: "s1", cron: "* * * * *", jobType: "p.cron8", payload: { v: "plain" } });

const anyQw = qw as any;
for (const name of ["startScheduler", "schedulerStart", "runScheduler"]) {
  console.log(name, typeof anyQw[name]);
}
for (const ev of ["on", "once"]) {
  console.log("qw." + ev, typeof anyQw[ev], "| worker." + ev, typeof (w as any)[ev]);
}

await new Promise((r) => setTimeout(r, 70_000));
console.log("total firings after 70s:", fired);
await w.stop();
await qw.close();
