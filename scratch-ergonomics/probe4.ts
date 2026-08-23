// Probe 4: validate(true) trap, batch call shape, FatalJobError export, getJob(id) form.
import { Queuewright, defineJob, FatalJobError } from "../src/index";

console.log("FatalJobError:", typeof FatalJobError);

const qw = new Queuewright({ storage: { kind: "memory" } });
await qw.init();

const boolJob = defineJob<{ a: number }>("p.boolval", { validate: () => true }, async () => {
  console.log("SHOULD NOT RUN");
});
try {
  await qw.enqueue(boolJob, { a: 1 });
  console.log("boolean-true validate: enqueue accepted");
} catch (e) {
  console.log("boolean-true validate REJECTED at enqueue:", (e as Error).message);
}

const j = defineJob<{ n: number }>("p.batch2", async () => {});
const rec = await qw.enqueue(j, { n: 1 });
const anyQw = qw as any;
const full = await anyQw.getJob(rec.id);
console.log("getJob(rec.id).state =", full?.state);

// batch shape guesses
try {
  const r1 = await anyQw.enqueueBatch([[j, { n: 2 }], [j, { n: 3 }]]);
  console.log("enqueueBatch([ [job,payload], ... ]) ->", Array.isArray(r1) ? `${r1.length} records, first id ${r1[0].id}` : r1);
} catch (e) {
  console.log("tuple form failed:", (e as Error).message);
}
try {
  const r2 = await anyQw.enqueueBatch([{ job: j, payload: { n: 4 } }]);
  console.log("enqueueBatch([ {job,payload} ]) ->", JSON.stringify(r2).slice(0, 80));
} catch (e) {
  console.log("object form failed:", (e as Error).message);
}
await qw.close();
