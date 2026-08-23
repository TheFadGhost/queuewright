// Probe 2: ctx.progress with real execution; also correct getJob usage.
import { Queuewright, defineJob } from "../src/index";

const qw = new Queuewright({ storage: { kind: "memory" } });
await qw.init();

const j = defineJob<{ n: number }>("p.progress", async (payload, ctx) => {
  console.log("ctx keys:", Object.keys(ctx as any));
  const anyCtx = ctx as any;
  for (const name of ["progress", "setProgress", "reportProgress", "updateProgress"]) {
    console.log(name, typeof anyCtx[name]);
  }
});

await qw.enqueue(j, { n: 1 });
const worker = qw.createWorker();
worker.start();
await new Promise((r) => setTimeout(r, 2000));
await worker.stop();
await qw.close();
