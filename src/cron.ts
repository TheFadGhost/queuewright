import { InvalidCronError, InvalidTimezoneError } from "./errors.js";

const MONTH_NAMES: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const DOW_NAMES: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

interface FieldSpec {
  min: number;
  max: number;
  names?: Record<string, number>;
}

const SECOND_SPEC: FieldSpec = { min: 0, max: 59 };
const MINUTE_SPEC: FieldSpec = { min: 0, max: 59 };
const HOUR_SPEC: FieldSpec = { min: 0, max: 23 };
const DOM_SPEC: FieldSpec = { min: 1, max: 31 };
const MONTH_SPEC: FieldSpec = { min: 1, max: 12, names: MONTH_NAMES };
const DOW_SPEC: FieldSpec = { min: 0, max: 7, names: DOW_NAMES };

export interface ParsedCron {
  expression: string;
  hasSeconds: boolean;
  seconds: Set<number>;
  minutes: Set<number>;
  hours: Set<number>;
  doms: Set<number> | null;
  months: Set<number>;
  dows: Set<number> | null;
}

function parseValue(token: string, spec: FieldSpec): number {
  const t = token.toLowerCase();
  if (spec.names && t in spec.names) return spec.names[t]!;
  const n = Number(token);
  if (!Number.isInteger(n)) throw new Error(`"${token}" is not an integer or known name`);
  return n;
}

function parseField(expr: string, spec: FieldSpec): Set<number> {
  const out = new Set<number>();
  for (const part of expr.split(",")) {
    if (part.length === 0) throw new Error("empty list element");
    let body = part;
    let step = 1;
    const slash = part.indexOf("/");
    if (slash >= 0) {
      body = part.slice(0, slash);
      step = Number(part.slice(slash + 1));
      if (!Number.isInteger(step) || step < 1) {
        throw new Error(`step must be a positive integer, got "${part.slice(slash + 1)}"`);
      }
    }
    let lo: number;
    let hi: number;
    if (body === "*") {
      lo = spec.min;
      hi = spec.max;
    } else if (body.includes("-")) {
      const idx = body.indexOf("-");
      lo = parseValue(body.slice(0, idx), spec);
      hi = parseValue(body.slice(idx + 1), spec);
      if (hi < lo) throw new Error(`range ${lo}-${hi} is descending`);
    } else {
      lo = parseValue(body, spec);
      hi = slash >= 0 ? spec.max : lo;
    }
    for (let v = lo; v <= hi; v += step) {
      out.add(spec === DOW_SPEC && v === 7 ? 0 : v);
    }
  }
  return out;
}

function parseSingle(expression: string, raw: string, spec: FieldSpec, label: string): Set<number> {
  try {
    const set = parseField(raw, spec);
    for (const v of set) {
      if (v < spec.min || v > spec.max) {
        throw new Error(`${label} value ${v} out of range ${spec.min}-${spec.max}`);
      }
    }
    return set;
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    throw new InvalidCronError(expression, `field "${label}": ${reason}`);
  }
}

export function parseCron(expression: string): ParsedCron {
  const trimmed = expression.trim().replace(/\s+/g, " ");
  if (trimmed.length === 0) throw new InvalidCronError(expression, "empty expression");
  const parts = trimmed.split(" ");
  if (parts.length !== 5 && parts.length !== 6) {
    throw new InvalidCronError(
      expression,
      `expected 5 fields (min hour dom month dow) or 6 with leading seconds, got ${parts.length}`,
    );
  }
  const six = parts.length === 6;
  const secRaw = six ? parts[0]! : "0";
  const minRaw = six ? parts[1]! : parts[0]!;
  const hourRaw = six ? parts[2]! : parts[1]!;
  const domRaw = six ? parts[3]! : parts[2]!;
  const monRaw = six ? parts[4]! : parts[3]!;
  const dowRaw = six ? parts[5]! : parts[4]!;
  return {
    expression: trimmed,
    hasSeconds: six,
    seconds: parseSingle(trimmed, secRaw, SECOND_SPEC, "second"),
    minutes: parseSingle(trimmed, minRaw, MINUTE_SPEC, "minute"),
    hours: parseSingle(trimmed, hourRaw, HOUR_SPEC, "hour"),
    doms: domRaw === "*" ? null : parseSingle(trimmed, domRaw, DOM_SPEC, "day-of-month"),
    months: parseSingle(trimmed, monRaw, MONTH_SPEC, "month"),
    dows: dowRaw === "*" ? null : parseSingle(trimmed, dowRaw, DOW_SPEC, "day-of-week"),
  };
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatterCache.get(tz);
  if (!f) {
    let probe: Intl.DateTimeFormat;
    try {
      probe = new Intl.DateTimeFormat("en-US", { timeZone: tz });
    } catch {
      throw new InvalidTimezoneError(tz);
    }
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      hourCycle: "h23",
    });
    void probe;
    formatterCache.set(tz, f);
  }
  return f;
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export interface WallClock {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

export function wallOf(utcMs: number, tz: string): WallClock {
  const parts = formatter(tz).formatToParts(new Date(utcMs));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? "0");
  return { y: get("year"), mo: get("month"), d: get("day"), h: get("hour"), mi: get("minute"), s: get("second") };
}

function naiveMs(w: WallClock): number {
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
}

function fromNaive(ms: number): WallClock {
  const d = new Date(ms);
  return {
    y: d.getUTCFullYear(),
    mo: d.getUTCMonth() + 1,
    d: d.getUTCDate(),
    h: d.getUTCHours(),
    mi: d.getUTCMinutes(),
    s: d.getUTCSeconds(),
  };
}

function equalsWall(a: WallClock, b: WallClock): boolean {
  return a.y === b.y && a.mo === b.mo && a.d === b.d && a.h === b.h && a.mi === b.mi && a.s === b.s;
}

/**
 * Convert a wall-clock time to the first UTC instant that renders as that
 * local time. Returns null when the local time does not exist (DST gap).
 */
export function wallToUtc(w: WallClock, tz: string): number | null {
  const target = naiveMs(w);
  let guess = target - 12 * 3600_000;
  for (let i = 0; i < 4; i++) {
    const off = naiveMs(wallOf(guess, tz)) - guess;
    const candidate = target - off;
    const off2 = naiveMs(wallOf(candidate, tz)) - candidate;
    if (off2 !== off) {
      guess = candidate;
      continue;
    }
    return equalsWall(wallOf(candidate, tz), w) ? candidate : null;
  }
  return null;
}

function dayMatches(p: ParsedCron, w: WallClock): boolean {
  if (!p.months.has(w.mo)) return false;
  if (p.doms === null && p.dows === null) return true;
  const dowJs = new Date(Date.UTC(w.y, w.mo - 1, w.d)).getUTCDay();
  if (p.doms !== null && p.dows === null) return p.doms.has(w.d);
  if (p.doms === null && p.dows !== null) return p.dows.has(dowJs);
  return p.doms!.has(w.d) || p.dows!.has(dowJs);
}

function advance(w: WallClock, deltaMs: number): WallClock {
  return fromNaive(naiveMs(w) + deltaMs);
}

/**
 * Next fire strictly after afterUtcMs, evaluated in wall-clock space with
 * coarse skipping. DST: nonexistent local times never fire; ambiguous local
 * times fire once at their first real instant. Returns null past 4 years.
 */
export function nextFireAfter(parsed: ParsedCron, tz: string, afterUtcMs: number): number | null {
  let w = advance(wallOf(afterUtcMs, tz), 1000);
  const limit = afterUtcMs + 4 * 366 * 24 * 3600_000;
  for (let guard = 0; guard < 8_000_000; guard++) {
    if (!parsed.months.has(w.mo)) {
      w = fromNaive(Date.UTC(w.y, w.mo, 1));
      continue;
    }
    if (!dayMatches(parsed, w)) {
      w = fromNaive(Date.UTC(w.y, w.mo - 1, w.d + 1));
      continue;
    }
    if (!parsed.hours.has(w.h)) {
      w = fromNaive(Date.UTC(w.y, w.mo - 1, w.d, w.h + 1));
      continue;
    }
    if (!parsed.minutes.has(w.mi)) {
      w = fromNaive(Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi + 1));
      continue;
    }
    if (!parsed.seconds.has(w.s)) {
      w = fromNaive(Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s + 1));
      continue;
    }
    const utc = wallToUtc(w, tz);
    if (utc === null || !equalsWall(wallOf(utc, tz), w)) {
      w = advance(w, 1000);
      continue;
    }
    if (utc <= afterUtcMs) {
      w = advance(w, 1000);
      continue;
    }
    if (utc > limit) return null;
    return utc;
  }
  return null;
}

