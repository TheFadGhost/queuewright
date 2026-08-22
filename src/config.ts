import { existsSync, readFileSync } from "node:fs";
import { ConfigValidationError } from "./errors.js";
import { isValidTimezone } from "./cron.js";
import type { ConcurrencyLimit, RateLimitRule, StorageBackend } from "./storage/index.js";
import type { LoggerOptions } from "./observability/logger.js";

export interface StorageFileConfig {
  kind: "sqlite";
  file?: string;
}

export interface StorageMemoryConfig {
  kind: "memory";
}

export type StorageConfig = StorageFileConfig | StorageMemoryConfig;

export interface ScheduleInput {
  id: string;
  cron: string;
  timezone?: string;
  jobType: string;
  queue?: string;
  payload?: unknown;
  priority?: number;
  maxAttempts?: number;
  timeoutMs?: number;
  onMissed?: "catch_up" | "skip" | "run_once";
  paused?: boolean;
}

export interface QueuewrightConfig {
  storage?: StorageConfig;
  storageInstance?: StorageBackend;
  concurrency?: number;
  visibilityTimeoutMs?: number;
  pollIntervalMs?: number;
  maxPayloadBytes?: number;
  retentionMs?: number;
  shutdownDeadlineMs?: number;
  queues?: string[];
  now?: () => number;
  rateRules?: RateLimitRule[];
  concurrencyLimits?: ConcurrencyLimit[];
  schedules?: ScheduleInput[];
  log?: LoggerOptions;
  dashboard?: { port?: number; host?: string } | false;
}

export const DEFAULTS = {
  concurrency: 4,
  visibilityTimeoutMs: 30_000,
  pollIntervalMs: 250,
  maxPayloadBytes: 256 * 1024,
  retentionMs: 7 * 24 * 3600_000,
  shutdownDeadlineMs: 30_000,
  dashboardPort: 7788,
  dashboardHost: "127.0.0.1",
} as const;

interface Problem {
  path: string;
  expected: string;
  got: string;
  fix: string;
}

function isInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v);
}

export function validateConfig(cfg: QueuewrightConfig): void {
  const problems: Problem[] = [];
  const intBetween =
    (lo: number) =>
    (v: unknown): boolean =>
      isInt(v) && v >= lo;
  check(problems, cfg.concurrency, "concurrency", intBetween(1), "positive integer", DEFAULTS.concurrency);
  check(
    problems,
    cfg.visibilityTimeoutMs,
    "visibilityTimeoutMs",
    intBetween(1000),
    "integer >= 1000",
    DEFAULTS.visibilityTimeoutMs,
  );
  check(problems, cfg.pollIntervalMs, "pollIntervalMs", intBetween(10), "integer >= 10", DEFAULTS.pollIntervalMs);
  check(problems, cfg.maxPayloadBytes, "maxPayloadBytes", intBetween(1), "positive integer", DEFAULTS.maxPayloadBytes);
  check(problems, cfg.retentionMs, "retentionMs", intBetween(1000), "integer >= 1000", DEFAULTS.retentionMs);
  check(
    problems,
    cfg.shutdownDeadlineMs,
    "shutdownDeadlineMs",
    intBetween(0),
    "non-negative integer",
    DEFAULTS.shutdownDeadlineMs,
  );
  if (cfg.queues !== undefined) {
    if (!Array.isArray(cfg.queues) || cfg.queues.length === 0 || !cfg.queues.every((q) => /^[a-z0-9-_]+$/.test(q))) {
      problems.push({
        path: "queues",
        expected: "array of lowercase queue names matching [a-z0-9-_]",
        got: JSON.stringify(cfg.queues),
        fix: 'list queues like ["default", "email"] or omit to serve every queue',
      });
    }
  }
  if (cfg.storage !== undefined && cfg.storage.kind === "sqlite") {
    if (cfg.storage.file !== undefined && typeof cfg.storage.file !== "string") {
      problems.push({ path: "storage.file", expected: "string path", got: String(cfg.storage.file), fix: "set a file path like ./data/qw.db or omit for the default" });
    }
  }
  if (cfg.rateRules !== undefined) {
    cfg.rateRules.forEach((r, i) => {
      if (!/^(queue|type):[a-zA-Z0-9._-]+$/.test(r.key)) {
        problems.push({ path: `rateRules[${i}].key`, expected: '"queue:<name>" or "type:<jobType>"', got: r.key, fix: 'prefix the key with "queue:" or "type:"' });
      }
      if (!intBetween(1)(r.limit)) {
        problems.push({ path: `rateRules[${i}].limit`, expected: "positive integer", got: String(r.limit), fix: "set limit >= 1" });
      }
      if (!intBetween(1)(r.windowMs)) {
        problems.push({ path: `rateRules[${i}].windowMs`, expected: "positive integer", got: String(r.windowMs), fix: "set windowMs >= 1" });
      }
    });
  }
  if (cfg.concurrencyLimits !== undefined) {
    cfg.concurrencyLimits.forEach((l, i) => {
      if (!/^(queue|type):[a-zA-Z0-9._-]+$/.test(l.key)) {
        problems.push({ path: `concurrencyLimits[${i}].key`, expected: '"queue:<name>" or "type:<jobType>"', got: l.key, fix: 'prefix the key with "queue:" or "type:"' });
      }
      if (!intBetween(1)(l.max)) {
        problems.push({ path: `concurrencyLimits[${i}].max`, expected: "positive integer", got: String(l.max), fix: "set max >= 1" });
      }
    });
  }
  (cfg.schedules ?? []).forEach((s, i) => {
    if (!s.id) {
      problems.push({ path: `schedules[${i}].id`, expected: "non-empty id", got: String(s.id), fix: "give the schedule a stable unique id" });
    }
    if (s.timezone !== undefined && !isValidTimezone(s.timezone)) {
      problems.push({ path: `schedules[${i}].timezone`, expected: "IANA timezone name", got: s.timezone, fix: 'use a zone like "UTC" or "Europe/Berlin"' });
    }
    if (s.onMissed !== undefined && !["catch_up", "skip", "run_once"].includes(s.onMissed)) {
      problems.push({ path: `schedules[${i}].onMissed`, expected: '"catch_up" | "skip" | "run_once"', got: String(s.onMissed), fix: "pick one of the three documented policies" });
    }
  });
  if (problems.length > 0) throw new ConfigValidationError(problems);
}

function check(
  problems: Problem[],
  value: unknown,
  path: string,
  ok: (v: unknown) => boolean,
  expectation: string,
  fallback: number,
): void {
  if (value === undefined) return;
  if (!ok(value)) {
    problems.push({
      path,
      expected: expectation,
      got: JSON.stringify(value),
      fix: `set ${path} to ${expectation}, or remove it to use the default (${fallback})`,
    });
  }
}

export function loadConfigFile(path: string): Partial<QueuewrightConfig> {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8");
  try {
    return JSON.parse(raw) as Partial<QueuewrightConfig>;
  } catch (e) {
    throw new ConfigValidationError([
      {
        path,
        expected: "valid JSON config file",
        got: e instanceof Error ? e.message : String(e),
        fix: `fix the JSON syntax in ${path} or delete the file to use defaults`,
      },
    ]);
  }
}
