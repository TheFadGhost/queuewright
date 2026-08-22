import { randomBytes } from "node:crypto";
import { FatalJobError, LeaseLostError, WrappedThrowError } from "./errors.js";
import { runIdempotent } from "./idempotency.js";
import { nextRetryDelayMs, DefaultRng } from "./retry.js";
import { findDefinition, type JobContext } from "./registry.js";
import type { Queuewright } from "./client.js";
import { redactPayload } from "./observability/logger.js";
import type { JobRecord } from "./types.js";
import { Scheduler } from "./scheduler.js";

export class JobTimeoutError extends Error {
  constructor(jobId: string, ms: number) {
    super(`job "${jobId}" timed out after ${ms}ms`);
    this.name = "JobTimeoutError";
  }
}

interface Inflight {
  job: JobRecord;
  abort: AbortController;
  finished: Promise<void>;
}

export class Worker {
  readonly workerId: string;
  private qw: Queuewright;
  private inflight = new Map<string, Inflight>();
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private stopRequested = false;
  private timers: NodeJS.Timeout[] = [];
  private scheduler: Scheduler | null = null;
  private readonly rng = new DefaultRng();

  constructor(qw: Queuewright) {
    this.qw = qw;
    this.workerId = `w_${randomBytes(6).toString("hex")}`;
  }

  attachScheduler(scheduler: Scheduler): void {
    this.scheduler = scheduler;
  }

  get inflightCount(): number {
    return this.inflight.size;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopRequested = false;
    const log = this.qw.logger.child({ module: "worker" });
    log.info("worker starting", {
      kv: { workerId: this.workerId, concurrency: this.qw.concurrency },
    });
    const sweepMs = Math.max(1000, Math.floor(this.qw.visibilityTimeoutMs / 3));
    const sweeper = setInterval(() => {
      void this.sweep();
    }, sweepMs);
    sweeper.unref?.();
    this.timers.push(sweeper);
    const retention = setInterval(
      () => {
        void this.storage.purgeRetention(this.qw.clock() - this.qw.retentionMs).catch(() => {});
      },
      Math.max(60_000, Math.floor(this.qw.retentionMs / 10)),
    );
    retention.unref?.();
    this.timers.push(retention);
    this.loopPromise = this.loop(log);
  }

  private get storage() {
    return this.qw.storage;
  }

  private async sweep(): Promise<void> {
    try {
      const n = await this.storage.reclaimExpired();
      if (n > 0) {
        this.qw.metrics.inc("qw_jobs_reclaimed_total");
        this.qw.logger.warn("reclaimed jobs whose lease expired", {
          module: "worker",
          kv: { count: n },
        });
      }
    } catch (e) {
      this.logFrameworkError("reclaim sweep failed", e);
    }
  }

  private async loop(log: ReturnType<Queuewright["logger"]["child"]>): Promise<void> {
    while (!this.stopRequested) {
      try {
        const freeSlots = this.qw.concurrency - this.inflight.size;
        if (freeSlots <= 0) {
          await sleep(10);
          continue;
        }
        const claimed = await this.storage.claim({
          workerId: this.workerId,
          queues: this.qw.queues,
          limit: freeSlots,
          visibilityTimeoutMs: this.qw.visibilityTimeoutMs,
        });
        if (claimed.length === 0) {
          this.qw.metrics.inc("qw_claims_empty_total");
          await sleep(this.qw.pollIntervalMs);
          continue;
        }
        for (const job of claimed) this.dispatch(job, log);
      } catch (e) {
        this.logFrameworkError("claim round failed; storage may be unavailable", e);
        await sleep(Math.max(500, this.qw.pollIntervalMs));
      }
    }
  }

  private dispatch(job: JobRecord, log: ReturnType<Queuewright["logger"]["child"]>): void {
    const abort = new AbortController();
    const startedAt = this.qw.clock();
    const finished = this.execute(job, abort, log, startedAt).finally(() => {
      this.inflight.delete(job.id);
    });
    this.inflight.set(job.id, { job, abort, finished });
  }

  private async execute(
    job: JobRecord,
    abort: AbortController,
    log: ReturnType<Queuewright["logger"]["child"]>,
    startedAt: number,
  ): Promise<void> {
    const def = findDefinition(job.type);
    const jlog = log.child({ jobId: job.id, jobType: job.type, queue: job.queue });
    let heartbeat: NodeJS.Timeout | null = null;
    let timeout: NodeJS.Timeout | null = null;
    let timedOut = false;
    const timeoutMs = def?.options.timeoutMs ?? 30_000;

    heartbeat = setInterval(() => {
      void this.storage
        .heartbeat(job.id, this.workerId, this.qw.clock() + this.qw.visibilityTimeoutMs)
        .catch((e) => this.logFrameworkError("heartbeat failed", e));
    }, Math.max(250, Math.floor(this.qw.visibilityTimeoutMs / 3)));
    heartbeat.unref?.();

    try {
      if (!def) {
        await this.storage.failAttempt({
          jobId: job.id,
          workerId: this.workerId,
          errorName: "UnregisteredJobTypeError",
          errorMessage: `job type "${job.type}" is not registered in this worker process`,
          stack: null,
          fatal: true,
          timedOut: false,
          nextRunAt: null,
        });
        jlog.error(
          `job type "${job.type}" is not registered in this process; job moved to failed`,
          {},
        );
        return;
      }

      timeout = setTimeout(() => {
        timedOut = true;
        abort.abort();
      }, timeoutMs);
      timeout.unref?.();

      let payload: unknown;
      try {
        payload = JSON.parse(job.payload);
      } catch {
        payload = undefined;
      }
      if (
        def.options.migrate &&
        job.payloadVersion < def.options.version
      ) {
        payload = def.options.migrate(payload, job.payloadVersion);
      }

      const ctx: JobContext = {
        jobId: job.id,
        jobType: job.type,
        queue: job.queue,
        attempt: job.attempts,
        signal: abort.signal,
        progress: (fraction, note) => {
          void this.storage.setProgress(job.id, clamp01(fraction), note ?? null).catch(() => {});
        },
        idempotency: (key, fn) => runIdempotent(this.storage, key, fn),
      };

      const handlerPromise = Promise.resolve(def.handler(payload as never, ctx));
      const timeoutPromise = new Promise<never>((_, reject) => {
        abort.signal.addEventListener(
          "abort",
          () => reject(new JobTimeoutError(job.id, timeoutMs)),
          { once: true },
        );
      });
      await Promise.race([handlerPromise, timeoutPromise]);

      clearTimeout(timeout!);
      clearInterval(heartbeat);
      let resultJson: string | null = null;
      const outcome = await handlerPromise
        .then((r) => ({ ok: true as const, r }))
        .catch(async (e) => ({ ok: false as const, e }));
      if (outcome.ok) {
        resultJson = outcome.r === undefined ? null : safeJson(outcome.r);
        await this.storage.completeJob(job.id, this.workerId, resultJson);
        this.qw.metrics.inc("qw_jobs_completed_total", [
          ["queue", job.queue],
          ["type", job.type],
          ["result", "succeeded"],
        ]);
        this.qw.metrics.observeDuration(job.queue, job.type, this.qw.clock() - startedAt);
        jlog.info("job completed", { attempt: job.attempts, durationMs: this.qw.clock() - startedAt });
        await this.chainSuccess(def.type, outcome.r, payload);
        return;
      }
      clearTimeout(timeout!);
      clearInterval(heartbeat);
      await this.handleFailure(outcome.e, job, timedOut, jlog, timeoutMs);
    } catch (e) {
      clearTimeout(timeout!);
      clearInterval(heartbeat);
      if (e instanceof LeaseLostError) {
        jlog.warn("lost the lease; another worker owns this job now", {
          err: errFields(e),
        });
        return;
      }
      await this.handleFailure(e, job, timedOut, jlog, timeoutMs);
    }
  }

  private async handleFailure(
    e: unknown,
    job: JobRecord,
    timedOut: boolean,
    jlog: ReturnType<Queuewright["logger"]["child"]>,
    timeoutMs: number,
  ): Promise<void> {
    const fatal = e instanceof FatalJobError;
    const wrapped = !(e instanceof Error) ? new WrappedThrowError(e) : e;
    const name = timedOut ? "JobTimeoutError" : wrapped instanceof FatalJobError ? "FatalJobError" : wrapped.name || "Error";
    const message =
      timedOut
        ? `handler exceeded its ${timeoutMs}ms timeout and was interrupted`
        : wrapped.message;
    const stack = timedOut ? null : wrapped instanceof Error ? (wrapped.stack ?? null) : String(wrapped);
    try {
      const target = await this.storage.failAttempt({
        jobId: job.id,
        workerId: this.workerId,
        errorName: name,
        errorMessage: message,
        stack,
        fatal,
        timedOut,
        nextRunAt:
          !fatal && !timedOut
            ? this.qw.clock() +
              nextRetryDelayMs(job.retry, job.attempts, this.rng)
            : timedOut
              ? this.qw.clock() + nextRetryDelayMs(job.retry, job.attempts, this.rng)
              : null,
      });
      if (target === "retrying") {
        this.qw.metrics.inc("qw_retries_total", [["queue", job.queue], ["type", job.type]]);
      } else if (target === "dead") {
        this.qw.metrics.inc("qw_dead_total", [["queue", job.queue], ["type", job.type]]);
        this.qw.metrics.inc("qw_jobs_completed_total", [
          ["queue", job.queue],
          ["type", job.type],
          ["result", "dead"],
        ]);
      } else {
        this.qw.metrics.inc("qw_jobs_completed_total", [
          ["queue", job.queue],
          ["type", job.type],
          ["result", "failed"],
        ]);
      }
      this.qw.metrics.observeDuration(job.queue, job.type, this.qw.clock());
      jlog.warn(`job attempt failed (${target})`, {
        attempt: job.attempts,
        err: { name, message, stack },
      });
      if (process.env["QW_LOG_UNSAFE_PAYLOADS"] === "1" && !this.warnedUnsafe) {
        this.warnedUnsafe = true;
        this.qw.logger.noteUnsafePayloads();
      }
    } catch (e2) {
      if (e2 instanceof LeaseLostError) {
        jlog.warn("lost the lease while recording failure; job owned elsewhere", {
          err: errFields(e2),
        });
        return;
      }
      this.logFrameworkError("failed to record job failure; job stays leased until reclaim", e2);
    }
  }

  private warnedUnsafe = false;

  private async chainSuccess(type: string, result: unknown, sourcePayload: unknown): Promise<void> {
    const def = findDefinition(type);
    const chain = def?.options.onSuccess;
    if (!chain) return;
    const nextDef = findDefinition(chain.type);
    if (!nextDef) {
      this.qw.logger.error(
        `continuation target "${chain.type}" is not registered; successor was not enqueued`,
        { module: "worker", kv: { sourceType: type } },
      );
      return;
    }
    try {
      const payload = chain.buildPayload(result, sourcePayload);
      const record = await this.qw.enqueue(nextDef, payload as never);
      this.qw.logger.info("continuation enqueued", {
        module: "worker",
        kv: { from: type, to: chain.type, jobId: record.id },
      });
    } catch (e) {
      this.logFrameworkError(`failed to enqueue continuation "${chain.type}"`, e);
    }
  }

  private logFrameworkError(msg: string, e: unknown): void {
    this.qw.logger.error(msg, {
      module: "worker",
      err: errFields(e),
    });
  }

  /**
   * Stop claiming new jobs, wait up to shutdownDeadlineMs for in-flight jobs,
   * then requeue whatever is left (attempts preserved).
   */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.stopRequested = true;
    const deadline = this.qw.clock() + this.qw.shutdownDeadlineMs;
    while (this.inflight.size > 0 && this.qw.clock() < deadline) {
      await sleep(25);
    }
    for (const { abort } of this.inflight.values()) abort.abort();
    const hardDeadline = this.qw.clock() + 2000;
    while (this.inflight.size > 0 && this.qw.clock() < hardDeadline) {
      await sleep(25);
    }
    try {
      const released = await this.storage.releaseWorkerLeases(this.workerId);
      if (released > 0) {
        this.qw.logger.warn("shutdown requeued unfinished jobs", {
          module: "worker",
          kv: { released },
        });
      }
    } catch (e) {
      this.logFrameworkError("could not release leases during shutdown", e);
    }
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    if (this.scheduler) await this.scheduler.stop();
    this.running = false;
    await this.loopPromise?.catch(() => {});
    this.qw.logger.info("worker stopped", { module: "worker", kv: { workerId: this.workerId } });
  }

  /** Blocks until SIGINT/SIGTERM. */
  async runUntilSignal(signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"]): Promise<void> {
    this.start();
    let fired = false;
    await new Promise<void>((resolve) => {
      const onSignal = (): void => {
        if (fired) return;
        fired = true;
        resolve();
      };
      for (const s of signals) process.on(s, onSignal);
    }).then(() => this.stop());
  }
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? "null";
  } catch {
    return '"[unserializable result]"';
  }
}

function errFields(e: unknown): { name: string; message: string; stack: string | null } {
  if (e instanceof Error) return { name: e.name, message: e.message, stack: e.stack ?? null };
  return { name: "NonErrorThrow", message: String(e), stack: null };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
