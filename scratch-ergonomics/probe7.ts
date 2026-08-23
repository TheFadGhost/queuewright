// Probe 7: what does getJob return AFTER a job completes?
import { Queuewright, defineJob } from "../src/index";

const qw = new Queuewright({ storage: { kind: "sqlite", file: "./scratch-ergonomics/data/probe7.db" } });
await qw.init();
const j = defineJob("p.after", async () => {});
const rec = await qw.enqueue(j, {});
const getJob = (qw as any).getJob.bind(qw);
const w = qw.createWorker();
w.start();
await new Promise((r) => setTimeout(r, 2500));
await w.stop();
const after = await getJob(rec.id);
console.log("getJob after completion:", after === null ? "NULL" : JSON.stringify(after).slice(0, 200));
const anyQw = qw as any;
for (const name of ["listJobs", "getJobs", "completedJobs", "history", "getJobHistory"]) {
  console.log(name, typeof anyQw[name]);
}
if (typeof anyQw.listJobs === "function") {
  try {
    const rows = await anyQw.listJobs({ state: "completed" });
    console.log("listJobs({state:'completed'}) ->", Array.isArray(rows) ? `${rows.length} rows; first: ${JSON.stringify(rows[0]).slice(0, 160)}` : rows);
  } catch (e) {
    console.log("listJobs failed:", (e as Error).message);
    try {
      const rows2 = await anyQw.listJobs();
      console.log("listJobs() ->", Array.isArray(rows2) ? `${rows2.length} rows` : rows2);
    } catch (e2) {
      console.log("listJobs() failed too:", (e2 as Error).message);
    }
  }
}
await qw.close();
