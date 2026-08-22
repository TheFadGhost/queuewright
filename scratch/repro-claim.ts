import { MemoryStorage } from "../src/storage/memory.js";
import { FakeClock } from "../src/util.js";

const clock = new FakeClock();
const s = new MemoryStorage({ now: () => clock.now() });
await s.init();
const j = await s.enqueue({
  type: "test.work",
  queue: "default",
  payload: "{}",
  payloadVersion: 1,
  priority: 0,
  runAt: 0,
  maxAttempts: 3,
  timeoutMs: 30000,
  retry: { strategy: "exponential", baseDelayMs: 1000, maxDelayMs: 60000, jitter: "none" },
  dedupeKey: null,
  scheduleId: null,
  onSuccess: null,
});
console.log("enqueued", j.id, j.state);
const c = await s.claim({ workerId: "w", queues: ["default"], limit: 1, visibilityTimeoutMs: 5000 });
console.log("claimed", c.length);
