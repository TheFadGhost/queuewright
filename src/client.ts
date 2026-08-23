import {
  DEFAULTS,
  validateConfig,
  type QueuewrightConfig,
  type ScheduleInput,
} from "./config.js";
import { InvalidCronError, ConfigValidationError, InvalidNameError, InvalidTimezoneError, PayloadTooLargeError, UnregisteredJobTypeError } from "./errors.js";
import { isValidTimezone, parseCron } from "./cron.js";
import { Logger } from "./observability/logger.js";
import { MetricsRegistry } from "./observability/metrics.js";
import { findDefinition, type JobDefinition } from "./registry.js";
import type { StorageBackend, ConcurrencyLimit, PauseControl, RateLimitRule, RequeueOptions, ScheduleUpsertInput } from "./storage/index.js";
import type {
  ListJobsQuery,
  JobsPage,
  SystemStats,
} from "./types.js";
import type {
  JobRecord,
  CompletionSample,
  OnMissedPolicy,
  RetryPolicy,
  ScheduleRecord,
} from "./types.js";
import { MemoryStorage } from "./storage/memory.js";
import { SqliteStorage } from "./storage/sqlite.js";
import { Worker } from "./worker.js";
import { Scheduler } from "./scheduler.js";

export interface EnqueueOptions {
  delayMs?: number;
  runAt?: number;
  dedupeKey?: string;
  priority?: number;
  jobId?: string;
}

export interface QueuewrightTimeseriesPoint {
  bucketStart: number;
  succeeded: number;
  failed: number;
  durationsP50: number | null;
  durationsP95: number | null;
  durationsP99: number | null;
  missing: boolean;
}

export class Queuewright {
  readonly storage: StorageBackend;
  readonly metrics = new MetricsRegistry();
  readonly logger: Logger;
  readonly concurrency: number;
  readonly visibilityTimeoutMs: number;
  readonly pollIntervalMs: number;
  readonly maxPayloadBytes: number;
  readonly retentionMs: number;
  readonly shutdownDeadlineMs: number;
  readonly queues: string[];
  readonly clock: () => number;
  private ownsStorage: boolean;

  constructor(config: QueuewrightConfig = {}) {
    if (config.storageInstance === undefined) validateConfig(config);
    const storageCfg = config.storage ?? { kind: "sqlite" as const };
    this.ownsStorage = config.storageInstance === undefined;
    if (config.storageInstance !== undefined) {
      this.storage = config.storageInstance;
    } else if (storageCfg.kind === "memory") {
      this.storage = config.now ? new MemoryStorage({ now: config.now }) : new MemoryStorage();
    } else {
      this.storage = new SqliteStorage({
        file: storageCfg.file ?? "./data/queuewright.db",
        ...(config.now ? { now: config.now } : {}),
      });
    }
    this.queues = config.queues ?? [];
    this.clock = config.now ?? Date.now;
    this.logger = new Logger(config.log ?? {});
    this.concurrency = config.concurrency ?? DEFAULTS.concurrency;
    this.visibilityTimeoutMs = config.visibilityTimeoutMs ?? DEFAULTS.visibilityTimeoutMs;
    this.pollIntervalMs = config.pollIntervalMs ?? DEFAULTS.pollIntervalMs;
    this.maxPayloadBytes = config.maxPayloadBytes ?? DEFAULTS.maxPayloadBytes;
    this.retentionMs = config.retentionMs ?? DEFAULTS.retentionMs;
    this.shutdownDeadlineMs = config.shutdownDeadlineMs ?? DEFAULTS.shutdownDeadlineMs;
  }

  async init(): Promise<void> {
    await this.storage.init();
  }

  async close(): Promise<void> {
    await this.storage.close();
  }

  async enqueue<P>(def: JobDefinition<P>, payload: P, opts: EnqueueOptions = {}): Promise<JobRecord> {
    return this.enqueueRecord(def.type, def, JSON.stringify(payload), payload, opts);
  }

  async enqueueBatch<P>(
    items: Array<[JobDefinition<P>, P]>,
    opts: EnqueueOptions = {},
  ): Promise<JobRecord[]> {
    const t = this.clock();
    const inputs = items.map(([def, payload]) => {
      assertPayloadSize(this.maxPayloadBytes, def.type, JSON.stringify(payload));
      validate(def, payload);
      return buildEnqueueInput(
        def.type,
        def.options.queue,
        JSON.stringify(payload),
        def.options.version,
        opts.priority ?? def.options.priority,
        resolveRunAt(t, opts),
        def.options.retry,
        opts.dedupeKey ?? null,
        null,
        successorType(def),
        undefined,
        def.options.maxAttempts,
        def.options.timeoutMs,
      );
    });
    return this.storage.enqueueBatch(inputs);
  }

  async rawEnqueue(
    type: string,
    payloadJson: string,
    opts: EnqueueOptions & {
      queue?: string;
      maxAttempts?: number;
      timeoutMs?: number;
      retry?: RetryPolicy;
      allowUnregistered?: boolean;
    } = {},
  ): Promise<JobRecord> {
    const def = findDefinition(type);
    if (!def) {
      if (opts.allowUnregistered !== true) throw new UnregisteredJobTypeError(type, []);
    }
    validateRawEnqueue(type, payloadJson, opts);
    return this.enqueueRecord(type, def, payloadJson, undefined, opts);
  }

  private async enqueueRecord(
    type: string,
    def: JobDefinition<never> | undefined,
    payloadJson: string,
    payload: unknown,
    opts: EnqueueOptions & { queue?: string; maxAttempts?: number; timeoutMs?: number; retry?: RetryPolicy; allowUnregistered?: boolean },
  ): Promise<JobRecord> {
    assertPayloadSize(this.maxPayloadBytes, type, payloadJson);
    if (def && payload !== undefined) validate(def, payload);
    const t = this.clock();
    const record = await this.storage.enqueue(
      buildEnqueueInput(
        type,
        opts.queue ?? def?.options.queue ?? "default",
        payloadJson,
        def?.options.version ?? 1,
        opts.priority ?? def?.options.priority ?? 0,
        resolveRunAt(t, opts),
        opts.retry ?? def?.options.retry ?? { strategy: "exponential", baseDelayMs: 1000, maxDelayMs: 60_000, jitter: "full" },
        opts.dedupeKey ?? null,
        null,
        def ? successorType(def) : null,
        opts.jobId,
        opts.maxAttempts ?? def?.options.maxAttempts,
        opts.timeoutMs ?? def?.options.timeoutMs,
      ),
    );
    this.metrics.inc("qw_jobs_enqueued_total", [["queue", record.queue], ["type", record.type]]);
    return record;
  }

  getJob(id: string): Promise<JobRecord | null> {
    return this.storage.getJob(id);
  }
  listJobs(query: ListJobsQuery): Promise<JobsPage> {
    return this.storage.listJobs(query);
  }
  stats(): Promise<SystemStats> {
    return this.storage.stats();
  }
  async cancelJob(id: string): Promise<JobRecord> {
    return this.storage.cancelJob(id);
  }
  requeueJob(id: string, opts: RequeueOptions): Promise<JobRecord> {
    return this.storage.requeueJob(id, opts);
  }
  async retryDeadLetters(queue: string | null, limit = 10_000): Promise<number> {
    const query: ListJobsQuery = {
      states: ["dead"],
      limit,
      cursor: null,
      order: "created_asc",
    };
    if (queue !== null) query.queue = queue;
    const page = await this.storage.listJobs(query);
    let n = 0;
    for (const job of page.jobs) {
      try {
        await this.storage.requeueJob(job.id, { resetAttempts: true });
        n++;
      } catch {
        // raced into another state; skip
      }
    }
    return n;
  }
  completionSamples(fromMs: number, toMs: number): Promise<CompletionSample[]> {
    return this.storage.completionSamples(fromMs, toMs);
  }
  setPaused(control: PauseControl): Promise<void> {
    return this.storage.setPaused(control);
  }
  setRateRules(rules: RateLimitRule[]): Promise<void> {
    return this.storage.setRateRules(rules);
  }
  setConcurrencyLimits(limits: ConcurrencyLimit[]): Promise<void> {
    return this.storage.setConcurrencyLimits(limits);
  }

  /**
   * Aggregate completion samples into honest buckets. Buckets with no
   * completions are marked `missing` and must render as gaps.
   */
  async timeseries(windowMs: number, buckets: number, now = this.clock()): Promise<QueuewrightTimeseriesPoint[]> {
    const from = now - windowMs;
    const size = Math.floor(windowMs / buckets);
    const samples = await this.storage.completionSamples(from, now);
    const out: QueuewrightTimeseriesPoint[] = [];
    for (let i = 0; i < buckets; i++) {
      out.push({
        bucketStart: from + i * size,
        succeeded: 0,
        failed: 0,
        durationsP50: null,
        durationsP95: null,
        durationsP99: null,
        missing: true,
      });
    }
    const per = new Map<number, number[]>();
    for (const s of samples) {
      const idx = Math.min(buckets - 1, Math.floor((s.finishedAt - from) / size));
      const p = out[idx]!;
      p.missing = false;
      if (s.outcome === "succeeded") p.succeeded++;
      else p.failed++;
      const arr = per.get(idx) ?? [];
      arr.push(s.durationMs);
      per.set(idx, arr);
    }
    for (const [idx, arr] of per) {
      const sorted = [...arr].sort((a, b) => a - b);
      out[idx]!.durationsP50 = percentile(sorted, 0.5);
      out[idx]!.durationsP95 = percentile(sorted, 0.95);
      out[idx]!.durationsP99 = percentile(sorted, 0.99);
    }
    return out;
  }

  async createSchedule(input: ScheduleInput): Promise<ScheduleRecord> {
    parseCron(input.cron);
    const tz = input.timezone ?? "UTC";
    if (!isValidTimezone(tz)) throw new InvalidTimezoneError(tz);
    if (!/^[a-z0-9][a-z0-9-_]*$/.test(input.id)) {
      throw new InvalidNameError("schedule id", input.id, "[a-z0-9][a-z0-9-_]*");
    }
    if (!findDefinition(input.jobType)) throw new UnregisteredJobTypeError(input.jobType, []);
    const upsert: ScheduleUpsertInput = {
      id: input.id,
      cron: input.cron,
      timezone: tz,
      jobType: input.jobType,
      queue: input.queue ?? findDefinition(input.jobType)!.options.queue,
      payload: JSON.stringify(input.payload ?? {}),
      priority: input.priority ?? 0,
      maxAttempts: input.maxAttempts ?? 3,
      timeoutMs: input.timeoutMs ?? 30_000,
      retry: { strategy: "exponential", baseDelayMs: 1000, maxDelayMs: 60_000, jitter: "full" },
      onMissed: input.onMissed ?? "run_once",
      paused: input.paused ?? false,
    };
    return this.storage.createSchedule(upsert);
  }

  listSchedules(): Promise<ScheduleRecord[]> {
    return this.storage.listSchedules();
  }
  deleteSchedule(id: string): Promise<void> {
    return this.storage.deleteSchedule(id);
  }

  createWorker(): Worker {
    const worker = new Worker(this);
    const scheduler = new Scheduler(this, worker.workerId);
    worker.attachScheduler(scheduler);
    return worker;
  }

  /**
   * Apply rate rules, concurrency limits and config-file schedules. Throws
   * ConfigValidationError listing every schedule that could not be created -
   * startup problems are never silently swallowed.
   */
  async applyStartupRules(config: QueuewrightConfig): Promise<void> {
    if (config.rateRules) await this.setRateRules(config.rateRules);
    if (config.concurrencyLimits) await this.setConcurrencyLimits(config.concurrencyLimits);
    const failures: string[] = [];
    for (const s of config.schedules ?? []) {
      try {
        await this.createSchedule(s);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        failures.push(`schedules["${s.id}"]: ${msg.split("\n")[0]}`);
      }
    }
    if (failures.length > 0) {
      throw new ConfigValidationError(
        failures.map((f) => ({
          path: f.slice(0, f.indexOf(":")),
          expected: "a creatable schedule",
          got: f.slice(f.indexOf(":") + 2),
          fix: "correct the cron expression, timezone or duplicate id; existing schedules with the same id are kept",
        })),
      );
    }
  }
}

function percentile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}

function resolveRunAt(now: number, opts: EnqueueOptions): number {
  if (opts.runAt !== undefined) return opts.runAt;
  if (opts.delayMs !== undefined) return now + opts.delayMs;
  return now;
}

function assertPayloadSize(maxBytes: number, type: string, json: string): void {
  const size = Buffer.byteLength(json, "utf8");
  if (size > maxBytes) throw new PayloadTooLargeError(type, size, maxBytes, null);
}

const QUEUE_NAME_RE = /^[a-z0-9][a-z0-9-_]*$/;

/** Boundary validation for raw (string-typed) enqueues from ops tools. */
export function validateRawEnqueue(
  type: string,
  payloadJson: string,
  opts: { queue?: string; maxAttempts?: number; timeoutMs?: number; priority?: number },
): void {
  if (!JOB_TYPE_RE.test(type)) {
    throw new InvalidNameError("job type", type, String(JOB_TYPE_RE));
  }
  try {
    JSON.parse(payloadJson);
  } catch (e) {
    throw new Error(
      `payload for job type "${type}" is not valid JSON: ${e instanceof Error ? e.message : String(e)}. fix: pass compact JSON in --payload, e.g. '{"userId":"u_1"}'`,
    );
  }
  const queue = opts.queue ?? "default";
  if (!QUEUE_NAME_RE.test(queue)) {
    throw new InvalidNameError("queue name", queue, "[a-z0-9][a-z0-9-_]*");
  }
  if (opts.priority !== undefined && !Number.isInteger(opts.priority)) {
    throw new Error(`priority must be an integer, got ${opts.priority}. fix: omit --priority or pass a whole number`);
  }
  if (opts.maxAttempts !== undefined && (!Number.isInteger(opts.maxAttempts) || opts.maxAttempts < 1 || opts.maxAttempts > 1000)) {
    throw new Error(`maxAttempts must be an integer in [1,1000], got ${opts.maxAttempts}. fix: omit it to use the job definition's value or the default (3)`);
  }
  if (opts.timeoutMs !== undefined && (!Number.isInteger(opts.timeoutMs) || opts.timeoutMs < 1)) {
    throw new Error(`timeoutMs must be a positive integer, got ${opts.timeoutMs}. fix: omit it to use the default (30000)`);
  }
}

const JOB_TYPE_RE = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/;

function validate(def: JobDefinition<never>, payload: unknown): void {
  const v = def.options.validate;
  if (!v) return;
  const problem = v(payload);
  if (problem !== null) {
    throw new Error(
      `payload for job type "${def.type}" failed validation: ${problem}. fix: correct the payload or update the job's validate() function`,
    );
  }
}

function successorType(def: JobDefinition<never>): string | null {
  return def.options.onSuccess ? def.options.onSuccess.type : null;
}

export function buildEnqueueInput(
  type: string,
  queue: string,
  payloadJson: string,
  version: number,
  priority: number,
  runAt: number,
  retry: RetryPolicy,
  dedupeKey: string | null,
  scheduleId: string | null,
  onSuccess: string | null,
  jobId?: string,
  maxAttemptsOverride?: number,
  timeoutMsOverride?: number,
): import("./types.js").EnqueueInput {
  const input: import("./types.js").EnqueueInput = {
    type,
    queue,
    payload: payloadJson,
    payloadVersion: version,
    priority,
    runAt,
    maxAttempts: maxAttemptsOverride ?? 3,
    timeoutMs: timeoutMsOverride ?? 30_000,
    retry,
    dedupeKey,
    scheduleId,
    onSuccess,
  };
  if (jobId !== undefined) input.id = jobId;
  return input;
}

export type { OnMissedPolicy };
