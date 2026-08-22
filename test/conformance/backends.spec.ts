import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe } from "vitest";
import { FakeClock } from "../../src/util.js";
import { MemoryStorage } from "../../src/storage/memory.js";
import { SqliteStorage } from "../../src/storage/sqlite.js";
import type { StorageBackend } from "../../src/storage/interface.js";
import { runConformanceSuite } from "./storage-conformance.js";

describe("conformance: memory backend", () => {
  runConformanceSuite(async (clock) => new MemoryStorage({ now: () => clock.now() }));
});

describe("conformance: sqlite backend", () => {
  runConformanceSuite(async (clock) => {
    const dir = mkdtempSync(join(tmpdir(), "qw-conf-"));
    return new SqliteStorage({ file: join(dir, "q.db"), now: () => clock.now() });
  });
});
