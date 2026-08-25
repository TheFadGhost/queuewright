# Queuewright

> **built with ox alpha**
>
> most of this was written in august 2026 during the free preview window of
> [ox alpha](https://openrouter.ai/stealth/ox-alpha), an anonymous stealth model
> that turned up on openrouter for about a week. i set the direction and reviewed
> what came back. the tests are real and they pass — clone it and run them.

A background job queue and scheduler with retries, a worker runtime, and a
monitoring dashboard, for developers who need reliable deferred work without
adopting a large framework.

## Install

```
npm install queuewright
```

Requires Node >= 22.13 (uses the built-in `node:sqlite`).

## Minimal example

This file is complete; it enqueues a job and runs it.

```ts
import { Queuewright, defineJob } from "queuewright";

const qw = new Queuewright({ storage: { kind: "sqlite", file: "./data/qw.db" } });

// Defaults: queue "default", 3 attempts, exponential backoff starting at 1s,
// full jitter, 30s per-attempt timeout.
const welcome = defineJob<{ userId: string }>("mail.welcome", async (payload) => {
  console.log("sending welcome to", payload.userId);
});

await qw.init();
await qw.enqueue(welcome, { userId: "u_1042" });
const worker = qw.createWorker();
worker.start();

setTimeout(async () => {
  await worker.stop(); // finishes in-flight jobs, requeues the rest
  await qw.close();
}, 5000);
```

Run it: `npx tsx welcome.ts`. You will see the handler execute once.

A job is defined once; both enqueueing and execution reference the same
definition object, so a payload mismatch is caught at the call site (compile
time via generics, runtime if you add `validate`) instead of inside a handler.
`validate` receives the payload and returns `null` when it is valid, or an
error string when it is not.

Job states: `queued -> running -> succeeded`, with failures going to
`retrying` (next automatic attempt), `dead` (retries exhausted, dead-letter
queue), `failed` (fatal/non-retryable), plus `scheduled` (future run time) and
`cancelled`. Every job keeps a full attempt history and event log.

## Delivery guarantee — read this

Queuewright provides **at-least-once** delivery. A job that has started may run
again after a crash or visibility-timeout reclaim. **Handlers must be
idempotent.** Queuewright never claims exactly-once delivery, and it will not
silently weaken at-least-once for throughput.

To make idempotency practical, handlers get a storage-backed helper:

```ts
const render = defineJob<{ invoiceId: string }>("billing.render", async (p, ctx) => {
  await ctx.idempotency(`render:${p.invoiceId}`, async () => {
    await renderPdf(p.invoiceId); // runs at most once per key, even across retries and crashes
  });
});
```

`ctx.idempotency(key, fn)` records the outcome in the same store as the jobs:
if a previous attempt already completed `fn` for this key, the cached result is
returned instead of re-running the side effect. It covers effects guarded by
the key; unkeyed external side effects remain your responsibility.

## Running a worker and the dashboard

```
qw worker                 # worker + dashboard on http://localhost:7788
qw-worker --no-dashboard  # worker only
qw stats                  # depths, states, top types, latency percentiles
qw list --state dead      # dead letters
qw retry <job-id>         # requeue one
qw retry --all-dead       # bulk requeue
qw enqueue mail.welcome --payload '{"userId":"u_1"}'
qw --help                 # full command reference
```

`qw enqueue` talks to the shared store, so it works from any machine or shell
without loading your handler code; the worker that executes the job must have
the type registered. When run from source (this repository), use
`npx tsx src/cli.ts ...`; the `qw` bin exists in the published npm package.

Starting a worker also starts its scheduler: cron schedules are evaluated by
any running worker against the shared store (fires are guarded by a
compare-and-set so multiple workers never double-fire a slot).

The dashboard shows queue depths over time, throughput, latency percentiles
(p50/p95/p99), failure rates, per-type breakdowns, a searchable job list, a
detail view with every attempt and its error, and retry/cancel/requeue
controls. It is keyboard operable, honours `prefers-reduced-motion`, and ships
light/dark/high-contrast token themes.

## Retry reference

Per job type:

```ts
defineJob("billing.charge", {
  retry: {
    strategy: "exponential",   // "exponential" | "linear" | "fixed"
    baseDelayMs: 2_000,        // first delay
    maxDelayMs: 5 * 60_000,    // cap
    jitter: "full",            // "full" | "equal" | "none" - jitter stays within its stated range
  },
  maxAttempts: 6,
  timeoutMs: 120_000,          // per-attempt timeout; aborts the handler's AbortSignal
}, handler);
```

- exponential: `base * 2^(attempt-1)`, capped at maxDelayMs
- linear: `base * attempt`, capped
- fixed: `base`
- Throw `FatalJobError` to skip remaining retries and land in `failed`.

Per-attempt timeouts race the handler and abort its `AbortSignal`. For
CPU-bound handlers that ignore signals, opt into thread isolation so the
timeout genuinely terminates the handler:

```ts
defineJob("cpu.hash", {
  timeoutMs: 5_000,
  execution: { thread: { module: "./workers/hash.ts", export: "handler" } },
}, handler);
```

## Scheduling

```ts
await qw.createSchedule({
  id: "nightly-cleanup",
  cron: "0 3 * * *",
  timezone: "Europe/Berlin",     // IANA name; DST handled correctly
  jobType: "maintenance.cleanup",
  payload: { olderThanDays: 7 },
  onMissed: "run_once",          // what to do when the system was down
});
```

Missed-schedule policies, configured per schedule:

| policy | behaviour after downtime |
|---|---|
| `run_once` (default) | fire once for the missed window |
| `catch_up` | fire once per missed slot (bounded) |
| `skip` | jump to the next future slot |

DST: spring-forward nonexistent times are skipped (the schedule fires at the
next matching real time); fall-back ambiguous hours fire once, at their first
instant. One-off delayed jobs (`delayMs`/`runAt` on enqueue) are durable rows
and are never lost across restarts.

## Storage backends

| backend | kind | multi-process | external service | trade-offs |
|---|---|---|---|---|
| `sqlite` | embedded file (WAL) | yes, one shared file per machine | none | durable, cross-process claims via CAS transactions; write throughput bounded by fsync/WAL |
| `memory` | in-process | no | none | fastest; state vanishes with the process; ideal for tests |

Both pass the same conformance suite (`test/conformance`). To write your own
backend, implement `StorageBackend` from `src/storage/interface.ts` — atomic
`claim`, lease semantics, dedupe-key uniqueness among active jobs — then run
the conformance suite against it. Delivery guarantees depend on claim atomicity;
do not weaken them.

## Configuration

Everything runs on defaults (`queuewright.example.json` documents all keys):
sqlite at `./data/queuewright.db`, concurrency 4, visibility timeout 30s,
poll interval 250ms, max payload 256 KiB, retention 7 days. Invalid config
fails fast at startup listing every problem with a fix.

Rate limits and concurrency caps apply during claims and are enforced across
processes:

```ts
await qw.setRateRules([{ key: "type:mail.welcome", limit: 100, windowMs: 60_000 }]);
await qw.setConcurrencyLimits([{ key: "queue:email", max: 2 }]);
await qw.setPaused({ scope: "global", queue: null, paused: true });
```

## Metrics and health

- `GET /metrics` — Prometheus format: `qw_jobs_enqueued_total`, `qw_jobs_completed_total`,
  `qw_retries_total`, `qw_dead_total`, `qw_jobs_reclaimed_total`, `qw_jobs_state`,
  `qw_queue_depth`, `qw_job_duration_ms_ms` (summary with quantiles).
- `GET /healthz` — `{status, storage, uptimeMs}`.

Logs are structured (pretty on TTY, JSON otherwise; `QW_LOG_FORMAT=json`
forces JSON). Payloads are never logged at info level — they may carry
sensitive data; debug-level payloads are redacted unless
`QW_LOG_UNSAFE_PAYLOADS=1` (which logs a warning when enabled).

## Architecture note: claim / heartbeat / complete

Workers atomically move due `queued` jobs to `running` with a lease
(`visibilityTimeout`). While running they heartbeat every timeout/3 (lease
extensions are clamped so a clock-skewed process cannot extend a lease
indefinitely). Success completes the job; failure schedules a retry or moves
it to `dead` (exhausted) or `failed` (fatal). Any live worker's sweeper
returns expired leases to the queue - that is the moment an at-least-once
double-execution becomes possible. Graceful shutdown stops claiming, waits
for in-flight work within the deadline, and requeues the rest with attempts
preserved. Per-job timeouts abort the handler's signal; with thread isolation
the handler is terminated outright.

Retention: terminal jobs, completion samples and stale idempotency locks are
purged by the worker's retention sweep (`retentionMs`, default 7 days), so run
at least one worker wherever your storage lives.

## Development

```
npm install
npm test        # unit + conformance + chaos suites
npm run build
npx tsx scripts/bench.ts 512 2000 4 sqlite
```

See BENCHMARKS.md for measured numbers and the exact method, PLAN.md for scope
decisions, DESIGN.md for the design contract, AUDIT.md for audit results.

## License

MIT