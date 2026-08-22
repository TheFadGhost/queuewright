# Queuewright DESIGN.md

This document is written **before** feature code. Every module is built to it.
Three surfaces exist: the job-definition API a developer writes against, the
operations dashboard someone stares at during an incident, and the CLI. When a
decision is not covered here, the decision that makes the system more legible
at 3am wins.

## Point of view

Queuewright is an operations tool, and its register is *legible at 3am under
stress*: dense, calm, honest. Density over decoration - more true rows, fewer
padded cards. Calm means no animation that carries information, no count-ups,
no colour that exists only to look designed. Honest means numbers are never
smoothed over: a gap in the data renders as a gap, latency is reported as named
percentiles, never a bare average, and a job's state is stated in words, not
suggested by hue. The important number is never more than one glance away from
whatever you are looking at. An ops tool does not need a theme gallery, so we
ship exactly three dashboard token sets (light, dark, high-contrast) and two
terminal themes plus plain mode for the CLI - all pure token overrides of one
layout, not separate designs.

---

## 1. Job definition and enqueue API

**Principle:** defining a job and enqueuing it must be short and type-safe.
The common retry configuration must be a default rather than a required
argument. A payload mismatch between producer and consumer is caught at the
call site (compile time via generics, runtime via optional validators), not
discovered inside a handler at 3am.

Jobs are defined **once**. Both `enqueue` and worker execution reference the
same definition object, so the payload type flows to both sides and an
unregistered or misspelled job type cannot be enqueued by accident.

### Minimal (everything defaulted)

```ts
import { Queuewright, defineJob } from "queuewright";

const qw = new Queuewright({ storage: { kind: "sqlite", file: "./data/qw.db" } });

// Defaults: queue "default", 3 attempts, exponential backoff starting at 1s,
// full jitter, 30s per-attempt timeout.
const welcome = defineJob<{ userId: string }>("mail.welcome", async (payload, ctx) => {
  await sendEmail(payload.userId);
});

await qw.enqueue(welcome, { userId: "u_1042" });
await qw.runWorker(); // blocks until shutdown signal
```

### Complex (every knob, shown once)

```ts
const invoice = defineJob<InvoicePayload>(
  "billing.render-invoice",
  {
    queue: "billing",
    priority: 7,                      // higher runs first within a queue
    timeoutMs: 120_000,               // per-attempt hard timeout
    retry: {
      maxAttempts: 6,
      strategy: "exponential",        // "exponential" | "linear" | "fixed"
      baseDelayMs: 2_000,
      maxDelayMs: 5 * 60_000,
      jitter: "full",                 // "full" | "equal" | "none"
    },
    dedupeTtlMs: 10 * 60_000,         // default window for enqueue-time dedupe keys
    validate: (p) =>                  // return null if valid, error string otherwise
      typeof p.invoiceId === "string" && p.amountCents > 0 ? null : "invoiceId/amountCents invalid",
    payloadVersion: {                 // migration path when the payload shape changes
      from: 1,
      migrate: (old) => ({ ...old, currency: old.currency ?? "USD" }),
    },
  },
  async (payload, ctx) => {
    ctx.progress(0.2, "fetched order");
    await ctx.idempotency("render:" + payload.invoiceId, async () => {
      await renderPdf(payload);       // runs at most once per key, even across retries/crashes
    });
    if (unrecoverable) throw new FatalJobError("no template for region"); // -> failed, never retried
  },
);

await qw.enqueue(invoice, { invoiceId: "inv_88", amountCents: 4200 }, {
  delayMs: 60_000,                    // -> state "scheduled" until due
  dedupeKey: `invoice:${id}`,         // concurrent duplicate enqueues collapse into one job
});
await qw.enqueueBatch([[welcome, { userId: "u_1" }], [invoice, payload2]]); // atomic batch
```

Rules encoded above:

- The handler receives `(payload, ctx)` where `ctx` exposes `jobId`, `attempt`,
  `queue`, `progress(fraction, note?)`, `idempotency(key, fn)`, and
  `signal` (aborted on timeout/shutdown).
- `defineJob(type, options?, handler)` registers the type globally per process;
  double registration throws a config error naming the type.
- Enqueue validates: registered type (compile+runtime), payload size against
  `maxPayloadBytes`, optional `validate()`. Errors name the job type and the fix.
- Payload versioning: payloads carry `__v`; on dequeue, if `migrate` is
  defined and version differs, it runs before the handler. A missing migrator
  for an older version is a framework-level failure logged loudly; the job goes
  to `failed` (not retried blindly).

### Test mode

```ts
const t = createTestClient({ definitions: [welcome, invoice] });
t.enqueue(welcome, { userId: "u_1" }, { delayMs: 5000 });
await t.advance(5_000);   // fake clock; runs due jobs synchronously, in order
expect(t.stateOf(jobId)).toBe("succeeded");
```

No timers, no threads; deterministic ordering by (priority desc, runAt asc,
seq asc) - the same order production claims use.

## 2. Naming conventions

- Package/module names: lowercase single words (`worker`, `scheduler`,
  `ratelimit`). Files mirror module names exactly (`worker.ts`).
- Types/classes: `PascalCase` (`StorageBackend`, `JobRecord`). Values/functions:
  `camelCase`. Constants: `SCREAMING_SNAKE_CASE`.
- Job types: dotted lowercase `<domain>.<verb-noun>` (`mail.welcome`,
  `billing.render-invoice`). Validated:
  `/^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/`.
- Queues: lowercase, `[a-z0-9-_]`, default `"default"`.
- Storage tables/keys prefixed `qw_`.
- Environment variables prefixed `QW_` (`QW_LOG_FORMAT`, `QW_DATA_DIR`).
- Errors are classes suffixed `Error`, all extending `QueuewrightError`.
- CLI verbs match API method names (`enqueue`, `retry`, `drain`).
- Public exports live in `src/index.ts`; nothing else is public API.

## 3. Error taxonomy

Three classes, and every error states **job type (if any), job id (if any),
and the actionable next step**:

1. **Job failure** - expected domain failure thrown by a handler (`Error`, or
   `FatalJobError` for non-retryable). Retried per policy (or moved straight
   to `failed` for fatal). Captured per attempt with full stack. Logged at
   `warn`, never crashes anything. Non-`Error` throwables (strings, objects)
   are wrapped into `WrappedThrowError` with the value stringified safely.
2. **Framework error** - unexpected internal fault (storage down mid-claim,
   lease lost, corrupt record). Logged at `error` with `module` field; never
   surfaces as a job failure; affected jobs are left claimable (never lost).
3. **Configuration error** - fatal at startup or at the call site:
   `ConfigValidationError`, `UnregisteredJobTypeError`, `InvalidCronError`,
   `DuplicateDefinitionError`, `PayloadTooLargeError`, `InvalidTransitionError`
   (a programming bug - includes current state, target state, job id). These
   abort startup with exit code 2 and print every problem found, not just the
   first.

### Anatomy of a config validation error

```
ConfigValidationError: 2 configuration problems
  - storage.visibilityTimeoutMs: expected integer >= 1000, got 50.
    fix: set visibilityTimeoutMs to at least 1000, or remove it to use the default (30000).
  - queues[1].concurrencyLimit: expected positive integer, got 0.
    fix: set concurrencyLimit >= 1 or omit the field entirely.
docs: https://github.com/TheFadGhost/queuewright#configuration
```

Rules: one line per problem; each line has `path: expectation, got value.`
then a `fix:` sentence; machine-readable form (`--json`) is
`{ errors: [{ path, expected, got, fix }] }`.

## 4. Structured logs

Fields fixed once; extras go under `kv`. One event per line.

JSON mode (`QW_LOG_FORMAT=json`, default for non-TTY):

```json
{"ts":"2026-08-22T14:03:11.482Z","level":"warn","msg":"job attempt failed","module":"worker","jobId":"j_01J9","jobType":"mail.welcome","queue":"email","attempt":2,"err":{"name":"SMTPTimeout","message":"upstream timeout","stack":"SMTPTimeout: ..."},"kv":{"nextAttemptInMs":4211}}
```

Human mode (TTY default, honouring `NO_COLOR` / `--no-color`):

```
14:03:11 warn  worker     job attempt failed          j_01J9 mail.welcome attempt=2 next_in=4.2s SMTPTimeout: upstream timeout
```

Levels: `debug|info|warn|error`. Time is always ISO-8601 UTC in JSON.
**Payloads are never logged at info level** - they may carry sensitive data in
real use (documented behaviour). At `debug` level payloads render redacted
(keys matching `/pass|secret|token|auth|ssn|email/i` become `"***"`) unless
`QW_LOG_UNSAFE_PAYLOADS=1` opts in, which itself logs a warning once.

Emoji are banned in logs, CLI output, and the dashboard.

## 5. CLI

Binary `qw`. Layout: `qw <noun> <verb> [args] [flags]`. Global flags before or
after args. Help mirrors this structure; every command supports `--json` for
machine-readable output and honours `NO_COLOR` / `--no-color`.

```
qw - background jobs for people who read their logs

USAGE
  qw <command> [args]

JOBS
  qw enqueue <type> [--payload '<json>' | --payload-file f] [--queue q]
             [--delay seconds] [--dedupe-key k] [--priority n]
  qw get <job-id>                    show one job with full attempt history
  qw list [--state s] [--queue q] [--type t] [--limit n] [--cursor c]
  qw retry <job-id>                  requeue a dead/failed/succeeded/cancelled job
  qw retry --all-dead [--queue q]    bulk requeue dead letters
  qw cancel <job-id>
QUEUES
  qw stats                           depths, throughput, percentiles, failures
  qw pause <queue> | qw resume <queue> | qw pause --all | qw resume --all
  qw drain [--queue q] [--timeout seconds]   wait until queue is empty
SCHEDULES
  qw schedules list | add <expr> <type> --tz Z [--on-missed p] | delete <id>
WORKERS
  qw worker                          run a worker (same as qw-worker)
GLOBAL FLAGS
  --json            machine-readable output (stable field order)
  --no-color        disable colour even on a TTY (NO_COLOR also honoured)
  --config <file>   config file (default ./queuewright.json)
  --help            this text; per-command help via qw <command> --help

EXIT CODES  0 ok | 1 operational error (job not found, drain timeout) |
            2 configuration/usage error
```

Colour use in the CLI encodes state only (same palette as the dashboard),
never decoration. Two terminal themes ship (`qw-dark`, `qw-light`, chosen by
background detection, overridden by `QW_CLI_THEME`); `--no-color`/`NO_COLOR`
produces correct plain output with no escape sequences anywhere.
## 6. Dashboard visual specification

One page app, vanilla ES modules, no build step, served by the API server.
Layout is a single column of sections: header (system status, global pause),
summary strip, charts row, jobs table, detail pane (route `/jobs/:id`).

### Type and spacing scales

- Font: system stack (`ui-sans-serif, system-ui, "Segoe UI", Roboto, Helvetica,
  Arial, sans-serif`); monospace for ids, timestamps, payloads:
  `ui-monospace, "Cascadia Code", Consolas, monospace`.
- Sizes: 12 (labels, dense table), 13 (body/table default), 14 (detail body),
  16 (section titles), 20 (page title). Line height 1.45.
- Spacing scale: 4px base - 4, 8, 12, 16, 24, 32. Table cell padding 8px 12px.
- Numeric columns use `font-variant-numeric: tabular-nums` everywhere so
  auto-refresh never jitters column widths.

### Semantic colour tokens

Tokens only; components never name raw colours. Themes override tokens.

| token | light | dark | high-contrast |
|---|---|---|---|
| `--bg` | #ffffff | #101418 | #ffffff |
| `--bg-sunken` | #f4f6f8 | #171d24 | #eef1f4 |
| `--fg` | #1a2129 | #e6ebf0 | #000000 |
| `--fg-muted` | #5b6875 | #97a4b0 | #333c44 |
| `--border` | #d9e0e6 | #2b343d | #55606a |
| `--focus` | #0b62d6 | #58a6ff | #0b62d6 |
| `--st-queued` | #57606a | #8b949e | #444c54 |
| `--st-scheduled` | #7d6600 | #c9a227 | #6b5200 |
| `--st-running` | #0b62d6 | #58a6ff | #004ea8 |
| `--st-succeeded` | #116e32 | #3fb950 | #0a5426 |
| `--st-retrying` | #b45309 | #f0883e | #8a3c00 |
| `--st-failed` | #b3261e | #ff6b63 | #8f1109 |
| `--st-dead` | #7c1d6f | #db61a2 | #5c1140 |
| `--st-cancelled` | #5b6875 | #97a4b0 | #444c54 |

All text/state pairs meet AA contrast in their theme; chart axis labels use
`--fg-muted`, verified AA against `--bg` in all themes.

### Job-state indicator system

State is primary information, so it is **never colour alone**. Every state
renders as: a shape glyph + a word label + colour.

| state | glyph | label |
|---|---|---|
| queued | hollow circle | QUEUED |
| scheduled | half circle | SCHED |
| running | triangle | RUNNING |
| succeeded | filled circle | DONE |
| retrying | circular arrow | RETRY |
| failed | cross | FAILED |
| dead | square | DEAD |
| cancelled | slashed circle | CANCELLED |

Glyphs are drawn inline SVG (not emoji), inherit `currentColor`, and are
identifiable under deuteranopia/protanopia/tritanopia because distinction is
carried by shape and text. Colourblind verification is part of the design audit.

### Chart rules

- Aggregation window selectable: 15m / 1h / 6h / 24h. Default 1h, bucket =
  window/60 (so 1h gives 60 buckets of 1m). Stated in the axis footer:
  "1h - 60 x 1m buckets - UTC".
- Percentile convention: p50/p95/p99 computed over completed attempts whose
  finish time falls in the bucket; labelled explicitly ("latency p95").
  Averages are never shown alone.
- Axes honest: y starts at zero for counts; x covers the full selected window
  including empty leading/trailing space. Missing buckets render as gaps
  (broken polyline), never interpolated. If >20% of buckets are missing the
  chart shows "incomplete data" instead of a line.
- Charts are SVG, no libraries, `role="img"` + `aria-label` summarising the
  series ("Throughput last hour, peak 142/min at 13:52 UTC").
- No gauges, no animated count-ups, no gradients encoding values.

### Jobs list table

Columns (fixed order): state badge - id (mono, truncated middle) - type -
queue - attempts `n/max` - next run or finished at - duration - created.
Right-align all numerics. Sort by created desc by default; sortable headers
with `aria-sort`. Row density: 32px rows, zebra off, hover row highlight using
`--bg-sunken`. Selected row marked with 2px inset `--focus` border, preserved
across refreshes. Pagination via cursor; `j`/`k` or arrows move selection,
`Enter` opens detail.

### Job detail view

Header: state badge + type + id + queue + created/updated timestamps (absolute
with explicit timezone, e.g. `2026-08-22 14:03:11 UTC`, relative form as
secondary text "2 min ago", both visible). Body sections: payload (rendered as
text via `textContent` only - never `innerHTML` - payloads are untrusted),
result/error of last attempt, schedule link if recurring, then **attempt
history**: one row per attempt - `#`, started, duration, outcome, error
message; expanding a row reveals the full stack trace in mono. Actions
(retry, cancel, requeue) are buttons with visible focus rings, keyboard
operable, and **confirm before acting** via a small modal (Enter confirms,
Esc cancels, focus trapped, focus restored).

### Auto-refresh behaviour

Poll every 5s, toggleable (and paused when the tab is hidden or a modal/input
is focused). Refresh must never scroll the user, never move focus, never
collapse an expanded attempt row, and must preserve row selection. Updated
values simply replace old ones (calm). A subtle "last refreshed 14:03:11 UTC"
timestamp sits in the header. If a poll fails, an inline banner appears once
("live updates unavailable - retrying") without replacing page content.

### States

- Empty (no jobs): section shows one muted sentence - "No jobs match the
  current filters." plus a clear-filters action. Never a blank area.
- Loading: skeleton rows only on first load; subsequent loads update in place.
- Error: inline banner with the message and a Retry button; table content
  remains (possibly stale) with a "stale" marker.
- No-data (charts): "Not enough data yet" with the reason ("no completions in
  this window").

### Themes

`light` (default), `dark`, `high-contrast` - switched by `data-theme`
attribute, persisted in localStorage, default follows `prefers-color-scheme`
(light/dark only). They are token overrides only; there is no theme gallery
beyond these three.

Accessibility: fully keyboard operable, visible 2px `--focus` outline
(+2px offset) on everything, `prefers-reduced-motion` disables transitions,
AA contrast including axis labels, semantic landmarks (`header/nav/main`),
tables are real `<table>` elements.

## 7. Storage backends and delivery contract

One interface (`StorageBackend`), two first-party implementations, one
conformance suite:

- **memory** - embedded, in-process, zero dependencies. For tests and
  single-process use.
- **sqlite** - embedded file via `node:sqlite` in WAL mode. Supports multiple
  worker processes on one machine sharing one database file. Claims are
  single-statement CAS updates; no external service required.

New backends implement the interface and pass `test/conformance/*.spec.ts`
unmodified.

Delivery contract, stated everywhere it matters: **at-least-once**. Handlers
MUST be idempotent. The framework provides `ctx.idempotency(key, fn)` backed by
the storage layer so side effects guarded by it execute at most once per key.
We never claim exactly-once.

## 8. Worker lifecycle (architecture note)

Claim -> heartbeat -> complete, with a lease:

1. Worker polls `claim()` - atomically moves queued->running for up to N slots,
   respecting rate limits, per-type/queue concurrency caps, pause flags.
2. While running, the worker heartbeats every `visibilityTimeout/3`, pushing
   `leaseUntil` forward.
3. Success -> `succeeded`; failure -> `retrying` (next `runAt` from strategy)
   or `dead` (attempts exhausted) or `failed` (fatal/non-retryable).
4. Any worker's sweeper reclaims jobs whose `leaseUntil` passed (crashed
   worker) back to queued - the job was possibly executed, hence at-least-once.
5. Graceful shutdown: stop claiming, finish in-flight within deadline,
   requeue the rest (attempts preserved), close storage.

Per-job timeouts interrupt handlers: async handlers race a timer and receive
an aborted `AbortSignal`; opt-in thread isolation (`execution: "thread"`)
terminates the thread outright for CPU-bound hangs. Inline mode documents that
a synchronous spin-loop cannot be preempted in-process - the slot is freed and
the worker continues either way.

## 9. Scheduler semantics

Cron: standard 5-field expressions plus optional leading seconds field.
Supported syntax: `*`, lists, ranges, steps (`*/n`, `a-b/n`), month/day names.
Evaluation is timezone-aware via `Intl`; DST is handled by evaluating wall-clock
matches against real instants: a spring-forward nonexistent time simply does not
match (the schedule fires at the next matching real time); a fall-back repeated
hour fires once, at its first occurrence. Missed schedules (worker down across
one or more fire times) apply the per-schedule policy:
`catch_up` fires every missed slot sequentially; `skip` jumps to the next
future slot; `run_once` (default) fires once regardless of how many were
missed. One-off scheduled jobs use absolute timestamps and are never missed
(they are durable rows).

## 10. Defaults

A worker runs with almost no config. Defaults: storage sqlite at
`./data/queuewright.db` (or `QW_DATA_DIR`), concurrency 4, visibility timeout
30s, heartbeat visibility/3, poll interval 250ms, max payload 256 KiB,
retention 7 days, queue `default`, retries 3 attempts exponential 1s base full
jitter, per-attempt timeout 30s, dashboard port 7788 bound to 127.0.0.1,
log format pretty on TTY / JSON otherwise.

