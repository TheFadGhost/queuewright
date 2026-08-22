import { parseArgs } from "node:util";
import { MemoryStorage } from "../../src/storage/memory.js";
import { SqliteStorage } from "../../src/storage/sqlite.js";
import { Queuewright } from "../../src/client.js";
import { defineJob } from "../../src/registry.js";
import { recordExecution } from "./ledger.js";

const { values } = parseArgs({
  options: {
    ledger: { type: "string" },
    "worker-id": { type: "string" },
    db: { type: "string" },
    hang: { type: "string" },
  },
});

const ledger = values.ledger!;
const workerId = values["worker-id"] ?? "child";
let hangAfter = values.hang ? Number(values.hang) : -1;

defineJob<{ n: number }>("chaos.work", {}, async (payload) => {
  if (hangAfter >= 0 && payload.n >= hangAfter) {
    hangAfter = -2;
    await new Promise(() => {}); // simulate a hung handler
  }
  recordExecution(ledger, payload.n.toString(), workerId);
});

const storage = values.db
  ? new SqliteStorage({ file: values.db })
  : new MemoryStorage();

const qw = new Queuewright({
  storageInstance: storage,
  concurrency: 4,
  pollIntervalMs: 20,
  visibilityTimeoutMs: 2000,
});
await qw.init();
const worker = qw.createWorker();
worker.start();
process.on("disconnect", () => {
  void worker.stop().then(() => process.exit(0));
});
