// Probe 3: does validate actually reject bad payloads? And does it typecheck?
import { Queuewright, defineJob } from "../src/index";

const qw = new Queuewright({ storage: { kind: "memory" } });
await qw.init();

const j = defineJob<{ userId: string }>(
  "p.validate",
  {
    validate: (p) => typeof p.userId === "string" && p.userId.length > 0,
    maxAttempts: 2,
  },
  async (p) => {
    console.log("handler ran with", JSON.stringify(p));
  },
);

try {
  const bad = await qw.enqueue(j, { userId: 42 } as any);
  console.log("enqueue of invalid payload returned:", JSON.stringify(bad));
} catch (e) {
  console.log("enqueue threw:", (e as Error).name, (e as Error).message);
}

const worker = qw.createWorker();
worker.start();
await new Promise((r) => setTimeout(r, 2500));
await worker.stop();
const rec = await (qw as any).getJob("j_does_not_exist");
console.log("getJob(missing):", rec);
await qw.close();
