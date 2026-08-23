// Probe 9: create a fresh dead letter in the shared ops DB (CLI alone cannot).
import { Queuewright, defineJob } from "../src/index";

const qw = new Queuewright({ storage: { kind: "sqlite", file: "./scratch-ergonomics/data/qw.db" } });
await qw.init();
const doom = defineJob<{ why: string }>(
  "doom.always-fails",
  { retry: { strategy: "fixed", baseDelayMs: 10, jitter: "none" }, maxAttempts: 2 },
  async (p) => {
    throw new Error(`doomed: ${p.why}`);
  },
);
const rec = await qw.enqueue(doom, { why: "ops-demo-v2" });
console.log("doom id", rec.id);
const w = qw.createWorker();
w.start();
for (;;) {
  await new Promise((r) => setTimeout(r, 100));
  const j = await (qw as any).getJob(rec.id);
  if (j && ["dead", "failed"].includes(j.state)) {
    console.log("doom state:", j.state);
    break;
  }
}
await w.stop();
await qw.close();
