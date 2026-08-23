// Probe: how do I read a job's final state programmatically? README documents only CLI/dashboard/stats.
import { Queuewright, defineJob } from "../src/index";

const qw = new Queuewright({ storage: { kind: "memory" } });
await qw.init();
const j = defineJob<{ n: number }>("p.state", async () => {});
const anyQw = qw as any;
for (const name of ["getJob", "job", "fetchJob", "getJobState", "listJobs", "jobs"]) {
  console.log(name, typeof anyQw[name]);
}
const id = await qw.enqueue(j, { n: 1 });
console.log("enqueue returned:", id);
if (typeof anyQw.getJob === "function") {
  console.log("getJob(id):", JSON.stringify(await anyQw.getJob(String(id))));
}
await qw.close();
