import type {
  AttemptRecord,
  ClaimRequest,
  CompletionSample,
  EnqueueInput,
  FailAttemptInput,
  IdempotencyOutcome,
  JobRecord,
  JobState,
  JobsPage,
  LifecycleEvent,
  ListJobsQuery,
  ScheduleRecord,
  SystemStats,
} from "../types.js";
import { MAX_ATTEMPTS_HISTORY, MAX_EVENTS_PER_JOB } from "../types.js";
import { assertTransition } from "../state-machine.js";
import { DuplicateJobError, JobNotFoundError, LeaseLostError, StorageUnavailableError } from "../errors.js";
import type {
  ConcurrencyLimit,
  PauseControl,
  RateLimitRule,
  RequeueOptions as RequeueOpts,
  ScheduleUpsertInput,
  StorageBackend,
  UpdatePayloadInput,
} from "./interface.js";
import {
  type BucketState,
  concurrencyAllows,
  newAttemptRecord,
  pushEvent,
  rulesForJob,
  takeBucket,
} from "./shared.js";

export interface MemoryStorageOptions {
  now?: () => number;
}

interface Store {
  seq: number;
  jobs: Map<string, JobRecord>;
  dedupe: Map<string, string>;
  idempotency: Map<string, { status: "pending" | "done"; result: string | null }>;
  schedules: Map<string, ScheduleRecord>;
  pausedQueues: Set<string>;
  globalPaused: boolean;
  completions: CompletionSample[];
}

function emptyStore(): Store {
  return {
    seq: 0,
    jobs: new Map(),
    dedupe: new Map(),
    idempotency: new Map(),
    schedules: new Map(),
    pausedQueues: new Set(),
    globalPaused: false,
    completions: [],
  };
}

export class MemoryStorage implements StorageBackend {
  readonly kind = "memory";
  private store: Store = emptyStore();
  private now: () => number;
  private closed = false;
  private rateRules: RateLimitRule[] = [];
  private concLimits: ConcurrencyLimit[] = [];
  private buckets = new Map<string, BucketState>();

  constructor(opts: MemoryStorageOptions = {}) {
    this.now = opts.now ?? Date.now;
  }

  async init(): Promise<void> {}
  async close(): Promise<void> {
    this.closed = true;
  }
  async ping(): Promise<boolean> {
    return !this.closed;
  }

  private assertOpen(): void {
    if (this.closed) throw new StorageUnavailableError(new Error("storage closed"));
  }

  async enqueue(input: EnqueueInput): Promise<JobRecord> {
    this.assertOpen();
    const t = this.now();
    const id = input.id ?? `j_${(this.store.seq++).toString(36).padStart(6, "0")}_${t.toString(36)}`;
    if (input.dedupeKey !== null && this.store.dedupe.has(input.dedupeKey)) {
      throw new DuplicateJobError(input.dedupeKey, this.store.dedupe.get(input.dedupeKey)!, id);
    }
    const state: JobState = input.runAt <= t ? "queued" : "scheduled";
    const job: JobRecord = {
      id,
      type: input.type,
      queue: input.queue,
      payload: input.payload,
      payloadVersion: input.payloadVersion,
      state,
      priority: input.priority,
      runAt: input.runAt,
      createdAt: t,
      updatedAt: t,
      attempts: 0,
      maxAttempts: input.maxAttempts,
      timeoutMs: input.timeoutMs,
      retry: input.retry,
      leaseUntil: null,
      leaseOwner: null,
      dedupeKey: input.dedupeKey,
      scheduleId: input.scheduleId,
      onSuccess: input.onSuccess,
      lastErrorName: null,
      lastErrorMessage: null,
      result: null,
      progress: null,
      events: [],
      attemptsHistory: [],
    };
    pushEvent(job, "enqueued", state === "scheduled" ? `runAt=${new Date(t).toISOString()}` : null, t);
    this.store.jobs.set(id, job);
    if (input.dedupeKey !== null) this.store.dedupe.set(input.dedupeKey, id);
    return structuredCloneJob(job);
  }

  async enqueueBatch(inputs: EnqueueInput[]): Promise<JobRecord[]> {
    for (const input of inputs) {
      if (input.dedupeKey !== null && this.store.dedupe.has(input.dedupeKey)) {
        throw new DuplicateJobError(
          input.dedupeKey,
          this.store.dedupe.get(input.dedupeKey)!,
          input.id ?? "batch-item",
        );
      }
    }
    const created: JobRecord[] = [];
    for (const input of inputs) created.push(await this.enqueue(input));
    return created;
  }

  async getJob(jobId: string): Promise<JobRecord | null> {
    this.assertOpen();
    const job = this.store.jobs.get(jobId);
    return job ? structuredCloneJob(job) : null;
  }

  async listJobs(query: ListJobsQuery): Promise<JobsPage> {
    this.assertOpen();
    let jobs = [...this.store.jobs.values()];
    if (query.states && query.states.length > 0) jobs = jobs.filter((j) => query.states!.includes(j.state));
    if (query.queue) jobs = jobs.filter((j) => j.queue === query.queue);
    if (query.type) jobs = jobs.filter((j) => j.type === query.type);
    if (query.search) {
      const s = query.search.toLowerCase();
      jobs = jobs.filter(
        (j) =>
          j.id.toLowerCase().includes(s) ||
          j.type.toLowerCase().includes(s) ||
          j.payload.toLowerCase().includes(s),
      );
    }
    jobs.sort((a, b) =>
      query.order === "created_asc"
        ? a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1)
        : b.createdAt - a.createdAt || (a.id < b.id ? -1 : 1),
    );
    let start = 0;
    if (query.cursor) {
      const idx = jobs.findIndex((j) => j.id === query.cursor);
      start = idx === -1 ? 0 : idx + 1;
    }
    const page = jobs.slice(start, start + query.limit);
    const nextCursor =
      page.length === query.limit && start + query.limit < jobs.length
        ? page[page.length - 1]!.id
        : null;
    return { jobs: page.map(structuredCloneJob), cursor: nextCursor };
  }

  async claim(req: ClaimRequest): Promise<JobRecord[]> {
    this.assertOpen();
    const t = this.now();
    if (this.store.globalPaused) return [];
    for (const job of this.store.jobs.values()) {
      if (
        (job.state === "scheduled" || job.state === "retrying") &&
        job.runAt <= t &&
        !this.store.pausedQueues.has(job.queue)
      ) {
        job.state = "queued";
        job.updatedAt = t;
      }
    }
    const wanted = new Set(req.queues);
    const candidates = [...this.store.jobs.values()]
      .filter((j) => j.state === "queued" && j.runAt <= t && wanted.has(j.queue))
      .sort(
        (a, b) =>
          b.priority - a.priority || a.runAt - b.runAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      );
    const runningByQueue = new Map<string, number>();
    const runningByType = new Map<string, number>();
    for (const j of this.store.jobs.values()) {
      if (j.state === "running") {
        runningByQueue.set(j.queue, (runningByQueue.get(j.queue) ?? 0) + 1);
        runningByType.set(j.type, (runningByType.get(j.type) ?? 0) + 1);
      }
    }
    const claimed: JobRecord[] = [];
    for (const job of candidates) {
      if (claimed.length >= req.limit) break;
      if (this.store.pausedQueues.has(job.queue)) continue;
      if (
        !concurrencyAllows(this.concLimits, { runningByQueue, runningByType }, job.queue, job.type)
      ) {
        continue;
      }
      let rateOk = true;
      for (const rule of rulesForJob(this.rateRules, job)) {
        if (!takeBucket(this.buckets, rule.key, rule.limit, rule.windowMs, t)) {
          rateOk = false;
          break;
        }
      }
      if (!rateOk) continue;
      job.state = "running";
      job.attempts += 1;
      job.leaseUntil = t + req.visibilityTimeoutMs;
      job.leaseOwner = req.workerId;
      job.updatedAt = t;
      newAttemptRecord(job, t);
      pushEvent(job, "claimed", `worker=${req.workerId} attempt=${job.attempts}`, t);
      runningByQueue.set(job.queue, (runningByQueue.get(job.queue) ?? 0) + 1);
      runningByType.set(job.type, (runningByType.get(job.type) ?? 0) + 1);
      claimed.push(structuredCloneJob(job));
    }
    return claimed;
  }

  private requireLease(jobId: string, workerId: string): JobRecord {
    const job = this.store.jobs.get(jobId);
    if (!job) throw new JobNotFoundError(jobId);
    if (job.state !== "running" || job.leaseOwner !== workerId) {
      throw new LeaseLostError(jobId, workerId);
    }
    return job;
  }

  async completeJob(jobId: string, workerId: string, result: string | null): Promise<void> {
    this.assertOpen();
    const t = this.now();
    const job = this.requireLease(jobId, workerId);
    assertTransition(jobId, job.state, "succeeded");
    job.state = "succeeded";
    job.result = result;
    job.leaseUntil = null;
    job.leaseOwner = null;
    job.updatedAt = t;
    const rec = job.attemptsHistory[job.attemptsHistory.length - 1];
    if (rec) {
      rec.finishedAt = t;
      rec.durationMs = t - rec.startedAt;
      rec.outcome = "succeeded";
    }
    pushEvent(job, "completed", `attempt=${job.attempts}`, t);
    this.store.completions.push({
      finishedAt: t,
      durationMs: rec?.durationMs ?? 0,
      outcome: "succeeded",
      queue: job.queue,
      type: job.type,
    });
    this.releaseDedupe(job);
  }

  async failAttempt(input: FailAttemptInput): Promise<"retrying" | "dead" | "failed"> {
    this.assertOpen();
    const t = this.now();
    const job = this.requireLease(input.jobId, input.workerId);
    const rec = job.attemptsHistory[job.attemptsHistory.length - 1];
    if (rec) {
      rec.finishedAt = t;
      rec.durationMs = t - rec.startedAt;
      rec.outcome = input.timedOut ? "timeout" : "failed";
      rec.errorName = input.errorName;
      rec.errorMessage = input.errorMessage;
      rec.stack = input.stack;
    }
    job.lastErrorName = input.errorName;
    job.lastErrorMessage = input.errorMessage;
    job.leaseUntil = null;
    job.leaseOwner = null;
    job.updatedAt = t;
    pushEvent(job, "attempt_failed", `attempt=${job.attempts} err=${input.errorName}`, t);
    this.store.completions.push({
      finishedAt: t,
      durationMs: rec?.durationMs ?? 0,
      outcome: "failed",
      queue: job.queue,
      type: job.type,
    });
    const exhausted = job.attempts >= job.maxAttempts;
    let target: "retrying" | "dead" | "failed";
    if (input.fatal) {
      target = "failed";
    } else if (exhausted) {
      target = "dead";
    } else {
      target = "retrying";
    }
    assertTransition(job.id, job.state, target);
    job.state = target;
    if (target === "retrying") {
      job.runAt = input.nextRunAt ?? t;
      pushEvent(job, "retry_scheduled", `nextRunAt=${new Date(job.runAt).toISOString()}`, t);
    } else if (target === "dead") {
      pushEvent(job, "moved_to_dead", `attempts=${job.attempts}/${job.maxAttempts}`, t);
    } else {
      pushEvent(job, "moved_to_failed", `err=${input.errorName}`, t);
    }
    return target;
  }

  async heartbeat(jobId: string, workerId: string, untilMs: number): Promise<void> {
    this.assertOpen();
    const job = this.requireLease(jobId, workerId);
    if (untilMs > (job.leaseUntil ?? 0)) job.leaseUntil = untilMs;
    job.updatedAt = this.now();
  }

  async reclaimExpired(): Promise<number> {
    this.assertOpen();
    const t = this.now();
    let n = 0;
    for (const job of this.store.jobs.values()) {
      if (job.state === "running" && job.leaseUntil !== null && job.leaseUntil < t) {
        assertTransition(job.id, job.state, "queued");
        const rec = job.attemptsHistory[job.attemptsHistory.length - 1];
        if (rec && rec.outcome === "running") rec.outcome = "interrupted";
        job.state = "queued";
        job.runAt = t;
        job.leaseUntil = null;
        job.leaseOwner = null;
        job.updatedAt = t;
        pushEvent(job, "reclaimed", `attempt=${job.attempts}`, t);
        n++;
      }
    }
    return n;
  }

  async releaseWorkerLeases(workerId: string): Promise<number> {
    this.assertOpen();
    const t = this.now();
    let n = 0;
    for (const job of this.store.jobs.values()) {
      if (job.state === "running" && job.leaseOwner === workerId) {
        const rec = job.attemptsHistory[job.attemptsHistory.length - 1];
        if (rec && rec.outcome === "running") rec.outcome = "interrupted";
        job.state = "queued";
        job.runAt = t;
        job.leaseUntil = null;
        job.leaseOwner = null;
        job.updatedAt = t;
        pushEvent(job, "lease_released", `worker=${workerId}`, t);
        n++;
      }
    }
    return n;
  }

  async cancelJob(jobId: string): Promise<JobRecord> {
    this.assertOpen();
    const t = this.now();
    const job = this.store.jobs.get(jobId);
    if (!job) throw new JobNotFoundError(jobId);
    assertTransition(jobId, job.state, "cancelled");
    job.state = "cancelled";
    job.leaseUntil = null;
    job.leaseOwner = null;
    job.updatedAt = t;
    pushEvent(job, "cancelled", null, t);
    this.releaseDedupe(job);
    return structuredCloneJob(job);
  }

  async requeueJob(jobId: string, opts: RequeueOpts): Promise<JobRecord> {
    this.assertOpen();
    const t = this.now();
    const job = this.store.jobs.get(jobId);
    if (!job) throw new JobNotFoundError(jobId);
    assertTransition(jobId, job.state, "queued");
    if (opts.resetAttempts) job.attempts = 0;
    if (opts.payload) {
      job.payload = opts.payload.payload;
      job.payloadVersion = opts.payload.payloadVersion;
      pushEvent(job, "payload_updated", null, t);
    }
    if (opts.priority !== null && opts.priority !== undefined) job.priority = opts.priority;
    job.state = "queued";
    job.runAt = t;
    job.leaseUntil = null;
    job.leaseOwner = null;
    job.result = null;
    job.updatedAt = t;
    pushEvent(job, "requeued", opts.resetAttempts ? "attempts reset" : null, t);
    if (job.dedupeKey !== null) this.store.dedupe.set(job.dedupeKey, job.id);
    return structuredCloneJob(job);
  }

  async updatePayload(input: UpdatePayloadInput): Promise<JobRecord> {
    this.assertOpen();
    const t = this.now();
    const job = this.store.jobs.get(input.jobId);
    if (!job) throw new JobNotFoundError(input.jobId);
    job.payload = input.payload;
    job.payloadVersion = input.payloadVersion;
    job.updatedAt = t;
    pushEvent(job, "payload_updated", null, t);
    return structuredCloneJob(job);
  }

  async purgeRetention(olderThanMs: number): Promise<number> {
    this.assertOpen();
    const terminal: JobState[] = ["succeeded", "failed", "dead", "cancelled"];
    let n = 0;
    for (const [id, job] of [...this.store.jobs.entries()]) {
      if (terminal.includes(job.state) && job.updatedAt < olderThanMs) {
        this.store.jobs.delete(id);
        n++;
      }
    }
    this.store.completions = this.store.completions.filter((c) => c.finishedAt >= olderThanMs);
    return n;
  }

  async stats(): Promise<SystemStats> {
    this.assertOpen();
    const states: Record<JobState, number> = {
      queued: 0, scheduled: 0, running: 0, succeeded: 0, failed: 0, retrying: 0, dead: 0, cancelled: 0,
    };
    const queues = new Map<string, SystemStats["queues"][number]>();
    const types = new Map<string, { type: string; total: number; dead: number; failed: number }>();
    let oldestQueuedAt: number | null = null;
    for (const job of this.store.jobs.values()) {
      states[job.state]++;
      let q = queues.get(job.queue);
      if (!q) {
        q = { queue: job.queue, queued: 0, scheduled: 0, running: 0, retrying: 0, dead: 0, failed: 0, succeeded: 0, cancelled: 0 };
        queues.set(job.queue, q);
      }
      q[job.state]++;
      let ty = types.get(job.type);
      if (!ty) {
        ty = { type: job.type, total: 0, dead: 0, failed: 0 };
        types.set(job.type, ty);
      }
      ty.total++;
      if (job.state === "dead") ty.dead++;
      if (job.state === "failed") ty.failed++;
      if (job.state === "queued") {
        oldestQueuedAt = oldestQueuedAt === null ? job.createdAt : Math.min(oldestQueuedAt, job.createdAt);
      }
    }
    return {
      states,
      queues: [...queues.values()],
      types: [...types.values()].sort((a, b) => b.total - a.total),
      globalPaused: this.store.globalPaused,
      pausedQueues: [...this.store.pausedQueues],
      oldestQueuedAt,
    };
  }

  async completionSamples(fromMs: number, toMs: number): Promise<CompletionSample[]> {
    this.assertOpen();
    return this.store.completions.filter((c) => c.finishedAt >= fromMs && c.finishedAt <= toMs);
  }

  async takeRateToken(key: string, limit: number, windowMs: number): Promise<boolean> {
    this.assertOpen();
    return takeBucket(this.buckets, key, limit, windowMs, this.now());
  }

  async setRateRules(rules: RateLimitRule[]): Promise<void> {
    this.rateRules = [...rules];
  }

  async getRateRules(): Promise<RateLimitRule[]> {
    return [...this.rateRules];
  }

  async setConcurrencyLimits(limits: ConcurrencyLimit[]): Promise<void> {
    this.concLimits = [...limits];
  }

  async getConcurrencyLimits(): Promise<ConcurrencyLimit[]> {
    return [...this.concLimits];
  }

  async beginIdempotency(key: string): Promise<IdempotencyOutcome<string>> {
    this.assertOpen();
    const existing = this.store.idempotency.get(key);
    if (existing?.status === "done") return { status: "done", result: existing.result! };
    this.store.idempotency.set(key, { status: "pending", result: null });
    return { status: "run" };
  }

  async completeIdempotency(key: string, result: string): Promise<void> {
    this.assertOpen();
    const existing = this.store.idempotency.get(key);
    if (existing?.status === "done") return;
    this.store.idempotency.set(key, { status: "done", result });
  }

  async releaseIdempotency(key: string): Promise<void> {
    this.assertOpen();
    this.store.idempotency.delete(key);
  }

  async listAttempts(jobId: string): Promise<AttemptRecord[]> {
    const job = await this.getJob(jobId);
    if (!job) throw new JobNotFoundError(jobId);
    return job.attemptsHistory;
  }

  async createSchedule(input: ScheduleUpsertInput): Promise<ScheduleRecord> {
    this.assertOpen();
    if (this.store.schedules.has(input.id)) {
      throw new Error(`schedule "${input.id}" already exists`);
    }
    const rec: ScheduleRecord = {
      ...input,
      createdAt: this.now(),
      lastFiredAt: null,
      nextFireAt: null,
    };
    this.store.schedules.set(input.id, rec);
    return { ...rec };
  }

  async updateSchedule(id: string, patch: Partial<ScheduleUpsertInput>): Promise<ScheduleRecord> {
    this.assertOpen();
    const rec = this.store.schedules.get(id);
    if (!rec) throw new JobNotFoundError(id);
    Object.assign(rec, patch);
    return { ...rec };
  }

  async deleteSchedule(id: string): Promise<void> {
    this.assertOpen();
    this.store.schedules.delete(id);
  }

  async listSchedules(): Promise<ScheduleRecord[]> {
    this.assertOpen();
    return [...this.store.schedules.values()].map((s) => ({ ...s }));
  }

  async getSchedule(id: string): Promise<ScheduleRecord | null> {
    this.assertOpen();
    const s = this.store.schedules.get(id);
    return s ? { ...s } : null;
  }

  async recordScheduleFires(scheduleId: string, fireTimes: number[], nextFireAt: number): Promise<JobRecord[]> {
    this.assertOpen();
    const sched = this.store.schedules.get(scheduleId);
    if (!sched) throw new JobNotFoundError(scheduleId);
    const t = this.now();
    const created: JobRecord[] = [];
    for (const fireAt of fireTimes) {
      const job = await this.enqueue({
        type: sched.jobType,
        queue: sched.queue,
        payload: sched.payload,
        payloadVersion: 1,
        priority: sched.priority,
        runAt: fireAt <= t ? t : fireAt,
        maxAttempts: sched.maxAttempts,
        timeoutMs: sched.timeoutMs,
        retry: sched.retry,
        dedupeKey: null,
        scheduleId,
        onSuccess: null,
      });
      job.scheduleId = scheduleId;
      pushEvent(job, "schedule_fired", `schedule=${scheduleId}`, t);
      created.push(job);
    }
    sched.lastFiredAt = fireTimes.length > 0 ? fireTimes[fireTimes.length - 1]! : t;
    sched.nextFireAt = nextFireAt;
    return created;
  }

  async setPaused(control: PauseControl): Promise<void> {
    this.assertOpen();
    if (control.scope === "global") this.store.globalPaused = control.paused;
    else if (control.paused) this.store.pausedQueues.add(control.queue!);
    else this.store.pausedQueues.delete(control.queue!);
  }

  async getJobEvents(jobId: string): Promise<Array<{ ts: number; event: string; detail: string | null }>> {
    const job = await this.getJob(jobId);
    if (!job) throw new JobNotFoundError(jobId);
    return job.events.map((e) => ({ ts: e.ts, event: e.event, detail: e.detail }));
  }

  private releaseDedupe(job: JobRecord): void {
    if (job.dedupeKey !== null && this.store.dedupe.get(job.dedupeKey) === job.id) {
      this.store.dedupe.delete(job.dedupeKey);
    }
  }
}

function structuredCloneJob(job: JobRecord): JobRecord {
  return JSON.parse(JSON.stringify(job)) as JobRecord;
}
