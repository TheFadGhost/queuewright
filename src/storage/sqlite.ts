import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
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
  ProgressInfo,
  ScheduleRecord,
  SystemStats,
} from "../types.js";
import { assertTransition } from "../state-machine.js";
import {
  DuplicateScheduleError,
  ScheduleNotFoundError,
  DuplicateJobError,
  JobNotFoundError,
  LeaseLostError,
  StorageUnavailableError,
} from "../errors.js";
import type {
  ConcurrencyLimit,
  PauseControl,
  RateLimitRule,
  RequeueOptions,
  ScheduleUpsertInput,
  StorageBackend,
  UpdatePayloadInput,
} from "./interface.js";
import { concurrencyAllows, decideFailTarget, decodeCursor, encodeCursor, newAttemptRecord, pushEvent, rulesForJob, takeBucket, type BucketState } from "./shared.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS qw_jobs (
  id TEXT PRIMARY KEY,
  seq INTEGER,
  type TEXT NOT NULL,
  queue TEXT NOT NULL,
  payload TEXT NOT NULL,
  payload_version INTEGER NOT NULL,
  state TEXT NOT NULL,
  priority INTEGER NOT NULL,
  run_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL,
  timeout_ms INTEGER NOT NULL,
  retry_json TEXT NOT NULL,
  lease_until INTEGER,
  lease_owner TEXT,
  dedupe_key TEXT,
  schedule_id TEXT,
  on_success TEXT,
  last_error_name TEXT,
  last_error_message TEXT,
  result TEXT,
  progress_json TEXT,
  events_json TEXT NOT NULL DEFAULT '[]',
  history_json TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS qw_jobs_claim ON qw_jobs (state, priority DESC, run_at);
CREATE UNIQUE INDEX IF NOT EXISTS qw_dedupe_active
  ON qw_jobs (dedupe_key)
  WHERE dedupe_key IS NOT NULL AND state IN ('queued','scheduled','running','retrying');
CREATE TABLE IF NOT EXISTS qw_completions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  finished_at INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  queue TEXT NOT NULL,
  type TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS qw_completions_time ON qw_completions (finished_at);
CREATE TABLE IF NOT EXISTS qw_idempotency (
  key TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  result TEXT,
  created_at INTEGER
);
CREATE TABLE IF NOT EXISTS qw_schedules (
  id TEXT PRIMARY KEY,
  cron TEXT NOT NULL,
  timezone TEXT NOT NULL,
  job_type TEXT NOT NULL,
  queue TEXT NOT NULL,
  payload TEXT NOT NULL,
  priority INTEGER NOT NULL,
  max_attempts INTEGER NOT NULL,
  timeout_ms INTEGER NOT NULL,
  retry_json TEXT NOT NULL,
  on_missed TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  paused INTEGER NOT NULL DEFAULT 0,
  last_fired_at INTEGER,
  next_fire_at INTEGER
);
CREATE TABLE IF NOT EXISTS qw_rate_buckets (
  key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  tokens REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS qw_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

const ACTIVE_STATES: JobState[] = ["queued", "scheduled", "running", "retrying"];

export interface SqliteStorageOptions {
  file?: string;
  now?: () => number;
}

interface JobRow {
  id: string; seq: number; type: string; queue: string; payload: string;
  payload_version: number; state: string; priority: number; run_at: number;
  created_at: number; updated_at: number; attempts: number; max_attempts: number;
  timeout_ms: number; retry_json: string; lease_until: number | null; lease_owner: string | null;
  dedupe_key: string | null; schedule_id: string | null; on_success: string | null;
  last_error_name: string | null; last_error_message: string | null; result: string | null;
  progress_json: string | null; events_json: string; history_json: string;
}

function rowToJob(r: JobRow): JobRecord {
  return {
    id: r.id,
    type: r.type,
    queue: r.queue,
    payload: r.payload,
    payloadVersion: r.payload_version,
    state: r.state as JobState,
    priority: r.priority,
    runAt: r.run_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    attempts: r.attempts,
    maxAttempts: r.max_attempts,
    timeoutMs: r.timeout_ms,
    retry: JSON.parse(r.retry_json),
    leaseUntil: r.lease_until,
    leaseOwner: r.lease_owner,
    dedupeKey: r.dedupe_key,
    scheduleId: r.schedule_id,
    onSuccess: r.on_success,
    lastErrorName: r.last_error_name,
    lastErrorMessage: r.last_error_message,
    result: r.result,
    progress: r.progress_json ? (JSON.parse(r.progress_json) as ProgressInfo) : null,
    events: JSON.parse(r.events_json) as LifecycleEvent[],
    attemptsHistory: JSON.parse(r.history_json) as AttemptRecord[],
  };
}

const JOB_COLUMNS = `id, seq, type, queue, payload, payload_version, state, priority, run_at,
  created_at, updated_at, attempts, max_attempts, timeout_ms, retry_json, lease_until, lease_owner,
  dedupe_key, schedule_id, on_success, last_error_name, last_error_message, result, progress_json,
  events_json, history_json`;

export class SqliteStorage implements StorageBackend {
  readonly kind = "sqlite";
  private db!: DatabaseSync;
  private readonly file: string;
  private now: () => number;
  private closed = false;

  constructor(opts: SqliteStorageOptions = {}) {
    this.file = opts.file ?? "./data/queuewright.db";
    this.now = opts.now ?? Date.now;
  }

  async init(): Promise<void> {
    if (this.file !== ":memory:") mkdirSync(dirname(this.file), { recursive: true });
    this.db = new DatabaseSync(this.file);
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA synchronous=NORMAL");
    this.db.exec("PRAGMA busy_timeout=5000");
    this.db.exec("PRAGMA foreign_keys=ON");
this.db.exec(SCHEMA);
    const idemCols = this.db.prepare(`PRAGMA table_info(qw_idempotency)`).all() as Array<{ name: string }>;
    if (!idemCols.some((c) => c.name === "created_at")) {
      this.db.exec(`ALTER TABLE qw_idempotency ADD COLUMN created_at INTEGER`);
    }
    this.db
      .prepare(`UPDATE qw_idempotency SET created_at=? WHERE created_at IS NULL`)
      .run(this.now());
  }

async close(): Promise<void> {
    if (!this.closed && this.db) {
      this.closed = true;
      this.db.close();
    } else {
      this.closed = true;
    }
  }

  async ping(): Promise<boolean> {
    try {
      this.db.prepare("SELECT 1").get();
      return true;
    } catch {
      return false;
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new StorageUnavailableError(new Error("storage closed"));
  }

  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* already rolled back */
      }
      throw e;
    }
  }

  async enqueue(input: EnqueueInput): Promise<JobRecord> {
    this.assertOpen();
    return this.tx(() => this.enqueueInTx(input));
  }

  async enqueueBatch(inputs: EnqueueInput[]): Promise<JobRecord[]> {
    this.assertOpen();
    return this.tx(() => inputs.map((i) => this.enqueueInTx(i)));
  }

  private enqueueInTx(input: EnqueueInput): JobRecord {
    const t = this.now();
    const id = input.id ?? `j_${t.toString(36)}_${Math.floor(Math.random() * 2 ** 40).toString(36)}`;
    if (input.dedupeKey !== null) {
      const existing = this.db
        .prepare(
          `SELECT id FROM qw_jobs WHERE dedupe_key=? AND state IN ('queued','scheduled','running','retrying')`,
        )
        .get(input.dedupeKey) as { id: string } | undefined;
      if (existing) throw new DuplicateJobError(input.dedupeKey, existing.id, id);
    }
    const state: JobState = input.runAt <= t ? "queued" : "scheduled";
    const seqRow = this.db.prepare("SELECT COALESCE(MAX(seq),0)+1 AS s FROM qw_jobs").get() as { s: number };
    const events: LifecycleEvent[] = [{ ts: t, event: "enqueued", detail: state === "scheduled" ? `runAt=${new Date(input.runAt).toISOString()}` : null }];
    this.db
      .prepare(
        `INSERT INTO qw_jobs (${JOB_COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id, seqRow.s, input.type, input.queue, input.payload, input.payloadVersion, state,
        input.priority, input.runAt, t, t, 0, input.maxAttempts, input.timeoutMs,
        JSON.stringify(input.retry), null, null, input.dedupeKey, input.scheduleId,
        input.onSuccess, null, null, null, null, JSON.stringify(events), JSON.stringify([]),
      );
    return this.getJobInTx(id)!;
  }

  private getJobInTx(jobId: string): JobRecord | undefined {
    const row = this.db.prepare(`SELECT ${JOB_COLUMNS} FROM qw_jobs WHERE id=?`).get(jobId) as JobRow | undefined;
    return row ? rowToJob(row) : undefined;
  }

  async getJob(jobId: string): Promise<JobRecord | null> {
    this.assertOpen();
    return this.getJobInTx(jobId) ?? null;
  }

  async listJobs(query: ListJobsQuery): Promise<JobsPage> {
    this.assertOpen();
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (query.states && query.states.length > 0 && query.states.length < 8) {
      where.push(`state IN (${query.states.map(() => "?").join(",")})`);
      params.push(...query.states);
    }
    if (query.queue) {
      where.push("queue=?");
      params.push(query.queue);
    }
    if (query.type) {
      where.push("type=?");
      params.push(query.type);
    }
    if (query.search) {
      where.push("(id LIKE ? ESCAPE '\\' OR type LIKE ? ESCAPE '\\' OR payload LIKE ? ESCAPE '\\')");
      const like = `%${escapeLike(query.search)}%`;
      params.push(like, like, like);
    }
    if (query.cursor) {
      const cur = decodeCursor(query.cursor);
      if (cur) {
        const cmp = query.order === "created_asc" ? ">" : "<";
        where.push(`(created_at ${cmp} ? OR (created_at = ? AND id ${cmp} ?))`);
        params.push(cur.createdAt, cur.createdAt, cur.id);
      }
    }
    const dir = query.order === "created_asc" ? "ASC" : "DESC";
    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const sql = `SELECT ${JOB_COLUMNS} FROM qw_jobs ${whereSql} ORDER BY created_at ${dir}, id ${dir} LIMIT ?`;
    const rows = this.db.prepare(sql).all(...params, query.limit + 1) as unknown as JobRow[];
    const hasMore = rows.length > query.limit;
    const page = rows.slice(0, query.limit).map(rowToJob);
    const last = page[page.length - 1];
    return { jobs: page, cursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : null };
  }

  async claim(req: ClaimRequest): Promise<JobRecord[]> {
    this.assertOpen();
    const claimed: JobRecord[] = [];
    this.tx(() => {
      const t = this.now();
      if ((this.metaGet("globalPaused") ?? "0") === "1") return;
      this.db
        .prepare(
          `UPDATE qw_jobs SET state='queued', updated_at=? WHERE state IN ('scheduled','retrying') AND run_at<=?`,
        )
        .run(t, t);
      const pausedQueues = new Set(JSON.parse(this.metaGet("pausedQueues") ?? "[]") as string[]);
      const rateRules = JSON.parse(this.metaGet("rateRules") ?? "[]") as RateLimitRule[];
      const concLimits = JSON.parse(this.metaGet("concLimits") ?? "[]") as ConcurrencyLimit[];
      const queueFilter = req.queues.length > 0;
      const wanted = req.queues.map(() => "?").join(",");
      const candidates = this.db
        .prepare(
          `SELECT ${JOB_COLUMNS} FROM qw_jobs WHERE state='queued' AND run_at<=? ${queueFilter ? `AND queue IN (${wanted})` : ""}
           ORDER BY priority DESC, run_at ASC, seq ASC LIMIT ?`,
        )
        .all(...(queueFilter ? [t, ...req.queues] : [t]), req.limit * 20 + 50) as unknown as JobRow[];
      const buckets = new Map<string, BucketState>();
      for (const row of this.db.prepare(`SELECT key, window_start, tokens FROM qw_rate_buckets`).all() as Array<{ key: string; window_start: number; tokens: number }>) {
        buckets.set(row.key, { windowStart: row.window_start, tokens: row.tokens });
      }
      let qCount: Map<string, number> | null = concLimits.length > 0 ? new Map() : null;
      let tCount: Map<string, number> | null = concLimits.length > 0 ? new Map() : null;
      if (qCount && tCount) {
        for (const r of this.db.prepare(`SELECT queue, COUNT(*) AS n FROM qw_jobs WHERE state='running' GROUP BY queue`).all() as Array<{ queue: string; n: number }>) {
          qCount.set(r.queue, r.n);
        }
        for (const r of this.db.prepare(`SELECT type, COUNT(*) AS n FROM qw_jobs WHERE state='running' GROUP BY type`).all() as Array<{ type: string; n: number }>) {
          tCount.set(r.type, r.n);
        }
      }
      const update = this.db.prepare(
        `UPDATE qw_jobs SET state='running', attempts=attempts+1, lease_until=?, lease_owner=?, updated_at=?,
         events_json=?, history_json=?, seq=seq WHERE id=? AND state='queued'`,
      );
      for (const row of candidates) {
        if (claimed.length >= req.limit) break;
        if (pausedQueues.has(row.queue)) continue;
        const job = rowToJob(row);
        if (
          !concurrencyAllows(concLimits, { runningByQueue: qCount ?? new Map(), runningByType: tCount ?? new Map() }, job.queue, job.type)
        ) {
          continue;
        }
        let rateOk = true;
        for (const rule of rulesForJob(rateRules, job)) {
          if (!takeBucket(buckets, rule.key, rule.limit, rule.windowMs, t)) {
            rateOk = false;
            break;
          }
        }
        if (!rateOk) continue;
        job.attempts += 1;
        job.leaseUntil = t + req.visibilityTimeoutMs;
        job.leaseOwner = req.workerId;
        job.updatedAt = t;
        newAttemptRecord(job, t);
        pushEvent(job, "claimed", `worker=${req.workerId} attempt=${job.attempts}`, t);
        update.run(
          job.leaseUntil, req.workerId, t, JSON.stringify(job.events), JSON.stringify(job.attemptsHistory), job.id,
        );
        const changes = this.db.prepare(`SELECT changes() AS c`).get() as { c: number };
        if (changes.c === 1) {
          claimed.push(job);
          if (qCount) qCount.set(job.queue, (qCount.get(job.queue) ?? 0) + 1);
          if (tCount) tCount.set(job.type, (tCount.get(job.type) ?? 0) + 1);
        }
      }
      const putBucket = this.db.prepare(
        `INSERT INTO qw_rate_buckets (key, window_start, tokens) VALUES (?,?,?)
         ON CONFLICT(key) DO UPDATE SET window_start=excluded.window_start, tokens=excluded.tokens`,
      );
      for (const [k, b] of buckets) putBucket.run(k, b.windowStart, b.tokens);
    });
    return claimed;
  }

  async completeJob(jobId: string, workerId: string, result: string | null): Promise<void> {
    this.assertOpen();
    this.tx(() => {
      const t = this.now();
      const job = this.requireLeaseInTx(jobId, workerId);
      assertTransition(jobId, job.state, "succeeded");
      const rec = lastAttempt(job);
      if (rec) {
        rec.finishedAt = t;
        rec.durationMs = t - rec.startedAt;
        rec.outcome = "succeeded";
      }
      pushEvent(job, "completed", `attempt=${job.attempts}`, t);
      this.db
        .prepare(
          `UPDATE qw_jobs SET state='succeeded', result=?, lease_until=NULL, lease_owner=NULL, updated_at=?, events_json=?, history_json=? WHERE id=? AND state='running' AND lease_owner=?`,
        )
        .run(result, t, JSON.stringify(job.events), JSON.stringify(job.attemptsHistory), jobId, workerId);
      const changes = this.db.prepare(`SELECT changes() AS c`).get() as { c: number };
      if (changes.c !== 1) throw new LeaseLostError(jobId, workerId);
      this.db
        .prepare(`INSERT INTO qw_completions (finished_at, duration_ms, outcome, queue, type) VALUES (?,?,?,?,?)`)
        .run(t, rec?.durationMs ?? 0, "succeeded", job.queue, job.type);
    });
  }

  async failAttempt(input: FailAttemptInput): Promise<"retrying" | "dead" | "failed"> {
    this.assertOpen();
    let target: "retrying" | "dead" | "failed" = "retrying";
    this.tx(() => {
      const t = this.now();
      const job = this.requireLeaseInTx(input.jobId, input.workerId);
      const rec = lastAttempt(job);
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
      target = decideFailTarget(job, input.fatal);
      assertTransition(job.id, job.state, target);
      const nextRunAt = target === "retrying" ? (input.nextRunAt ?? t) : job.runAt;
      pushEvent(job, "attempt_failed", `attempt=${job.attempts} err=${input.errorName}`, t);
      if (target === "retrying") {
        pushEvent(job, "retry_scheduled", `nextRunAt=${new Date(nextRunAt).toISOString()}`, t);
      } else if (target === "dead") {
        pushEvent(job, "moved_to_dead", `attempts=${job.attempts}/${job.maxAttempts}`, t);
      } else {
        pushEvent(job, "moved_to_failed", `err=${input.errorName}`, t);
      }
      this.db
        .prepare(
          `UPDATE qw_jobs SET state=?, run_at=?, lease_until=NULL, lease_owner=NULL, updated_at=?,
           last_error_name=?, last_error_message=?, events_json=?, history_json=? WHERE id=? AND state='running' AND lease_owner=?`,
        )
        .run(target, nextRunAt, t, input.errorName, input.errorMessage, JSON.stringify(job.events), JSON.stringify(job.attemptsHistory), input.jobId, input.workerId);
      const changes = this.db.prepare(`SELECT changes() AS c`).get() as { c: number };
      if (changes.c !== 1) throw new LeaseLostError(input.jobId, input.workerId);
      this.db
        .prepare(`INSERT INTO qw_completions (finished_at, duration_ms, outcome, queue, type) VALUES (?,?,?,?,?)`)
        .run(t, rec?.durationMs ?? 0, "failed", job.queue, job.type);
    });
    return target;
  }

  async heartbeat(jobId: string, workerId: string, untilMs: number, windowMs: number): Promise<void> {
    this.assertOpen();
    this.tx(() => {
      this.requireLeaseInTx(jobId, workerId);
      const capped = Math.min(untilMs, this.now() + windowMs);
      this.db
        .prepare(
          `UPDATE qw_jobs SET lease_until=MAX(COALESCE(lease_until,0),?), updated_at=? WHERE id=? AND state='running' AND lease_owner=?`,
        )
        .run(capped, this.now(), jobId, workerId);
      const changes = this.db.prepare(`SELECT changes() AS c`).get() as { c: number };
      if (changes.c !== 1) throw new LeaseLostError(jobId, workerId);
    });
  }

  async reclaimExpired(): Promise<number> {
    this.assertOpen();
    return this.tx(() => {
      const t = this.now();
      const rows = this.db
        .prepare(`SELECT ${JOB_COLUMNS} FROM qw_jobs WHERE state='running' AND lease_until IS NOT NULL AND lease_until<?`)
        .all(t) as unknown as JobRow[];
      for (const row of rows) {
        const job = rowToJob(row);
        const rec = lastAttempt(job);
        if (rec && rec.outcome === "running") rec.outcome = "interrupted";
        pushEvent(job, "reclaimed", `attempt=${job.attempts}`, t);
        this.db
          .prepare(
            `UPDATE qw_jobs SET state='queued', run_at=?, lease_until=NULL, lease_owner=NULL, updated_at=?, events_json=?, history_json=? WHERE id=? AND state='running'`,
          )
          .run(t, t, JSON.stringify(job.events), JSON.stringify(job.attemptsHistory), job.id);
      }
      return rows.length;
    });
  }

  async releaseWorkerLeases(workerId: string): Promise<number> {
    this.assertOpen();
    return this.tx(() => {
      const t = this.now();
      const rows = this.db
        .prepare(`SELECT ${JOB_COLUMNS} FROM qw_jobs WHERE state='running' AND lease_owner=?`)
        .all(workerId) as unknown as JobRow[];
      for (const row of rows) {
        const job = rowToJob(row);
        const rec = lastAttempt(job);
        if (rec && rec.outcome === "running") rec.outcome = "interrupted";
        pushEvent(job, "lease_released", `worker=${workerId}`, t);
        this.db
          .prepare(
            `UPDATE qw_jobs SET state='queued', run_at=?, lease_until=NULL, lease_owner=NULL, updated_at=?, events_json=?, history_json=? WHERE id=?`,
          )
          .run(t, t, JSON.stringify(job.events), JSON.stringify(job.attemptsHistory), job.id);
      }
      return rows.length;
    });
  }

  async cancelJob(jobId: string): Promise<JobRecord> {
    this.assertOpen();
    return this.tx(() => {
      const t = this.now();
      const job = this.getJobInTx(jobId);
      if (!job) throw new JobNotFoundError(jobId);
      assertTransition(jobId, job.state, "cancelled");
      pushEvent(job, "cancelled", null, t);
      this.db
        .prepare(
          `UPDATE qw_jobs SET state='cancelled', lease_until=NULL, lease_owner=NULL, updated_at=?, events_json=? WHERE id=?`,
        )
        .run(t, JSON.stringify(job.events), jobId);
      return this.getJobInTx(jobId)!;
    });
  }

  async requeueJob(jobId: string, opts: RequeueOptions): Promise<JobRecord> {
    this.assertOpen();
    return this.tx(() => {
      const t = this.now();
      const job = this.getJobInTx(jobId);
      if (!job) throw new JobNotFoundError(jobId);
      assertTransition(jobId, job.state, "queued");
      const reset = opts.resetAttempts;
      if (opts.payload) pushEvent(job, "payload_updated", null, t);
      pushEvent(job, "requeued", reset ? "attempts reset" : null, t);
      this.db
        .prepare(
          `UPDATE qw_jobs SET state='queued', run_at=?, attempts=?, lease_until=NULL, lease_owner=NULL, result=NULL, updated_at=?,
           priority=COALESCE(?, priority),
           payload=COALESCE(?, payload), payload_version=COALESCE(?, payload_version), events_json=? WHERE id=?`,
        )
        .run(
          t, reset ? 0 : job.attempts, t, opts.priority ?? null,
          opts.payload?.payload ?? null, opts.payload?.payloadVersion ?? null,
          JSON.stringify(job.events), jobId,
        );
      return this.getJobInTx(jobId)!;
    });
  }

  async updatePayload(input: UpdatePayloadInput): Promise<JobRecord> {
    this.assertOpen();
    return this.tx(() => {
      const t = this.now();
      const job = this.getJobInTx(input.jobId);
      if (!job) throw new JobNotFoundError(input.jobId);
      pushEvent(job, "payload_updated", null, t);
      this.db
        .prepare(`UPDATE qw_jobs SET payload=?, payload_version=?, updated_at=?, events_json=? WHERE id=?`)
        .run(input.payload, input.payloadVersion, t, JSON.stringify(job.events), input.jobId);
      return this.getJobInTx(input.jobId)!;
    });
  }

  async setProgress(jobId: string, fraction: number, note: string | null): Promise<void> {
    this.assertOpen();
    this.tx(() => {
      const t = this.now();
      const job = this.getJobInTx(jobId);
      if (!job || job.state !== "running") return;
      job.progress = { fraction, note, at: t };
      pushEvent(job, "progress", `${Math.round(fraction * 100)}%${note ? ` ${note}` : ""}`, t);
      this.db
        .prepare(`UPDATE qw_jobs SET progress_json=?, updated_at=?, events_json=? WHERE id=? AND state='running'`)
        .run(JSON.stringify(job.progress), t, JSON.stringify(job.events), jobId);
    });
  }

  async purgeRetention(olderThanMs: number): Promise<number> {
    this.assertOpen();
    return this.tx(() => {
      this.db
        .prepare(
          `DELETE FROM qw_jobs WHERE state IN ('succeeded','failed','dead','cancelled') AND updated_at<?`,
        )
        .run(olderThanMs);
      const c = this.db.prepare(`SELECT changes() AS c`).get() as { c: number };
      this.db.prepare(`DELETE FROM qw_completions WHERE finished_at<?`).run(olderThanMs);
      // Pending idempotency locks are only stale after an hour; a lock held by
      // a long-running execution must keep excluding concurrent runs.
      const lockCutoff = this.now() - 3_600_000;
      this.db
        .prepare(`DELETE FROM qw_idempotency WHERE (status='pending' AND created_at<?) OR (status='done' AND created_at<?)`)
        .run(lockCutoff, olderThanMs);
      return c.c;
    });
  }

  async stats(): Promise<SystemStats> {
    this.assertOpen();
    const states: Record<JobState, number> = {
      queued: 0, scheduled: 0, running: 0, succeeded: 0, failed: 0, retrying: 0, dead: 0, cancelled: 0,
    };
    for (const r of this.db.prepare(`SELECT state, COUNT(*) AS n FROM qw_jobs GROUP BY state`).all() as Array<{ state: string; n: number }>) {
      states[r.state as JobState] = r.n;
    }
    const queues = new Map<string, SystemStats["queues"][number]>();
    for (const r of this.db.prepare(`SELECT queue, state, COUNT(*) AS n FROM qw_jobs GROUP BY queue, state`).all() as Array<{ queue: string; state: string; n: number }>) {
      let q = queues.get(r.queue);
      if (!q) {
        q = { queue: r.queue, queued: 0, scheduled: 0, running: 0, retrying: 0, dead: 0, failed: 0, succeeded: 0, cancelled: 0 };
        queues.set(r.queue, q);
      }
      q[r.state as JobState] = r.n;
    }
    const types = new Map<string, { type: string; total: number; dead: number; failed: number }>();
    for (const r of this.db.prepare(`SELECT type, COUNT(*) AS total, SUM(CASE WHEN state='dead' THEN 1 ELSE 0 END) AS dead, SUM(CASE WHEN state='failed' THEN 1 ELSE 0 END) AS failed FROM qw_jobs GROUP BY type`).all() as Array<{ type: string; total: number; dead: number; failed: number }>) {
      types.set(r.type, { type: r.type, total: r.total, dead: Number(r.dead), failed: Number(r.failed) });
    }
    const oldest = this.db
      .prepare(`SELECT MIN(created_at) AS m FROM qw_jobs WHERE state='queued'`)
      .get() as { m: number | null };
    return {
      states,
      queues: [...queues.values()],
      types: [...types.values()].sort((a, b) => b.total - a.total),
      globalPaused: (this.metaGet("globalPaused") ?? "0") === "1",
      pausedQueues: JSON.parse(this.metaGet("pausedQueues") ?? "[]") as string[],
      oldestQueuedAt: oldest.m,
    };
  }

  async completionSamples(fromMs: number, toMs: number): Promise<CompletionSample[]> {
    this.assertOpen();
    const rows = this.db
      .prepare(`SELECT finished_at, duration_ms, outcome, queue, type FROM qw_completions WHERE finished_at>=? AND finished_at<=? ORDER BY id LIMIT 100000`)
      .all(fromMs, toMs) as Array<{ finished_at: number; duration_ms: number; outcome: string; queue: string; type: string }>;
    return rows.map((r) => ({
      finishedAt: r.finished_at,
      durationMs: r.duration_ms,
      outcome: r.outcome as CompletionSample["outcome"],
      queue: r.queue,
      type: r.type,
    }));
  }

  async takeRateToken(key: string, limit: number, windowMs: number): Promise<boolean> {
    this.assertOpen();
    return this.tx(() => {
      const t = this.now();
      const row = this.db.prepare(`SELECT window_start, tokens FROM qw_rate_buckets WHERE key=?`).get(key) as { window_start: number; tokens: number } | undefined;
      const buckets = new Map<string, BucketState>();
      if (row) buckets.set(key, { windowStart: row.window_start, tokens: row.tokens });
      const ok = takeBucket(buckets, key, limit, windowMs, t);
      const b = buckets.get(key)!;
      this.db
        .prepare(
          `INSERT INTO qw_rate_buckets (key, window_start, tokens) VALUES (?,?,?)
           ON CONFLICT(key) DO UPDATE SET window_start=excluded.window_start, tokens=excluded.tokens`,
        )
        .run(key, b.windowStart, b.tokens);
      return ok;
    });
  }

  async beginIdempotency(key: string): Promise<IdempotencyOutcome<string>> {
    this.assertOpen();
    return this.tx(() => {
      const row = this.db.prepare(`SELECT status, result FROM qw_idempotency WHERE key=?`).get(key) as
        | { status: string; result: string | null }
        | undefined;
      if (row?.status === "done") return { status: "done", result: row.result! } as const;
      if (row?.status === "pending") return { status: "busy" } as const;
      try {
        this.db.prepare(`INSERT INTO qw_idempotency (key, status, result, created_at) VALUES (?,'pending',NULL,?)`).run(key, this.now());
        return { status: "run" } as const;
      } catch {
        return { status: "busy" } as const;
      }
    });
  }

  async completeIdempotency(key: string, result: string): Promise<void> {
    this.assertOpen();
    this.tx(() => {
      const row = this.db.prepare(`SELECT status FROM qw_idempotency WHERE key=?`).get(key) as { status: string } | undefined;
      if (row?.status === "done") return;
      this.db
        .prepare(`INSERT INTO qw_idempotency (key, status, result, created_at) VALUES (?,'done',?,?)
                  ON CONFLICT(key) DO UPDATE SET status='done', result=excluded.result, created_at=excluded.created_at`)
        .run(key, result, this.now());
    });
  }

  async releaseIdempotency(key: string): Promise<void> {
    this.assertOpen();
    this.db.prepare(`DELETE FROM qw_idempotency WHERE key=? AND status='pending'`).run(key);
  }

  async listAttempts(jobId: string): Promise<AttemptRecord[]> {
    const job = await this.getJob(jobId);
    if (!job) throw new JobNotFoundError(jobId);
    return job.attemptsHistory;
  }

  async createSchedule(input: ScheduleUpsertInput): Promise<ScheduleRecord> {
    this.assertOpen();
    return this.tx(() => {
      const existing = this.getScheduleInTx(input.id);
      if (existing) throw new DuplicateScheduleError(input.id);
      this.db
        .prepare(
          `INSERT INTO qw_schedules (id, cron, timezone, job_type, queue, payload, priority, max_attempts, timeout_ms, retry_json, on_missed, created_at, paused)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          input.id, input.cron, input.timezone, input.jobType, input.queue, input.payload,
          input.priority, input.maxAttempts, input.timeoutMs, JSON.stringify(input.retry),
          input.onMissed, this.now(), input.paused ? 1 : 0,
        );
      return this.getScheduleInTx(input.id)!;
    });
  }

  async updateSchedule(id: string, patch: Partial<ScheduleUpsertInput>): Promise<ScheduleRecord> {
    this.assertOpen();
    return this.tx(() => {
      const existing = this.getScheduleInTx(id);
      if (!existing) throw new ScheduleNotFoundError(id);
      const merged = { ...existing, ...patch };
      this.db
        .prepare(
          `UPDATE qw_schedules SET cron=?, timezone=?, job_type=?, queue=?, payload=?, priority=?, max_attempts=?, timeout_ms=?, retry_json=?, on_missed=?, paused=? WHERE id=?`,
        )
        .run(
          merged.cron, merged.timezone, merged.jobType, merged.queue, merged.payload,
          merged.priority, merged.maxAttempts, merged.timeoutMs, JSON.stringify(merged.retry),
          merged.onMissed, merged.paused ? 1 : 0, id,
        );
      return this.getScheduleInTx(id)!;
    });
  }

  async deleteSchedule(id: string): Promise<void> {
    this.assertOpen();
    this.db.prepare(`DELETE FROM qw_schedules WHERE id=?`).run(id);
  }

  async listSchedules(): Promise<ScheduleRecord[]> {
    this.assertOpen();
    return [...this.allSchedulesInTx()];
  }

  private allSchedulesInTx(): ScheduleRecord[] {
    const rows = this.db.prepare(`SELECT * FROM qw_schedules ORDER BY created_at`).all() as unknown as ScheduleRow[];
    return rows.map(rowToSchedule);
  }

  async getSchedule(id: string): Promise<ScheduleRecord | null> {
    this.assertOpen();
    return this.getScheduleInTx(id) ?? null;
  }

  private getScheduleInTx(id: string): ScheduleRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM qw_schedules WHERE id=?`).get(id) as ScheduleRow | undefined;
    return row ? rowToSchedule(row) : undefined;
  }

  async recordScheduleFires(
    scheduleId: string,
    fireTimes: number[],
    nextFireAt: number,
    expectedPrevFireAt: number | null,
  ): Promise<JobRecord[]> {
    this.assertOpen();
    return this.tx(() => {
      const sched = this.getScheduleInTx(scheduleId);
      if (!sched) throw new ScheduleNotFoundError(scheduleId);
      if (sched.nextFireAt !== expectedPrevFireAt) return [];
      const t = this.now();
      const created: JobRecord[] = [];
      for (const fireAt of fireTimes) {
        created.push(
          this.enqueueInTx({
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
          }),
        );
      }
      this.db
        .prepare(`UPDATE qw_schedules SET last_fired_at=?, next_fire_at=? WHERE id=?`)
        .run(fireTimes.length > 0 ? fireTimes[fireTimes.length - 1]! : sched.lastFiredAt, nextFireAt, scheduleId);
      return created;
    });
  }

  async setPaused(control: PauseControl): Promise<void> {
    this.assertOpen();
    this.tx(() => {
      if (control.scope === "global") {
        this.metaSet("globalPaused", control.paused ? "1" : "0");
      } else {
        const paused = new Set(JSON.parse(this.metaGet("pausedQueues") ?? "[]") as string[]);
        if (control.paused) paused.add(control.queue!);
        else paused.delete(control.queue!);
        this.metaSet("pausedQueues", JSON.stringify([...paused]));
      }
    });
  }

async setRateRules(rules: RateLimitRule[]): Promise<void> {
    this.assertOpen();
    this.metaSet("rateRules", JSON.stringify(rules));
    const keep = new Set(rules.map((r) => r.key));
    const rows = this.db.prepare(`SELECT key FROM qw_rate_buckets`).all() as Array<{ key: string }>;
    for (const row of rows) {
      if (!keep.has(row.key)) this.db.prepare(`DELETE FROM qw_rate_buckets WHERE key=?`).run(row.key);
    }
  }

  async getRateRules(): Promise<RateLimitRule[]> {
    this.assertOpen();
    return JSON.parse(this.metaGet("rateRules") ?? "[]") as RateLimitRule[];
  }

  async setConcurrencyLimits(limits: ConcurrencyLimit[]): Promise<void> {
    this.assertOpen();
    this.metaSet("concLimits", JSON.stringify(limits));
  }

  async getConcurrencyLimits(): Promise<ConcurrencyLimit[]> {
    this.assertOpen();
    return JSON.parse(this.metaGet("concLimits") ?? "[]") as ConcurrencyLimit[];
  }

  async getJobEvents(jobId: string): Promise<Array<{ ts: number; event: string; detail: string | null }>> {
    const job = await this.getJob(jobId);
    if (!job) throw new JobNotFoundError(jobId);
    return job.events.map((e) => ({ ts: e.ts, event: e.event, detail: e.detail }));
  }

  private requireLeaseInTx(jobId: string, workerId: string): JobRecord {
    const job = this.getJobInTx(jobId);
    if (!job) throw new JobNotFoundError(jobId);
    if (job.state !== "running" || job.leaseOwner !== workerId) throw new LeaseLostError(jobId, workerId);
    return job;
  }

  private metaGet(key: string): string | null {
    const row = this.db.prepare(`SELECT value FROM qw_meta WHERE key=?`).get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  private metaSet(key: string, value: string): void {
    this.db
      .prepare(`INSERT INTO qw_meta (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`)
      .run(key, value);
  }
}

interface ScheduleRow {
  id: string; cron: string; timezone: string; job_type: string; queue: string; payload: string;
  priority: number; max_attempts: number; timeout_ms: number; retry_json: string; on_missed: string;
  created_at: number; paused: number; last_fired_at: number | null; next_fire_at: number | null;
}

function rowToSchedule(r: ScheduleRow): ScheduleRecord {
  return {
    id: r.id,
    cron: r.cron,
    timezone: r.timezone,
    jobType: r.job_type,
    queue: r.queue,
    payload: r.payload,
    priority: r.priority,
    maxAttempts: r.max_attempts,
    timeoutMs: r.timeout_ms,
    retry: JSON.parse(r.retry_json),
    onMissed: r.on_missed as ScheduleRecord["onMissed"],
    createdAt: r.created_at,
    paused: r.paused === 1,
    lastFiredAt: r.last_fired_at,
    nextFireAt: r.next_fire_at,
  };
}

function lastAttempt(job: JobRecord): AttemptRecord | undefined {
  return job.attemptsHistory[job.attemptsHistory.length - 1];
}

function escapeLike(s: string): string {
  return s.replace(/[%_\\]/g, "\\$&");
}
