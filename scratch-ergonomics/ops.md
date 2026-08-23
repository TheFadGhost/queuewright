# Queuewright ergonomics evaluation — ops log & findings

Evaluator stance: stranger to the codebase. Allowed materials: `README.md`,
`queuewright.example.json`, `BENCHMARKS.md`. Everything below was produced from
`scratch-ergonomics/` only, run from the repo root via
`npx.cmd tsx <file>` / `npx.cmd tsx src/cli.ts ...`.

Artifacts in this folder:
- `app.ts` — the main deliverable (tasks a–g)
- `probe*.ts` — isolation probes cited by finding numbers
- `app-run.log` — final app.ts stdout/stderr capture
- `qw.config.json`, `cli-payload.json` — CLI session inputs
- `worker.log`, `worker.err.log`, `worker.pid` — background CLI worker capture

---

## Part 2 — pure-CLI ops session (`npx.cmd tsx src/cli.ts ... --config scratch-ergonomics/qw.config.json`)

Config used (sandbox copy of the documented example, DB inside the sandbox):

```json
{ "storage": { "kind": "sqlite", "file": "./scratch-ergonomics/data/qw.db" },
  "concurrency": 4, "pollIntervalMs": 100 }
```

### 2.1 `qw --help`

Works; reveals commands the README never mentions (`get`, `cancel`, `drain`,
`pause <queue>`, `schedules add/delete`, `--json`, `--config`). Exit codes are
documented and honoured.

### 2.2 Enqueue a job (README command, verbatim shape)

```
> qw enqueue mail.welcome --payload-file cli-payload.json
Error: job type "mail.welcome" is not registered
fix: no job types are registered in this process yet; call defineJob()
     before enqueueing "mail.welcome"
```

**Blocked.** The CLI process has no way to load user job definitions: `--help`
and the example config expose no such option (see Finding 3). The README
advertises `qw enqueue mail.welcome --payload '{"userId":"u_1"}'` as a
first-class workflow; as shipped it cannot succeed for any user type.

### 2.3 Watch stats

```
> qw stats
STATES                      QUEUES (default)
queued      0               queued 0 … dead 1, succeeded 6
scheduled   0
running     0
succeeded   6
dead        1               TOP JOB TYPES: doom.always-fails total 1 dead 1 …
```

Works, informative, includes per-type breakdown and oldest_queued.

### 2.4 Dead letter (created deliberately), list + inspect

The dead letter was created by `app.ts`: job `doom.always-fails`
(`maxAttempts: 2`, always throws) → `attempt_failed` ×2 → `moved_to_dead`.

```
> qw list --state dead
state  id                 type               queue    att  next_run_or_finished
dead   j_mt545z…8pj8uocf  doom.always-fails  default  2/2  2026-08-23T01:13:47.084Z

> qw --json get j_mt545zr8_8pj8uocf
… full record: payload, retry policy, attemptsHistory (per-attempt timing,
error, stack), lifecycle events (enqueued → claimed → attempt_failed ×2 →
moved_to_dead) …
```

Note: table output truncates ids (`j_mt545z…8pj8uocf`); you need `--json` to
get the id `retry` actually accepts.

### 2.5 Retry the dead letter

```
> qw retry j_mt545zr8_8pj8uocf
requeued j_mt545zr8_8pj8uocf  QUEUED  queue=default
```

Works (attempts reset — event `requeued: attempts reset`). Earlier in the
session an identical retry was picked up by a running CLI worker and instantly
fatal-failed again with `UnregisteredJobTypeError … not registered in this
worker process` → `moved_to_failed` (Finding 3 corollary).

### 2.6 Drain

```
> qw drain                              # queue empty
drained (all queues): 0 pending after 0.0s       EXIT=0

> qw drain --timeout 3                  # 1 queued job, no capable worker
Error: drain timed out after 3000ms: 1 job(s) still pending in queue "*"
fix: inspect stuck jobs with "qw list --queue *" - …   EXIT=1
```

Semantics and exit codes behave as documented. (Nit: the fix hint suggests
`--queue "*"` — a literal star that isn't a real queue name.)

Final state after session:

```
queued 1   succeeded 6   failed 1   dead 0
```

---

## Findings (numbered; each cites what was tried vs. what the README says)

1. **[blocker]** `createSchedule` crashes on the **sqlite** backend — the
   README's default. Tried the README §Scheduling example verbatim plus 4
   reduced variants (probe5/probe6):
   ```
   Error: 16 values for 15 columns
       at SqliteStorage.createSchedule (src/storage/sqlite.ts:708/712)
   ```
   All variants fail on sqlite; all succeed on `memory`. Scheduling is
   unusable on the documented-default backend. (README: "Invalid config fails
   fast…" — this isn't config, it's a schema/insert bug.)

2. **[blocker]** Cron schedules that do get created **never fire**. On memory,
   with cron shrunk to `* * * * *`, worker started both before and after
   `createSchedule`, timezone set and unset, waited >4 minutes across several
   minute boundaries: 0 firings (probe8, app.ts). No scheduler-start API
   exists (`startScheduler`/`schedulerStart`/`runScheduler` all undefined;
   `qw.on`/`worker.on` don't exist either). README: "creates a cron schedule"
   implies firing; BENCHMARKS/README claim a tested scheduler.

3. **[blocker]** The CLI cannot participate in the documented job workflow.
   README: `qw enqueue mail.welcome --payload '{"userId":"u_1"}'` and
   `qw worker`. Reality: enqueue → `UnregisteredJobTypeError: no job types are
   registered in this process yet`; `qw worker` claims any queued job and
   instantly fatal-fails it into `failed` with `"job type … is not registered
   in this worker process"` (captured in the job's own event history). There
   is no flag/config key to point the CLI at user job modules. The standalone
   CLI can therefore enqueue nothing and execute nothing.

4. **[friction]** The README's first line of code,
   `import { Queuewright, defineJob } from "queuewright"`, throws
   `ERR_MODULE_NOT_FOUND` when run inside this repo (package does not resolve
   itself). Workaround: `../src/index` — nowhere documented.

5. **[friction]** `validate` is mentioned once ("compile time via generics,
   runtime if you add `validate`") with **no signature**. Type errors reveal it
   must be `(payload: unknown) => string | null`. A conventional boolean
   validator fails to compile — and in plain JS `validate: () => true`
   **rejects every payload** with `payload … failed validation: true`
   (probe4). Truthy-is-valid instinct produces 100% enqueue rejection.

6. **[friction]** State vocabulary is undocumented. Success state is
   `succeeded`; logs say "job completed"; README only ever names `dead`,
   `failed`. My completion poller waited on `"completed"` and hung for 90 s
   while the job sat in `succeeded` (app.ts run 1). Full set
   (queued/scheduled/running/retrying/succeeded/failed/dead/cancelled) appears
   only in `--help`/CLI internals.

7. **[friction]** Batch enqueue is undocumented. `qw.enqueueBatch([[job,
   payload], …])` exists (tuple form works); the natural object form
   `{ job, payload }` throws `object is not iterable` (probe4). README shows
   single `enqueue` only, yet the brief of any real producer is batching.

8. **[friction]** `ctx.progress(...)` is real and useful (values persisted on
   the job record) but appears nowhere in the README — found by dumping ctx
   keys at runtime (`jobId, jobType, queue, attempt, signal, progress,
   idempotency`).

9. **[friction]** README worker section lies about binaries/flags:
   `qw-worker --no-dashboard` — there is no `qw-worker` entry point here, and
   `qw worker --no-dashboard` is rejected:
   `fix: valid options for this command: --concurrency, --queues, --once`.
   Plain `qw worker` printed no dashboard banner either.

10. **[friction]** Worker leaks heartbeat timers after losing a lease. After
    multi-process interference, a worker emitted
    `heartbeat failed … LeaseLostError` every 10 s **forever** (~15+ cycles
    observed in `worker.log`) with no backoff or give-up. At-least-once systems
    must expect lease loss; spamming it eternally is a bug.

11. **[nit]** Job-type naming rule `^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$`
    is undocumented; `doom.always_fails` rejected (error message itself is
    good). Cost one rename cycle.

12. **[nit]** Programmatic inspection APIs exist but are undiscoverable and
    half-broken from the outside: `getJob(id)` works and returns a rich record
    (nice surprise), but bare `listJobs()` throws
    `Cannot read properties of undefined (reading 'states')` and
    `listJobs({state:'completed'})` throws `datatype mismatch` (probe7).

13. **[nit]** `qw.enqueue` returns the **full job record** (undocumented — I
    initially assumed an id string and passed the whole object to `getJob`,
    getting `null`). Pleasant surprise, zero documentation.

14. **[nit]** `drain` timeout hint recommends `qw list --queue "*"` — literal
    `*` is not a queue name; the real queue is `default`.

15. **[nit]** Config surface mismatch: `queuewright.example.json` documents 8
    keys, but validation supports more (`schedules[]`, `rateRules`,
    `concurrencyLimits`) — discoverable only by reading internals during
    Peeks #2/#4. The README's "documents all keys" claim oversells the file.

16. **[nit]** "Logs are structured (pretty on TTY…)": through npx pipes
    everything was JSON; pretty mode never observed, so the claim is
    unverifiable in practice here. Minor, but the README presents it as the
    default developer experience.

### Peek log (type/source inspections, per escape-hatch rules)

Each peek happened only after exhausting README-based attempts, and only for
the stuck topic stated:

- **PEEK #1** — stuck: schedules created but never fire; looked for a
  scheduler API. Read `src/index.ts` (35 lines, public exports). Found no
  scheduler start; noted `createTestClient`, cron helpers exported.
- **PEEK #2** — same stuck topic. Grepped `schedule` across `src/*.ts`;
  learned `Scheduler` ticks 1 Hz and attaches in `createWorker()`, that
  `config.schedules[]` exists, and CLI has `schedules list/add/delete`.
- **PEEK #3** — same stuck topic. Read `src/client.ts:255-304`; confirmed
  attach-on-createWorker and that `deleteSchedule` exists.
- **PEEK #4** — stuck: CLI enqueue demands registered types; grepped
  config/registry for a module-loading key. None exists (Finding 3 stands).

### Positive surprises (would be unfair to omit)

Idempotency did exactly what §Delivery promises: guarded effect ran once
across a failing first attempt (`SIDE EFFECT ran … 1 time(s)` with attempts
1→2). Queue-scoped pause/resume worked first try from a one-line guess off the
global example. Per-job records carry complete attempt history + lifecycle
events, and nearly every error message ships a genuinely helpful `fix:` hint.

---

## ERGONOMICS FINDINGS: 16 (blocker 3, friction 7, nit 6)

**Verdict.** A stranger could *nearly* ship the happy path — the minimal
example runs, retries/timeouts/idempotency behave exactly as advertised, the
storage swap between sqlite/memory is seamless, and the CLI's observability
verbs (`stats`, `list`, `get`, `retry`, `drain`) are genuinely pleasant with
excellent error messages — but three hard walls make "ship on this README"
impossible today: cron schedules crash outright on the default sqlite backend
and silently never fire on memory, and the CLI is a bystander that can neither
enqueue nor execute a user job because no registration path exists; around
those, a stranger must also guess the import path, the `validate` signature
(where JS users get silently inverted semantics), the state vocabulary, and
the batch/progress APIs. The bones are good and the failure messages are often
better than the documentation — but the README describes a product one or two
solid fixes ahead of the one in the box, so today: **no, not on this README
alone.**
