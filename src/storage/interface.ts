import type {
  AttemptRecord,
  ClaimRequest,
  CompletionSample,
  EnqueueInput,
  FailAttemptInput,
  IdempotencyOutcome,
  JobRecord,
  JobsPage,
  ListJobsQuery,
  ScheduleRecord,
  SystemStats,
} from "../types.js";

export interface StorageOptions {
  now?: () => number;
}

export interface UpdatePayloadInput {
  jobId: string;
  payload: string;
  payloadVersion: number;
}

export interface RequeueOptions {
  resetAttempts: boolean;
  payload?: { payload: string; payloadVersion: number } | null;
  priority?: number | null;
}

export interface ScheduleUpsertInput {
  id: string;
  cron: string;
  timezone: string;
  jobType: string;
  queue: string;
  payload: string;
  priority: number;
  maxAttempts: number;
  timeoutMs: number;
  retry: ScheduleRecord["retry"];
  onMissed: ScheduleRecord["onMissed"];
  paused: boolean;
}

export interface PauseControl {
  scope: "global" | "queue";
  queue: string | null;
  paused: boolean;
}

/**
 * Token-bucket rule applied during claims. Key is either "queue:<name>" or
 * "type:<jobType>"; the bucket allows at most `limit` claims per `windowMs`.
 */
export interface RateLimitRule {
  key: string;
  limit: number;
  windowMs: number;
}

/** Cap on concurrently running jobs per "queue:<name>" or "type:<jobType>" key. */
export interface ConcurrencyLimit {
  key: string;
  max: number;
}

/**
 * The single contract every storage backend must implement.
 *
 * Concurrency contract: all mutating operations are atomic with respect to
 * other processes sharing the backend. `claim` must never hand the same job to
 * two workers, and every enqueued job must remain retrievable until it reaches
 * a terminal state and is purged by retention.
 *
 * Delivery contract: at-least-once. A claim followed by a crash without
 * completion must leave the job reclaimable after its lease expires.
 */
export interface StorageBackend {
  readonly kind: string;

  init(): Promise<void>;
  close(): Promise<void>;
  ping(): Promise<boolean>;

  enqueue(input: EnqueueInput): Promise<JobRecord>;
  enqueueBatch(inputs: EnqueueInput[]): Promise<JobRecord[]>;
  getJob(jobId: string): Promise<JobRecord | null>;
  listJobs(query: ListJobsQuery): Promise<JobsPage>;

  /**
   * Atomically move up to `limit` due queued jobs to running for this worker.
   * Respects paused queues/global pause, rate limit rules and concurrency caps.
   * Returns jobs in claim order (priority desc, runAt asc, insertion asc).
   */
  claim(req: ClaimRequest): Promise<JobRecord[]>;

  completeJob(
    jobId: string,
    workerId: string,
    result: string | null,
  ): Promise<void>;

  /**
   * Record a failed attempt. Moves the job to retrying (nextRunAt set), dead
   * (attempts exhausted) or failed (fatal). Throws LeaseLostError if the
   * worker no longer holds the lease.
   */
  failAttempt(input: FailAttemptInput): Promise<"retrying" | "dead" | "failed">;

  heartbeat(jobId: string, workerId: string, untilMs: number): Promise<void>;

  /** Requeue running jobs whose lease expired; returns count reclaimed. */
  reclaimExpired(): Promise<number>;

  /** Requeue running jobs owned by workerId (graceful shutdown); attempts preserved. */
  releaseWorkerLeases(workerId: string): Promise<number>;

  cancelJob(jobId: string): Promise<JobRecord>;
  requeueJob(jobId: string, opts: RequeueOptions): Promise<JobRecord>;
  updatePayload(input: UpdatePayloadInput): Promise<JobRecord>;

  purgeRetention(olderThanMs: number): Promise<number>;

  stats(): Promise<SystemStats>;
  completionSamples(fromMs: number, toMs: number): Promise<CompletionSample[]>;

  takeRateToken(key: string, limit: number, windowMs: number): Promise<boolean>;

  beginIdempotency(key: string): Promise<IdempotencyOutcome<string>>;
  completeIdempotency(key: string, result: string): Promise<void>;
  releaseIdempotency(key: string): Promise<void>;

  listAttempts(jobId: string): Promise<AttemptRecord[]>;

  createSchedule(input: ScheduleUpsertInput): Promise<ScheduleRecord>;
  updateSchedule(id: string, patch: Partial<ScheduleUpsertInput>): Promise<ScheduleRecord>;
  deleteSchedule(id: string): Promise<void>;
  listSchedules(): Promise<ScheduleRecord[]>;
  getSchedule(id: string): Promise<ScheduleRecord | null>;
  /** Atomically record fires and enqueue one job per fire time; returns created jobs. */
  recordScheduleFires(
    scheduleId: string,
    fireTimes: number[],
    nextFireAt: number,
  ): Promise<JobRecord[]>;

  setPaused(control: PauseControl): Promise<void>;

  setRateRules(rules: RateLimitRule[]): Promise<void>;
  getRateRules(): Promise<RateLimitRule[]>;
  setConcurrencyLimits(limits: ConcurrencyLimit[]): Promise<void>;
  getConcurrencyLimits(): Promise<ConcurrencyLimit[]>;
  takeRateToken(key: string, limit: number, windowMs: number): Promise<boolean>;

  /** Raw access used by the dashboard/API to render one full record. */
  getJobEvents(jobId: string): Promise<Array<{ ts: number; event: string; detail: string | null }>>;
}
