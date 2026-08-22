# Queuewright PLAN.md

Feature ideation, judged against three tests: (1) does it serve the core
purpose - running deferred work reliably; (2) can it be finished to the same
quality bar as the rest; (3) does it avoid expanding scope into a second
product.

## Accepted

| Feature | Reason |
|---|---|
| Sensible defaults so a worker runs with almost no config | Directly serves the core promise; trivial to finish; documented in DESIGN.md section 10. |
| In-process test mode (`createTestClient`) running jobs synchronously on a fake clock | Makes handlers unit-testable without infrastructure; small, bounded surface. |
| Helpful errors for unregistered job types and invalid cron expressions | Error taxonomy already requires actionable messages; this is applying it consistently. |
| Job progress reporting API (`ctx.progress`) | Tiny addition to the handler context; surfaces in dashboard detail view. |
| Job chaining / continuation (`onSuccess` pointer to another definition) | Accepted in minimal form only: a single successor enqueued on success. Explicitly NOT a DAG engine: no fan-in, no parallel branches, no workflow state. |
| Batch enqueueing | Reliability primitive (atomic batch), not a new product. |
| Dashboard keyboard navigation + visible focus | Required by the design audit criteria anyway; part of the dashboard, not a new surface. |
| CLI machine-readable output (`--json`, stable fields, exit codes) | Operations work needs scriptable output; zero new concepts. |
| Migration path when a job definition changes (`payloadVersion.migrate`) | Payload-shape drift is a real reliability hazard; a single migrate hook is finishable and honest about its limits. |
| Idempotency helper (`ctx.idempotency(key, fn)`) storage-backed | The delivery contract demands handlers be idempotent; shipping the helper is cheaper than arguing. |

## Rejected

| Feature | Reason |
|---|---|
| General workflow orchestration DAG engine | Second product; chaining covers the 90% case without graph semantics. |
| Distributed cron cluster with leader election across regions | Second product; schedules are durable rows evaluated by any worker with CAS claiming, which is enough for one shared store. |
| Hosted service with accounts | Different business, different threat model. |
| Message broker features (topics, pub/sub, consumer groups) | Queuewright queues jobs, it does not broker streams; blurring that hurts the delivery contract story. |
| Alerting thresholds / notification pipelines in the dashboard | Expands into an alerting product; we expose Prometheus `/metrics` and let existing alert managers do their job. |
| Theme gallery beyond light/dark/high-contrast + two terminal themes | An ops tool does not need a theme gallery (DESIGN.md point of view). |
| Exactly-once delivery mode | Impossible to promise over storage+at-least-once execution; promising it would be dishonest. |
| Plugin marketplace / third-party backend registry | Unbounded surface, quality bar impossible to hold. |
| Webhook/HTTP source triggers | Turns the queue into an ingress gateway - second product. |
| Built-in payload encryption | Crypto choices belong to the application; we would ship footguns. Documented guidance instead. |

## Build order (dependency-driven)

1. Contracts: types, errors, state machine, storage interface (owner: lead).
2. Observability primitives (logger, metrics registry) - used by everything.
3. Retry strategies + cron engine with fixture tests.
4. Storage backends (memory, sqlite) + conformance suite.
5. Queue client, dedupe, idempotency, test mode.
6. Rate limiting + queue controls integrated into claim path.
7. Worker runtime (claim loop, heartbeats, timeouts, graceful shutdown).
8. Scheduler (cron + missed policies).
9. Dashboard API server; then UI built strictly from DESIGN.md tokens.
10. CLI.
11. Chaos harness, integration suites, README, benchmarks.
12. Audits (fresh agents), fixes, releases.

## Release gates

- v0.1.0: enqueue -> execute -> retry -> observe works end-to-end (README
  example runs verbatim).
- minor per major subsystem landing.
- v1.0.0: zero findings from independent audit agents (code, API ergonomics,
  design), full conformance + chaos green on both backends from clean.
