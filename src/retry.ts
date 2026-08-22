import type { JitterMode, RetryPolicy } from "./types.js";

export interface Rng {
  next(): number;
}

export class DefaultRng implements Rng {
  next(): number {
    return Math.random();
  }
}

export class SeededRng implements Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0 || 1;
  }

  next(): number {
    let x = this.state;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.state = x >>> 0;
    return this.state / 4294967296;
  }
}

export function rawDelay(policy: RetryPolicy, failedAttempt: number): number {
  const n = Math.max(1, failedAttempt);
  let d: number;
  switch (policy.strategy) {
    case "exponential":
      d = policy.baseDelayMs * Math.pow(2, n - 1);
      break;
    case "linear":
      d = policy.baseDelayMs * n;
      break;
    case "fixed":
      d = policy.baseDelayMs;
      break;
  }
  return Math.min(d, policy.maxDelayMs);
}

export function applyJitter(delay: number, mode: JitterMode, rng: Rng): number {
  switch (mode) {
    case "none":
      return delay;
    case "full":
      return Math.floor(rng.next() * (delay + 1));
    case "equal": {
      const half = delay / 2;
      return Math.floor(half + rng.next() * (half + 1));
    }
  }
}

/**
 * Delay before retry after `failedAttempt` (1-based). Result is bounded to
 * [0, maxDelayMs] for full jitter, [ceil(maxDelay/2), maxDelay] for equal,
 * exactly min(raw, maxDelay) for none.
 */
export function nextRetryDelayMs(
  policy: RetryPolicy,
  failedAttempt: number,
  rng: Rng = new DefaultRng(),
): number {
  const base = rawDelay({ ...policy, maxDelayMs: Number.MAX_SAFE_INTEGER }, failedAttempt);
  const capped = Math.min(base, policy.maxDelayMs);
  return Math.max(0, applyJitter(capped, policy.jitter, rng));
}
