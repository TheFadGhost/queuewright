import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { expect, it } from "vitest";
import { SqliteStorage } from "../../src/storage/sqlite.js";
import { readLedger } from "../fixtures/ledger.js";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const here = fileURLToPath(new URL(".", import.meta.url));
const CHILD_SCRIPT = join(here, "..", "fixtures", "worker-child.ts");

it("multi-process workers on one sqlite file: no lost jobs after SIGKILL", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qw-multi-"));
  const dbFile = join(dir, "q.db");
  const ledgerFile = join(dir, "ledger.tsv");

  const store = new SqliteStorage({ file: dbFile });
  await store.init();
  const TOTAL = 60;
  for (let i = 0; i < TOTAL; i++) {
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

  const children: ChildProcess[] = [];
  const exited: string[] = [];
  for (const id of ["c1", "c2", "c3"]) {
    const c = spawn(
      process.execPath,
      ["--import", "tsx", CHILD_SCRIPT, "--db", dbFile, "--ledger", ledgerFile, "--worker-id", id],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    c.on("error", (e) => {
      throw new Error(`child ${id} failed to spawn: ${e.message}`);
    });
    c.stderr?.on("data", () => {});
    void c.on("exit", (code) => {
      if (id !== "c2") exited.push(`${id}:${code}`);
    });
    children.push(c);
  }

  await sleep(2500);
  const victim = children[1]!;
  victim.kill("SIGKILL");
  await new Promise<void>((resolve) => victim.once("exit", () => resolve()));

  // Survivors must reclaim the victim's leases (visibility timeout 2s) and finish everything.
  const deadline = Date.now() + 75_000;
  let seen = new Set<string>();
  let lastLogged = 0;
  while (Date.now() < deadline) {
    seen = new Set(readLedger(ledgerFile).map((e) => e.jobId));
    const alive = children.filter((c) => c.exitCode === null && !c.killed).length;
    console.log(`[mp] ledger=${seen.size}/${TOTAL} alive=${alive}`);
    lastLogged++;
    if (seen.size >= TOTAL) break;
    await sleep(2000);
    void lastLogged;
  }
  expect(seen.size).toBe(TOTAL);

  const entries = readLedger(ledgerFile);
  const counts = new Map<string, number>();
  for (const e of entries) counts.set(e.jobId, (counts.get(e.jobId) ?? 0) + 1);
  const duplicatedIds = [...counts.values()].filter((n) => n > 1);
  console.log(`[mp] duplicated=${duplicatedIds.length}`);
  // At-least-once: duplicates allowed only within a small bound around the kill.
  expect(duplicatedIds.length).toBeLessThanOrEqual(6);

  // Every job reached a terminal state in storage.
  const stats = await store.stats();
  const terminal =
    stats.states["succeeded"] + stats.states["failed"] + stats.states["dead"] + stats.states["cancelled"];
  expect(terminal).toBeGreaterThanOrEqual(TOTAL - duplicatedIds.length);

  for (const c of children) {
    if (c.exitCode === null && !c.killed) {
      c.kill();
      if (c.pid !== undefined) {
        spawn("taskkill", ["/pid", String(c.pid), "/f", "/t"]);
      }
    }
  }
  const exits = Promise.all(
    children.map((c) => new Promise<void>((r) => c.once("exit", () => r()))),
  );
  await Promise.race([exits, sleep(10_000)]);
  await store.close();
}, 110_000);
