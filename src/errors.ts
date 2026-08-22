export class QueuewrightError extends Error {
  readonly hint: string | null;

  constructor(message: string, hint: string | null = null) {
    super(message);
    this.name = this.constructor.name;
    this.hint = hint;
  }
}

export class ConfigValidationError extends QueuewrightError {
  readonly problems: Array<{ path: string; expected: string; got: string; fix: string }>;

  constructor(problems: Array<{ path: string; expected: string; got: string; fix: string }>) {
    const n = problems.length;
    const lines = problems.map(
      (p) => `  - ${p.path}: expected ${p.expected}, got ${p.got}.\n    fix: ${p.fix}`,
    );
    super(
      `${n} configuration problem${n === 1 ? "" : "s"}\n${lines.join("\n")}\ndocs: https://github.com/TheFadGhost/queuewright#configuration`,
    );
    this.problems = problems;
  }
}

export class UnregisteredJobTypeError extends QueuewrightError {
  constructor(type: string, known: string[]) {
    const sample = known.slice(0, 5).join(", ");
    super(
      `job type "${type}" is not registered`,
      known.length
        ? `register it with defineJob("${type}", handler) in this process before enqueuing, or use one of the registered types (${sample}${known.length > 5 ? ", ..." : ""})`
        : `no job types are registered in this process yet; call defineJob() before enqueueing "${type}"`,
    );
  }
}

export class DuplicateDefinitionError extends QueuewrightError {
  constructor(type: string) {
    super(
      `job type "${type}" is already defined`,
      `a job type may be defined once per process; reuse the existing definition object for "${type}" instead of calling defineJob again`,
    );
  }
}

export class PayloadTooLargeError extends QueuewrightError {
  constructor(type: string, sizeBytes: number, maxBytes: number, jobId: string | null) {
    super(
      `payload for job type "${type}" is ${sizeBytes} bytes, exceeding the maximum of ${maxBytes} bytes${jobId ? ` (job ${jobId})` : ""}`,
      `shrink the payload or raise maxPayloadBytes in the storage configuration; large blobs belong in object storage with the reference placed in the payload`,
    );
  }
}

export class DuplicateJobError extends QueuewrightError {
  readonly existingJobId: string;

  constructor(dedupeKey: string, existingJobId: string, jobId: string) {
    super(
      `an active job already exists with dedupeKey "${dedupeKey}" (existing job ${existingJobId}; new job ${jobId})`,
      `the duplicate was rejected to honour the deduplication contract; inspect job ${existingJobId} or wait for it to reach a terminal state before re-enqueuing key "${dedupeKey}"`,
    );
    this.existingJobId = existingJobId;
  }
}

export class JobNotFoundError extends QueuewrightError {
  constructor(jobId: string) {
    super(`job "${jobId}" not found`, `list jobs with "qw list" to find the correct id`);
  }
}

export class InvalidTransitionError extends QueuewrightError {
  constructor(jobId: string, from: string, to: string) {
    super(
      `job "${jobId}" cannot transition from "${from}" to "${to}"`,
      `check the current state of job ${jobId} ("qw get ${jobId}") - the state machine only permits legal transitions listed in DESIGN.md section on lifecycle`,
    );
  }
}

export class LeaseLostError extends QueuewrightError {
  constructor(jobId: string, workerId: string) {
    super(
      `worker "${workerId}" no longer holds the lease on job "${jobId}"`,
      `the job was reclaimed after a visibility timeout or completed by another path; no action needed if handlers are idempotent (they must be)`,
    );
  }
}

export class InvalidCronError extends QueuewrightError {
  constructor(expr: string, reason: string) {
    super(
      `invalid cron expression "${expr}": ${reason}`,
      `use 5 fields (min hour day-of-month month day-of-week) or 6 fields with leading seconds; e.g. "*/5 * * * *" or "0 9 * * MON-FRI"`,
    );
  }
}

export class InvalidTimezoneError extends QueuewrightError {
  constructor(tz: string) {
    super(
      `unknown timezone "${tz}"`,
      `use an IANA timezone name such as "UTC", "Europe/Berlin" or "America/New_York"; list candidates via Intl.supportedValuesOf("timeZone")`,
    );
  }
}

export class StorageUnavailableError extends QueuewrightError {
  constructor(cause: unknown) {
    super(
      `storage is unavailable: ${describeCause(cause)}`,
      `check that the storage backend is reachable and correctly configured; workers will keep retrying claims until it returns`,
    );
  }
}

export class DrainTimeoutError extends QueuewrightError {
  constructor(queue: string, remaining: number, timeoutMs: number) {
    super(
      `drain timed out after ${timeoutMs}ms: ${remaining} job(s) still pending in queue "${queue}"`,
      `inspect stuck jobs with "qw list --queue ${queue}" - they may be waiting on retries, a paused queue, or rate limits`,
    );
  }
}

export class WrappedThrowError extends QueuewrightError {
  readonly originalValue: unknown;

  constructor(value: unknown) {
    super(`handler threw a non-Error value: ${safeStringify(value)}`);
    this.originalValue = value;
  }
}

export class FatalJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FatalJobError";
  }
}

export class RateLimitConfigError extends QueuewrightError {
  constructor(detail: string) {
    super(`invalid rate limit configuration: ${detail}`);
  }
}

function describeCause(cause: unknown): string {
  if (cause instanceof Error) return `${cause.name}: ${cause.message}`;
  return safeStringify(cause);
}

export function safeStringify(value: unknown): string {
  try {
    const s = JSON.stringify(value);
    if (s === undefined) return String(value);
    return s.length > 500 ? s.slice(0, 497) + "..." : s;
  } catch {
    return "[unserializable]";
  }
}
