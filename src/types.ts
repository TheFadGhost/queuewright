export const JOB_STATES = [
  "queued",
  "scheduled",
  "running",
  "succeeded",
  "failed",
  "retrying",
  "dead",
  "cancelled",
] as const;

export type JobState = (typeof JOB_STATES)[number];

export const TERMINAL_STATES: readonly JobState[] = [
  "succeeded",
  "failed",
  "dead",
  "cancelled",
];

export function isTerminal(state: JobState): boolean {
  return TERMINAL_STATES.includes(state);
}

export type RetryStrategy = "exponential" | "linear" | "fixed";
export type JitterMode = "full" | "equal" | "none";

export interface RetryPolicy {
  strategy: RetryStrategy;
  baseDelayMs: number;
  maxDelayMs: number;
  jitter: JitterMode;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  strategy: "exponential",
  baseDelayMs: 1_000,
  maxDelayMs: 60_000,
  jitter: "full",
};

export interface AttemptRecord {
  attempt: number;
  startedAt: number;
  finishedAt: number | null;
  durationMs: number | null;
  outcome: "running" | "succeeded" | "failed" | "timeout" | "interrupted";
  errorName: string | null;
  errorMessage: string | null;
  stack: string | null;
}

export type LifecycleEventName =
  | "enqueued"
  | "claimed"
  | "heartbeat"
  | "progress"
  | "completed"
  | "attempt_failed"
  | "retry_scheduled"
  | "moved_to_dead"
  | "moved_to_failed"
  | "reclaimed"
  | "requeued"
  | "cancelled"
  | "payload_updated"
  | "schedule_fired"
  | "lease_released";

export interface LifecycleEvent {
  ts: number;
  event: LifecycleEventName;
  detail: string | null;
}

export interface ProgressInfo {
  fraction: number;
  note: string | null;
  at: number;
}

export interface JobRecord {
  id: string;
  type: string;
  queue: string;
  payload: string;
  payloadVersion: number;
  state: JobState;
  priority: number;
  runAt: number;
  createdAt: number;
  updatedAt: number;
  attempts: number;
  maxAttempts: number;
  timeoutMs: number;
  retry: RetryPolicy;
  leaseUntil: number | null;
  leaseOwner: string | null;
  dedupeKey: string | null;
  scheduleId: string | null;
  onSuccess: string | null;
  lastErrorName: string | null;
  lastErrorMessage: string | null;
  result: string | null;
  progress: ProgressInfo | null;
  events: LifecycleEvent[];
  attemptsHistory: AttemptRecord[];
}

export type OnMissedPolicy = "catch_up" | "skip" | "run_once";

export interface ScheduleRecord {
  id: string;
  cron: string;
  timezone: string;
  jobType: string;
  queue: string;
  payload: string;
  priority: number;
  maxAttempts: number;
  timeoutMs: number;
  retry: RetryPolicy;
  onMissed: OnMissedPolicy;
  createdAt: number;
  paused: boolean;
  lastFiredAt: number | null;
  nextFireAt: number | null;
}

export interface EnqueueInput {
  id?: string;
  type: string;
  queue: string;
  payload: string;
  payloadVersion: number;
  priority: number;
  runAt: number;
  maxAttempts: number;
  timeoutMs: number;
  retry: RetryPolicy;
  dedupeKey: string | null;
  scheduleId: string | null;
  onSuccess: string | null;
}

export interface ClaimRequest {
  workerId: string;
  queues: string[];
  limit: number;
  visibilityTimeoutMs: number;
}

export interface ListJobsQuery {
  states?: JobState[];
  queue?: string;
  type?: string;
  search?: string;
  limit: number;
  cursor: string | null;
  order: "created_desc" | "created_asc";
}

export interface JobsPage {
  jobs: JobRecord[];
  cursor: string | null;
}

export interface QueueStat {
  queue: string;
  queued: number;
  scheduled: number;
  running: number;
  retrying: number;
  dead: number;
  failed: number;
  succeeded: number;
  cancelled: number;
}

export interface SystemStats {
  states: Record<JobState, number>;
  queues: QueueStat[];
  types: Array<{ type: string; total: number; dead: number; failed: number }>;
  globalPaused: boolean;
  pausedQueues: string[];
  oldestQueuedAt: number | null;
}

export interface CompletionSample {
  finishedAt: number;
  durationMs: number;
  outcome: "succeeded" | "failed" | "dead";
  queue: string;
  type: string;
}

export interface FailAttemptInput {
  jobId: string;
  workerId: string;
  errorName: string;
  errorMessage: string;
  stack: string | null;
  fatal: boolean;
  timedOut: boolean;
  nextRunAt: number | null;
}

export interface TypeBreakdownEntry {
  type: string;
  total: number;
  dead: number;
  failed: number;
}

export type IdempotencyOutcome<T> =
  | { status: "run" }
  | { status: "done"; result: T };

export const MAX_EVENTS_PER_JOB = 100;
export const MAX_ATTEMPTS_HISTORY = 100;

export function cloneJobRecord(job: JobRecord): JobRecord {
  return JSON.parse(JSON.stringify(job)) as JobRecord;
}
