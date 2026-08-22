import type {
  JobRecord,
  RetryPolicy,
} from "../types.js";
import { MAX_ATTEMPTS_HISTORY, MAX_EVENTS_PER_JOB } from "../types.js";
import type { ConcurrencyLimit, RateLimitRule } from "./interface.js";

export interface BucketState {
  windowStart: number;
  tokens: number;
}

export function takeBucket(
  buckets: Map<string, BucketState>,
  key: string,
  limit: number,
  windowMs: number,
  now: number,
): boolean {
  const b = buckets.get(key);
  if (!b || now - b.windowStart >= windowMs) {
    buckets.set(key, { windowStart: now, tokens: limit - 1 });
    return true;
  }
  if (b.tokens > 0) {
    b.tokens -= 1;
    return true;
  }
  return false;
}

export function rulesForJob(
  rules: RateLimitRule[],
  job: Pick<JobRecord, "queue" | "type">,
): RateLimitRule[] {
  return rules.filter(
    (r) => r.key === `queue:${job.queue}` || r.key === `type:${job.type}`,
  );
}

export interface ConcurrencyCounts {
  runningByQueue: Map<string, number>;
  runningByType: Map<string, number>;
}

export function concurrencyAllows(
  limits: ConcurrencyLimit[],
  counts: ConcurrencyCounts,
  queue: string,
  type: string,
): boolean {
  for (const l of limits) {
    if (l.key === `queue:${queue}` && (counts.runningByQueue.get(queue) ?? 0) >= l.max) return false;
    if (l.key === `type:${type}` && (counts.runningByType.get(type) ?? 0) >= l.max) return false;
  }
  return true;
}

export function pushEvent(
  job: JobRecord,
  event: LifecycleEventName_,
  detail: string | null,
  now: number,
): void {
  job.events.push({ ts: now, event, detail });
  if (job.events.length > MAX_EVENTS_PER_JOB) {
    job.events.splice(0, job.events.length - MAX_EVENTS_PER_JOB);
  }
}

type LifecycleEventName_ = JobRecord["events"][number]["event"];

export function decideFailTarget(job: Pick<JobRecord, "attempts" | "maxAttempts">, fatal: boolean): "retrying" | "dead" | "failed" {
  if (fatal) return "failed";
  return job.attempts >= job.maxAttempts ? "dead" : "retrying";
}

export function newAttemptRecord(job: JobRecord, startedAt: number): void {
  job.attemptsHistory.push({
    attempt: job.attempts,
    startedAt,
    finishedAt: null,
    durationMs: null,
    outcome: "running",
    errorName: null,
    errorMessage: null,
    stack: null,
  });
  if (job.attemptsHistory.length > MAX_ATTEMPTS_HISTORY) {
    job.attemptsHistory.splice(0, job.attemptsHistory.length - MAX_ATTEMPTS_HISTORY);
  }
}

export const DEFAULT_RETRY_SNAPSHOT: RetryPolicy = {
  strategy: "exponential",
  baseDelayMs: 1000,
  maxDelayMs: 60000,
  jitter: "full",
};
