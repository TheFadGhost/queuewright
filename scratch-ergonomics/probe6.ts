// Probe 6: same createSchedule matrix on SQLITE.
import { Queuewright, defineJob } from "../src/index";

const qw = new Queuewright({ storage: { kind: "sqlite", file: "./scratch-ergonomics/data/probe6.db" } });
await qw.init();
const j = defineJob("p.cron", async () => {});

const variants: [string, any][] = [
  ["minimal", { id: "v1", cron: "* * * * *", jobType: "p.cron" }],
  ["+payload", { id: "v2", cron: "* * * * *", jobType: "p.cron", payload: { a: 1 } }],
  ["+timezone", { id: "v3", cron: "* * * * *", jobType: "p.cron", timezone: "Europe/Berlin" }],
  ["+onMissed", { id: "v4", cron: "* * * * *", jobType: "p.cron", onMissed: "skip" }],
  ["readme-exact", { id: "v5", cron: "* * * * *", timezone: "Europe/Berlin", jobType: "p.cron", payload: {}, onMissed: "run_once" }],
];

for (const [label, opts] of variants) {
  try {
    await qw.createSchedule(opts);
    console.log(label.padEnd(12), "OK");
  } catch (e) {
    console.log(label.padEnd(12), "FAIL:", (e as Error).message);
  }
}
await qw.close();
