# Queuewright benchmarks

Method: `scripts/bench.ts` — enqueue N jobs (batches of 100), start one worker
process in-process, drain until all succeed, report wall-clock throughput and
per-attempt execution latency percentiles read from job attempt history.
No warmup runs; numbers are single-run medians of one invocation.

Environment: Windows 11 x64, Node v24.14.1, local NVMe SSD (Win32 temp dir),
Queuewright 0.x, no other significant load.

| backend | jobs | payload | worker concurrency | enqueue jobs/s | processed jobs/s | exec latency p50 | p95 | p99 |
|---|---|---|---|---|---|---|---|---|
| sqlite | 2,000 | 511 B | 4 | 7,520 | 257 | 1 ms | 2 ms | 2 ms |
| memory | 50,000 | 511 B | 4 | 170,153 | 417 | 3 ms | 3 ms | 4 ms |

Notes:

- Processed throughput is bounded by the claim loop's poll interval (default
  250 ms; the bench uses 5 ms) and by per-claim transaction cost on sqlite.
  It is intentionally not tuned to look impressive; reliability outranks
  throughput.
- These numbers are from the hardware and software stated above. They are not
  predictions for your machine. Re-run `npx tsx scripts/bench.ts <payloadBytes>
  <jobs> <concurrency> <sqlite|memory>` to measure your own.

Reproduce:

```
npm install
npx tsx scripts/bench.ts 512 2000 4 sqlite
npx tsx scripts/bench.ts 512 50000 4 memory
```
