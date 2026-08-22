import { describe, expect, it } from "vitest";
import { SeededRng, nextRetryDelayMs, rawDelay } from "../src/retry.js";
import type { RetryPolicy } from "../src/types.js";

const base: RetryPolicy = {
  strategy: "exponential",
  baseDelayMs: 1000,
  maxDelayMs: 60_000,
  jitter: "none",
};

describe("raw delay schedules", () => {
  it("exponential doubles per attempt and caps at max", () => {
    expect(rawDelay(base, 1)).toBe(1000);
    expect(rawDelay(base, 2)).toBe(2000);
    expect(rawDelay(base, 3)).toBe(4000);
    expect(rawDelay(base, 7)).toBe(60_000);
    expect(rawDelay(base, 20)).toBe(60_000);
  });

  it("linear grows by base each attempt", () => {
    const p = { ...base, strategy: "linear" as const };
    expect(rawDelay(p, 1)).toBe(1000);
    expect(rawDelay(p, 2)).toBe(2000);
    expect(rawDelay(p, 5)).toBe(5000);
  });

  it("fixed is constant", () => {
    const p = { ...base, strategy: "fixed" as const, baseDelayMs: 750 };
    for (let a = 1; a <= 5; a++) expect(rawDelay(p, a)).toBe(750);
  });

  it("caps apply before jitter", () => {
    const p = { ...base, maxDelayMs: 2500 };
    expect(rawDelay(p, 3)).toBe(2500);
  });
});

describe("jitter bounds", () => {
  const rng = new SeededRng(42);

  function sampleBounds(policy: RetryPolicy, attempt: number): [number, number] {
    let lo = Number.MAX_SAFE_INTEGER;
    let hi = -1;
    for (let i = 0; i < 3000; i++) {
      const d = nextRetryDelayMs(policy, attempt, rng);
      lo = Math.min(lo, d);
      hi = Math.max(hi, d);
    }
    return [lo, hi];
  }

  it("full jitter stays within [0, raw]", () => {
    const p: RetryPolicy = { ...base, jitter: "full" };
    const [lo, hi] = sampleBounds(p, 2);
    expect(lo).toBeGreaterThanOrEqual(0);
    expect(hi).toBeLessThanOrEqual(2000);
    expect(hi).toBeGreaterThan(1800);
  });

  it("equal jitter stays within [raw/2, raw]", () => {
    const p: RetryPolicy = { ...base, jitter: "equal" };
    const [lo, hi] = sampleBounds(p, 2);
    expect(lo).toBeGreaterThanOrEqual(1000);
    expect(hi).toBeLessThanOrEqual(2000);
    expect(hi).toBeGreaterThan(1900);
  });

  it("full jitter with cap never exceeds maxDelay", () => {
    const p: RetryPolicy = { ...base, jitter: "full", maxDelayMs: 5000 };
    const [, hi] = sampleBounds(p, 10);
    expect(hi).toBeLessThanOrEqual(5000);
  });

  it("no jitter is exact", () => {
    const p: RetryPolicy = { ...base, jitter: "none" };
    expect(nextRetryDelayMs(p, 4)).toBe(8000);
  });
});
