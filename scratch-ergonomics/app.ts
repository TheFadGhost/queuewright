// Ergonomics app — written strictly against README.md knowledge (+ probing logged in ops.md findings).
// Run from repo root: npx.cmd tsx scratch-ergonomics/app.ts
import { Queuewright, defineJob } from "../src/index";

const DB = "./scratch-ergonomics/data/qw.db";

// Primary instance: sqlite, as the README's minimal example prescribes.
const qw = new Queuewright({
  storage: { kind: "sqlite", file: DB },
});

await qw.init();

const getJob = (qw as any).getJob.bind(qw); // undocumented API; discovered by probing

// ---------------------------------------------------------------- b) two jobs
// Simple job — README minimal-example style.
const welcome = defineJob<{ userId: string }>("mail.welcome", async (payload, ctx) => {
  // e) progress — undocumented in README; discovered by probing.
  await ctx.progress(25);
  console.log("[mail.welcome] sending welcome to", payload.userId);
  await ctx.progress(100);
});

// Job with custom retry options + validate.
// Retry reference documents retry/maxAttempts/timeoutMs. validate's signature
// ((payload: unknown) => string | null) is NOT in the README; found via type errors.
const charge = defineJob<{ invoiceId: string; cents: number }>(
  "billing.charge",
  {
    retry: { strategy: "linear", baseDelayMs: 20, maxDelayMs: 200, jitter: "none" },
    maxAttempts: 4,
    timeoutMs: 5_000,
    validate: (p): string | null => {
      const q = p as { invoiceId?: unknown; cents?: unknown };
      if (typeof q.invoiceId !== "string" || q.invoiceId.length === 0) return "invoiceId must be a non-empty string";
      if (typeof q.cents !== "number" || !Number.isInteger(q.cents) || q.cents <= 0) return "cents must be a positive integer";
      return null;
    },
  },
  async (p, ctx) => {
    // e) idempotency: attempt 1 runs the guarded effect then fails;
    // later attempts must NOT re-run it (cached outcome).
    const effects = ((globalThis as any).__chargeEffects ??= []);
    await ctx.idempotency(`charge:${p.invoiceId}`, async () => {
      effects.push(p.invoiceId);
      console.log("[billing.charge] SIDE EFFECT ran for", p.invoiceId);
    });
    if (ctx.attempt < 2) throw new Error("flaky gateway (transient)");
    console.log("[billing.charge] completed", p.invoiceId, "| guarded effect ran", effects.length, "time(s)");
  },
);

// ---------------------------------------------------------------- c) enqueue both + batch
const recWelcome = await qw.enqueue(welcome, { userId: "u_1042" });
console.log("enqueued", recWelcome.id, "(mail.welcome)");

const recCharge = await qw.enqueue(charge, { invoiceId: "inv_9", cents: 4200 });

// Batch — undocumented; tuple form [job, payload][] confirmed by probing.
const tickJob = defineJob<{ i: number }>("batch.tick", async (p) => {
  console.log("[batch.tick] ran", p.i);
});
const batch = await (qw as any).enqueueBatch([
  [tickJob, { i: 1 }],
  [tickJob, { i: 2 }],
  [tickJob, { i: 3 }],
]);
const batchIds: string[] = batch.map((r: any) => r.id);
console.log("batch enqueued:", batchIds.length, "jobs");

// Dead-letter factory for the ops.md CLI session: always fails, exhausts quickly.
const doom = defineJob<{ why: string }>(
  "doom.always-fails",
  { retry: { strategy: "fixed", baseDelayMs: 10, jitter: "none" }, maxAttempts: 2 },
  async (p) => {
    throw new Error(`doomed: ${p.why}`);
  },
);
const recDoom = await qw.enqueue(doom, { why: "ops-demo" });
console.log("enqueued", recDoom.id, "(doom.always-fails -> dead)");

// ---------------------------------------------------------------- c') run worker until jobs settle
const worker = qw.createWorker();
worker.start();

async function waitState(id: string): Promise<any> {
  const deadline = Date.now() + 90_000;
  for (;;) {
    const rec = await getJob(id);
    // NB: success state is "succeeded" — undocumented in README; "completed" hangs forever.
    if (rec && ["succeeded", "completed", "failed", "dead"].includes(rec.state)) return rec;
    if (Date.now() > deadline) throw new Error("timeout waiting for " + id);
    await new Promise((r) => setTimeout(r, 100));
  }
}

await Promise.all([waitState(recWelcome.id), waitState(recCharge.id), waitState(recDoom.id), ...batchIds.map(waitState)]);
await worker.stop();
console.log("worker stopped cleanly");

// ---------------------------------------------------------------- d) final states
for (const id of [recWelcome.id, recCharge.id, recDoom.id, ...batchIds]) {
  const rec = await getJob(id);
  console.log("FINAL", rec.type.padEnd(14), rec.state.padEnd(10), "attempts:", rec.attempts);
}

// ---------------------------------------------------------------- f) cron schedule firing once
// BLOCKER WORKAROUND: createSchedule crashes on sqlite ("16 values for 15 columns")
// for every input incl. the README's verbatim example, so this demo uses a memory instance.
const qwMem = new Queuewright({ storage: { kind: "memory" } });
await qwMem.init();
let firedCount = 0;
let wakeCron: () => void;
const cronFiredOnce = new Promise<void>((r) => (wakeCron = r));
const cronJob = defineJob<{ note: string }>("maintenance.tick", async (p) => {
  firedCount++;
  console.log("[maintenance.tick] CRON FIRED:", p.note);
  if (firedCount === 1) wakeCron();
});
await qwMem.createSchedule({
  id: "erg-probe-tick",
  cron: "* * * * *", // shrunk from nightly to every minute to observe one firing
  timezone: "Europe/Berlin",
  jobType: "maintenance.tick",
  payload: { note: "hello from schedule" },
  onMissed: "skip",
});
console.log("schedule created (memory backend; sqlite path is broken)");
const wCron = qwMem.createWorker();
wCron.start();
console.log("waiting up to 75s for the next minute boundary...");
await Promise.race([cronFiredOnce, new Promise((r) => setTimeout(r, 75_000))]);
await wCron.stop(); // stop before the next tick so it fires exactly once
if (typeof (qwMem as any).deleteSchedule === "function") {
  await (qwMem as any).deleteSchedule("erg-probe-tick");
}
console.log("cron observed firing", firedCount, "time(s)" + (firedCount === 0 ? "  << SCHEDULES NEVER FIRE (blocker)" : ""));
await qwMem.close();

// ---------------------------------------------------------------- g) pause / resume of a queue
// README only shows global scope; queue scope guessed by symmetry.
await (qw as any).setPaused({ scope: "queue", queue: "default", paused: true });
console.log("queue 'default' paused");
const pausedProbe = defineJob<{ x: number }>("pause.probe", async () => {
  console.log("[pause.probe] running after resume");
});
const ppRec = await qw.enqueue(pausedProbe, { x: 1 });
const w2 = qw.createWorker();
w2.start();
await new Promise((r) => setTimeout(r, 1500));
let ppState = (await getJob(ppRec.id))?.state;
console.log("while paused, probe state =", ppState, "(expected: queued)");
await (qw as any).setPaused({ scope: "queue", queue: "default", paused: false });
console.log("queue resumed");
ppState = (await waitState(ppRec.id)).state;
console.log("after resume, probe state =", ppState);
await w2.stop();

await qw.close();
console.log("DONE");
process.exit(0);
