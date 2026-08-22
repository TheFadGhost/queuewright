import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { SqliteStorage } from "../src/storage/sqlite.js";
import { readLedger } from "../test/fixtures/ledger.js";

const dir = mkdtempSync(join(tmpdir(), "qw-manual2-"));
const dbFile = join(dir, "q.db");
const ledgerFile = join(dir, "l.tsv");
const store = new SqliteStorage({ file: dbFile });
await store.init();
for (let i = 0; i < 5; i++) {
  await store.enqueue({
    type: "chaos.work",
    queue: "default",
    payload: JSON.stringify({ n: i }),
    payloadVersion: 1,
    priority: 0,
    runAt: Date.now(),
    maxAttempts: 3,
    timeoutMs: 5000,
    retry: { strategy: "fixed", baseDelayMs: 200, maxDelayMs: 200, jitter: "none" },
    dedupeKey: null,
    scheduleId: null,
    onSuccess: null,
  });
}
console.log("enqueued 5");
const child = spawn(
  process.execPath,
  ["--import", "tsx", join("test", "fixtures", "worker-child.ts"), "--db", dbFile, "--ledger", ledgerFile, "--worker-id", "m1"],
  { stdio: ["ignore", "pipe", "pipe"] },
);
child.stdout?.on("data", (d) => console.log("[child-out]", String(d).trim()));
child.stderr?.on("data", (d) => console.log("[child-err]", String(d).split("\n")[0].trim()));
await new Promise((r) => setTimeout(r, 12_000));
console.log("ledger:", readLedger(ledgerFile));
console.log("stats:", JSON.stringify((await store.stats()).states));
child.kill();
await store.close();
process.exit(0);
