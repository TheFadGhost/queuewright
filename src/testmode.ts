import { findDefinition, type Handler, type JobContext, type JobDefinition } from "./registry.js";
import { nextRetryDelayMs, SeededRng } from "./retry.js";
import { FatalJobError, DuplicateJobError } from "./errors.js";
import type { AttemptRecord, JobRecord, LifecycleEvent } from "./types.js";
import { MAX_EVENTS_PER_JOB } from "./types.js";

interface PendingRun {
  id: string;
  def: JobDefinition<never>;
  payload: unknown;
  runAt: number;
  priority: number;
  attempts: number;
  state: "queued" | "scheduled" | "running" | "succeeded" | "failed" | "retrying" | "dead" | "cancelled";
  events: LifecycleEvent[];
  history: AttemptRecord[];
  lastError: { name: string; message: string; stack: string | null } | null;
  dedupeKey: string | null;
  createdAt: number;
}

export interface TestClient {
  enqueue<P>(def: JobDefinition<P>, payload: P, opts?: { delayMs?: number; dedupeKey?: string; priority?: number }): string;
  advance(ms: number): Promise<void>;
  stateOf(jobId: string): PendingRun["state"] | null;
  job(jobId: string): Readonly<PendingRun> | null;
  jobs(): ReadonlyArray<Readonly<PendingRun>>;
  failuresOf(jobId: string): Array<{ name: string; message: string }>;
  readonly clockNow: number;
}

/**
 * Synchronous in-process client for unit tests. Jobs run on a fake clock with
 * deterministic order (priority desc, runAt asc, creation asc) and a seeded
 * retry RNG, so tests never touch real timers or the system clock.
 */
export function createTestClient(options: { definitions: JobDefinition<never>[]; seed?: number }): TestClient {
  const known = new Map<string, JobDefinition<never>>();
  for (const d of options.definitions) known.set(d.type, d);
  let now = 1_700_000_000_000;
  let seq = 0;
  const runs = new Map<string, PendingRun>();
  const activeDedupe = new Set<string>();
  const rng = new SeededRng(options.seed ?? 7);

  async function execute(run: PendingRun): Promise<void> {
    const def = known.get(run.def.type) ?? run.def;
    run.state = "running";
    const startedAt = now;
    const rec: AttemptRecord = {
      attempt: run.attempts,
      startedAt,
      finishedAt: null,
      durationMs: null,
      outcome: "running",
      errorName: null,
      errorMessage: null,
      stack: null,
    };
    run.history.push(rec);
    pushEvent(run, "claimed");
    const ctx: JobContext = {
      jobId: run.id,
      jobType: run.def.type,
      queue: run.def.options.queue,
      attempt: run.attempts,
      signal: new AbortController().signal,
      progress: () => {},
      idempotency: (_key, fn) => fn(),
    };
    try {
      await (def.handler as Handler<unknown>)(run.payload, ctx);
      rec.finishedAt = now;
      rec.durationMs = 0;
      rec.outcome = "succeeded";
      run.state = "succeeded";
      pushEvent(run, "completed");
      if (run.dedupeKey) activeDedupe.delete(run.dedupeKey);
    } catch (e) {
      const fatal = e instanceof FatalJobError;
      rec.outcome = fatal ? "failed" : "failed";
      rec.finishedAt = now;
      rec.errorName = e instanceof Error ? e.name : "NonErrorThrow";
      rec.errorMessage = e instanceof Error ? e.message : String(e);
      run.lastError = { name: rec.errorName, message: rec.errorMessage, stack: null };
      pushEvent(run, "attempt_failed");
      if (fatal || run.attempts >= run.def.options.maxAttempts) {
        run.state = fatal ? "failed" : "dead";
        pushEvent(run, fatal ? "moved_to_failed" : "moved_to_dead");
        if (run.dedupeKey) activeDedupe.delete(run.dedupeKey);
      } else {
        run.state = "retrying";
        const delay = nextRetryDelayMs(run.def.options.retry, run.attempts, rng);
        run.runAt = now + delay;
        pushEvent(run, "retry_scheduled");
      }
    }
  }

  async function drainDue(): Promise<void> {
    for (let guard = 0; guard < 100_000; guard++) {
      const due = [...runs.values()]
        .filter((r) => (r.state === "queued" && r.runAt <= now) || (r.state === "retrying" && r.runAt <= now))
        .sort(
          (a, b) =>
            b.priority - a.priority || a.runAt - b.runAt || a.createdAt - b.createdAt,
        );
      if (due.length === 0) return;
      for (const r of due) {
        r.attempts += 1;
        if (r.state === "retrying") r.state = "queued";
        await execute(r);
      }
    }
  }

  return {
    enqueue(def, payload, opts = {}) {
      const id = `t_${(seq++).toString(36)}`;
      if (opts.dedupeKey !== undefined) {
        if (activeDedupe.has(opts.dedupeKey)) throw new DuplicateJobError(opts.dedupeKey, "existing", id);
        activeDedupe.add(opts.dedupeKey);
      }
      runs.set(id, {
        id,
        def: def as JobDefinition<never>,
        payload,
        runAt: now + (opts.delayMs ?? 0),
        priority: opts.priority ?? def.options.priority,
        attempts: 0,
        state: opts.delayMs ? "scheduled" : "queued",
        events: [],
        history: [],
        lastError: null,
        dedupeKey: opts.dedupeKey ?? null,
        createdAt: seq - 1,
      });
      if (!opts.delayMs) void 0;
      return id;
    },
    async advance(ms) {
      now += ms;
      for (const r of runs.values()) {
        if (r.state === "scheduled" && r.runAt <= now) r.state = "queued";
      }
      await drainDue();
    },
    stateOf(id) {
      return runs.get(id)?.state ?? null;
    },
    job(id) {
      return runs.get(id) ?? null;
    },
    jobs() {
      return [...runs.values()];
    },
    failuresOf(id) {
      const r = runs.get(id);
      if (!r) return [];
      return r.history
        .filter((h) => h.errorMessage !== null)
        .map((h) => ({ name: h.errorName ?? "Error", message: h.errorMessage ?? "" }));
    },
    get clockNow() {
      return now;
    },
  };

  function pushEvent(run: PendingRun, event: LifecycleEvent["event"]): void {
    run.events.push({ ts: now, event, detail: null });
    if (run.events.length > MAX_EVENTS_PER_JOB) run.events.splice(0, run.events.length - MAX_EVENTS_PER_JOB);
  }
}

void findDefinition;
