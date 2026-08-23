# Queuewright AUDIT.md

Audit log for the road to v1.0.0. Audits are performed by agents that did not
write the code they reviewed. Findings are fixed, re-run, and re-audited.

## Round 1 - 2026-08-23

Three independent auditors: a code auditor, a design auditor (dashboard + CLI),
and an API-ergonomics "stranger" who built and operated jobs using only the
README.

### Code audit - 30 findings (3 high, 13 medium, 14 low)

Fixed in this round:

- [high] sqlite `createSchedule` INSERT had 16 values for 15 columns -
  schedules were unusable on the default backend. Fixed and covered by tests.
- [high] CLI `enqueue` could never succeed (registration demanded in a process
  that has no handlers). `rawEnqueue` now supports an explicit
  `allowUnregistered` escape hatch used by the CLI; strict by default.
- [high] Two workers could double-fire one schedule slot. `recordScheduleFires`
  is now compare-and-set on the previously observed `nextFireAt` in both
  backends; losers enqueue nothing.
- [medium] Scheduler was never started anywhere (`Scheduler.start()` had no
  caller) - found by the ergonomics stranger, not the code audit.
  `Worker.start()` now starts it.
- [medium] Heartbeat timer leaked on the unregistered-type early-return path.
- [medium] Memory backend kept dedupe keys blocked after terminal failure and
  never cleaned orphans; now released on dead/failed and swept by retention.
- [medium] `beginIdempotency` let concurrent executions duplicate guarded side
  effects; it now returns `busy` and `ctx.idempotency` throws
  `IdempotencyKeyBusyError` so normal retries handle contention. Aged pending
  locks are purged with retention.
- [medium] Failed attempts recorded wall-clock epoch as a latency sample,
  poisoning percentiles; now records elapsed time.
- [medium] A storage fault on `completeJob` was recorded as a handler failure
  and burned attempts; completion-phase errors now leave the lease for sweeper
  recovery (at-least-once preserved).
- [medium] Config-file schedule failures were silently swallowed;
  `applyStartupRules` now throws a ConfigValidationError listing each failure,
  and cron expressions are validated in config validation.
- [medium] Dashboard server crash on EADDRINUSE; listen errors now reject into
  worker-main's fallback, the dashboard is stopped on shutdown, idle
  connections closed.
- [medium] Static file traversal guard hardened via `path.relative`; SPA
  fallback restricted to extension-less paths.
- [medium] `/api/jobs` state filter whitelisted, limit clamped to [1,500],
  malformed percent-encoding answered with 400 instead of 500.
- [medium] `config.now` is now forwarded to storage backends constructed by
  `Queuewright`.
- [medium] Caller-supplied job ids colliding silently overwrote rows in the
  memory backend; now rejected.
- [medium] Memory-backend batches could half-commit on intra-batch key
  collisions; keys/ids are reserved before any insert.
- [medium] raw enqueues accepted invalid JSON, queue names, priorities;
  boundary validation added.

Also fixed from low findings: dead exports removed (`newId`,
`cloneJobRecord`, `describeCron`, `DEFAULT_RETRY_SNAPSHOT`, duplicate
`takeRateToken`, duplicate `FatalJobError` export), testmode artifacts removed,
LIKE search escapes honoured, pagination cursor is an encoded token that
survives purged rows, rate-bucket rows pruned when rules change, scheduler
cron-parse cache evicted for deleted schedules, heartbeat extensions clamped
against clock skew, sqlite `close()` guarded before init, signal listeners
removed after shutdown, leases released only after the claim loop quiesces,
fail-target decision shared across backends, memory/schedule error taxonomy
(`DuplicateScheduleError`, `ScheduleNotFoundError`, `InvalidNameError`,
`InvalidTimezoneError`), thread timeout detection typed instead of string
matched, `qw list` state cells use the same coloured uppercase words as other
commands.

Deferred deliberately (documented, not silently dropped):

- Multi-region clock skew beyond lease clamping requires an authoritative
  DB-side clock; clamping bounds the damage and is documented in README.
- Retention runs inside workers; deployments without any running worker must
  accept unbounded completion samples. Documented in README architecture note.

### Design audit - 11 findings (0 high, 5 medium, 6 low)

All five medium findings fixed:

- Poll-failure banner now clears when polling recovers.
- Summary "LATENCY P95" now shows the latest completed bucket's true p95
  (previously a median of bucket p95s, mislabeled).
- Jobs-table timestamps show explicit UTC plus a visible relative line (not
  tooltip-only).
- Throughput chart failed segments carry a dashed outline + legend so the
  succeeded/failed split does not rely on colour alone.
- `qw cancel` help text aligned with actual exit codes.

Low fixes: tabular figures applied to the row counter and progress percentage.

Verified passing (no action): AA contrast in all three themes (minimum 5.02:1),
colourblind-safe state identification via shape+text redundancy, XSS safety
(textContent only), keyboard operability with focus-trapped confirm modals,
honest charts with gap rendering, prefers-reduced-motion, exactly three token
themes.

### Ergonomics audit - 16 findings (3 blocker, 7 friction, 6 nit)

Blockers were the sqlite schedule INSERT bug, schedules-never-fire (scheduler
never started), and CLI enqueue impossibility - all fixed above. README
clarified: validate() signature, job-state vocabulary, scheduler auto-start,
CLI-from-source usage, thread isolation, retention behaviour.

## Verification

After every fix round:

- `npx tsc --noEmit` clean
- full suite green: conformance (both backends), unit, integration, chaos,
  multi-process SIGKILL harness
- e2e smoke against a live dashboard server (API, metrics, health, static,
  dead-letter requeue)

## Round 2

Re-audit by a fresh verification agent confirmed the round-1 fixes in code and
behavior, and caught three gaps plus two nits, all fixed:

- [high] The CLI's enqueue path never actually passed `allowUnregistered` -
  proven live with exit code 2 before the fix, exit 0 after (with a note that
  the worker must register the type).
- [medium] Thread-isolated completion faults were rethrown into the failure
  path and burned attempts of successful jobs; both inline and thread paths
  now treat completion-phase storage errors as framework errors, leaving the
  lease for sweeper recovery.
- [medium] Idempotency pending-lock purge was age-less; locks now carry
  `created_at` (sqlite column added via PRAGMA-check + ALTER TABLE migration,
  memory stamps), pending locks purge after one hour, done rows with retention.
- [low] Traversal guard now implemented as documented (`path.relative`),
  thread-path latency samples use the injected clock, dashboard Created column
  shows a visible relative span, p95 summary title derives bucket length from
  the window instead of hardcoding "minute".
- Test robustness: the chaos shutdown test seeded real-time runAt values
  against a frozen fake clock - claimability depended on millisecond timing.
  All chaos inputs now stay on the injected timeline, and fault injection uses
  a deterministic cadence so the stated injected-failure count is stable.

Final state: fresh-agent verification PASS, full suite green on both backends
(conformance, unit, integration, chaos incl. multi-process SIGKILL reclaim),
typecheck clean, e2e smoke against the live dashboard passing. No open
high/medium findings. v1.0.0 tagged.

Note: the round-2 idempotency fix changes storage schema (qw_idempotency gains
created_at; existing databases migrate automatically at init).
