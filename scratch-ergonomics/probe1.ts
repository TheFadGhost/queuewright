// Probe 1b: same as probe1 but importing from src/index directly.
import { Queuewright, defineJob } from "../src/index";

const qw = new Queuewright({ storage: { kind: "sqlite", file: "./scratch-ergonomics/data/probe1.db" } });

const welcome = defineJob<{ userId: string }>("mail.welcome", async (payload) => {
  console.log("sending welcome to", payload.userId);
});

await qw.init();
await qw.enqueue(welcome, { userId: "u_1042" });
console.log("enqueued ok");
await workerStuff();

async function workerStuff() {
  const worker = qw.createWorker();
  worker.start();
  await new Promise((r) => setTimeout(r, 3000));
  await worker.stop();
  console.log("worker stopped");
  await qw.close();
}
