import { describe, expect, it } from "vitest";
import {
  isValidTimezone,
  nextFireAfter,
  parseCron,
  wallOf,
} from "../src/cron.js";
import { InvalidCronError } from "../src/errors.js";

const U = (iso: string): number => Date.parse(iso);

function next(expr: string, tz: string, afterIso: string): number | null {
  return nextFireAfter(parseCron(expr), tz, U(afterIso));
}

function iso(ms: number | null): string {
  return ms === null ? "null" : new Date(ms).toISOString();
}

describe("cron parsing and validation", () => {
  it("rejects wrong field counts", () => {
    expect(() => parseCron("* * * *")).toThrow(InvalidCronError);
    expect(() => parseCron("* * * * * * *")).toThrow(InvalidCronError);
    expect(() => parseCron("")).toThrow(InvalidCronError);
  });

  it("rejects out-of-range values and bad steps", () => {
    expect(() => parseCron("61 * * * *")).toThrow(/minute/);
    expect(() => parseCron("* 24 * * *")).toThrow(/hour/);
    expect(() => parseCron("* * 32 * *")).toThrow(/day-of-month/);
    expect(() => parseCron("* * * 13 *")).toThrow(/month/);
    expect(() => parseCron("*/0 * * * *")).toThrow(/step/);
    expect(() => parseCron("5-1 * * * *")).toThrow(/descending/);
    expect(() => parseCron("foo * * * *")).toThrow(/not an integer/);
  });

  it("accepts 7 as sunday and names", () => {
    const p = parseCron("0 * * * SUN");
    expect(p.dows).toContain(0);
    expect(parseCron("0 0 * JAN *").months).toEqual(new Set([1]));
  });

  it("rejects unknown timezones", () => {
    expect(isValidTimezone("Europe/Berlin")).toBe(true);
    expect(isValidTimezone("Mars/Olympus")).toBe(false);
    expect(() => nextFireAfter(parseCron("* * * * *"), "Mars/Olympus", 0)).toThrow();
  });
});

describe("cron evaluation fixtures (UTC schedules)", () => {
  it("every five minutes", () => {
    expect(iso(next("*/5 * * * *", "UTC", "2026-08-22T14:02:00Z"))).toBe("2026-08-22T14:05:00.000Z");
    expect(iso(next("*/5 * * * *", "UTC", "2026-08-22T14:05:00Z"))).toBe("2026-08-22T14:10:00.000Z");
  });

  it("daily at midnight rolls over day/month/year", () => {
    expect(iso(next("0 0 * * *", "UTC", "2026-12-31T23:59:00Z"))).toBe("2027-01-01T00:00:00.000Z");
    expect(iso(next("0 0 * * *", "UTC", "2028-02-29T00:00:00Z"))).toBe("2028-03-01T00:00:00.000Z");
  });

  it("month-end day 31 skips short months", () => {
    expect(iso(next("0 0 31 * *", "UTC", "2026-01-31T00:00:01Z"))).toBe("2026-03-31T00:00:00.000Z");
    expect(iso(next("0 0 31 * *", "UTC", "2026-03-31T00:00:01Z"))).toBe("2026-05-31T00:00:00.000Z");
  });

  it("feb 29 fires only in leap years", () => {
    expect(iso(next("0 0 29 2 *", "UTC", "2026-01-01T00:00:00Z"))).toBe("2028-02-29T00:00:00.000Z");
    expect(iso(next("0 0 29 2 *", "UTC", "2028-02-29T00:00:01Z"))).toBe("2032-02-29T00:00:00.000Z");
  });

  it("weekday names and ranges", () => {
    expect(iso(next("0 9 * * MON-FRI", "UTC", "2026-08-21T18:00:00Z"))).toBe(
      "2026-08-24T09:00:00.000Z",
    );
    expect(iso(next("0 9 * * SAT,SUN", "UTC", "2026-08-21T18:00:00Z"))).toBe(
      "2026-08-22T09:00:00.000Z",
    );
  });

  it("vixie rule: restricted dom or restricted dow match either", () => {
    const p = parseCron("0 0 13 * FRI");
    const a = nextFireAfter(p, "UTC", U("2026-08-01T00:00:00Z"));
    expect(new Date(a!).getUTCDay() === 5 || new Date(a!).getUTCDate() === 13).toBe(true);
    expect(iso(a)).toBe("2026-08-07T00:00:00.000Z");
    expect(iso(next("0 0 13 * FRI", "UTC", "2026-08-07T00:00:01Z"))).toBe("2026-08-13T00:00:00.000Z");
  });
});

describe("cron evaluation fixtures (timezone-aware)", () => {
  it("keeps local 09:00 fixed across a DST change (Berlin)", () => {
    expect(iso(next("0 9 * * *", "Europe/Berlin", "2026-03-27T12:00:00Z"))).toBe(
      "2026-03-28T08:00:00.000Z",
    );
    expect(iso(next("0 9 * * *", "Europe/Berlin", "2026-03-28T09:00:00Z"))).toBe(
      "2026-03-29T07:00:00.000Z",
    );
  });

  it("spring-forward: nonexistent 02:30 is skipped (Berlin)", () => {
    expect(iso(next("30 2 * * *", "Europe/Berlin", "2026-03-27T12:00:00Z"))).toBe(
      "2026-03-28T01:30:00.000Z",
    );
    expect(iso(next("30 2 * * *", "Europe/Berlin", "2026-03-28T02:00:00Z"))).toBe(
      "2026-03-30T00:30:00.000Z",
    );
  });

  it("fall-back: ambiguous 02:30 fires once at its first instant (Berlin)", () => {
    expect(iso(next("30 2 * * *", "Europe/Berlin", "2026-10-25T00:00:00Z"))).toBe(
      "2026-10-25T00:30:00.000Z",
    );
    expect(iso(next("30 2 * * *", "Europe/Berlin", "2026-10-25T00:31:00Z"))).toBe(
      "2026-10-26T01:30:00.000Z",
    );
  });

  it("spring-forward: nonexistent 02:30 is skipped (New York)", () => {
    expect(iso(next("30 2 * * *", "America/New_York", "2026-03-06T12:00:00Z"))).toBe(
      "2026-03-07T07:30:00.000Z",
    );
    expect(iso(next("30 2 * * *", "America/New_York", "2026-03-07T12:01:00Z"))).toBe(
      "2026-03-09T06:30:00.000Z",
    );
  });

  it("fall-back: ambiguous 01:30 fires once at first instant (New York)", () => {
    expect(iso(next("30 1 * * *", "America/New_York", "2026-11-01T00:00:00Z"))).toBe(
      "2026-11-01T05:30:00.000Z",
    );
    expect(iso(next("30 1 * * *", "America/New_York", "2026-11-01T05:31:00Z"))).toBe(
      "2026-11-02T06:30:00.000Z",
    );
  });

  it("wall clock stays aligned over long spans (Kathmandu +05:45)", () => {
    expect(iso(next("0 6 * * *", "Asia/Kathmandu", "2026-08-21T20:00:00Z"))).toBe(
      "2026-08-22T00:15:00.000Z",
    );
  });
});

describe("seconds-resolution expressions", () => {
  it("six-field */10 fires within the minute", () => {
    expect(iso(next("*/10 * * * * *", "UTC", "2026-08-22T14:00:05Z"))).toBe("2026-08-22T14:00:10.000Z");
    expect(iso(next("30 45 9 * * *", "UTC", "2026-08-22T08:00:00Z"))).toBe("2026-08-22T09:45:30.000Z");
  });

  it("reports the wall clock correctly", () => {
    const w = wallOf(U("2026-08-22T14:00:00Z"), "Europe/Berlin");
    expect([w.h, w.mi]).toEqual([16, 0]);
  });
});
