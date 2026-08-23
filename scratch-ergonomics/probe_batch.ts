// Probe: batch enqueue. README shows only single qw.enqueue(job, payload). Guessing names.
import { Queuewright, defineJob } from "../src/index";

const qw = new Queuewright({ storage: { kind: "memory" } });
await qw.init();
const j = defineJob<{ n: number }>("p.batch", async () => {});
await qw.init();
const anyQw = qw as any;
for (const name of ["enqueueBatch", "enqueueMany", "bulkEnqueue", "enqueueAll"]) {
  console.log(name, typeof anyQw[name]);
}
console.log("enqueue accepts array?", qw.enqueue.length);
await qw.close();
