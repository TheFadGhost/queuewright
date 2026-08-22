import { Writable } from "node:stream";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogFields {
  module?: string;
  jobId?: string;
  jobType?: string;
  queue?: string;
  attempt?: number;
  durationMs?: number;
  err?: { name: string; message: string; stack: string | null };
  kv?: Record<string, string | number | boolean | null>;
}

export interface LoggerOptions {
  level?: LogLevel;
  format?: "pretty" | "json";
  color?: boolean;
  stream?: Writable;
  now?: () => number;
}

const SENSITIVE_KEY = /pass|secret|token|auth|ssn|email/i;

export class Logger {
  private readonly levelNum: number;
  private readonly format: "pretty" | "json";
  private readonly color: boolean;
  private readonly stream: Writable;
  private readonly now: () => number;
  private unsafePayloadsWarned = false;

  constructor(opts: LoggerOptions = {}) {
    this.levelNum = LEVEL_ORDER[opts.level ?? "info"];
    this.format = opts.format ?? (process.stdout.isTTY ? "pretty" : "json");
    this.color =
      opts.color ?? (!process.env["NO_COLOR"] && process.stdout.isTTY === true);
    this.stream = opts.stream ?? process.stdout;
    this.now = opts.now ?? Date.now;
  }

  debug(msg: string, fields: LogFields = {}): void {
    this.log("debug", msg, fields);
  }
  info(msg: string, fields: LogFields = {}): void {
    this.log("info", msg, fields);
  }
  warn(msg: string, fields: LogFields = {}): void {
    this.log("warn", msg, fields);
  }
  error(msg: string, fields: LogFields = {}): void {
    this.log("error", msg, fields);
  }

  child(base: LogFields): ChildLogger {
    return new ChildLogger(this, base);
  }

  log(level: LogLevel, msg: string, fields: LogFields): void {
    if (LEVEL_ORDER[level] < this.levelNum) return;
    const ts = new Date(this.now()).toISOString();
    if (this.format === "json") {
      const rec: Record<string, unknown> = { ts, level, msg };
      for (const [k, v] of Object.entries(fields)) {
        if (v !== undefined) rec[k] = v;
      }
      this.stream.write(JSON.stringify(rec) + "\n");
      return;
    }
    const time = ts.slice(11, 19);
    const mod = (fields.module ?? "").padEnd(8);
    const padMsg = msg.padEnd(34);
    let line = `${time} ${level.padEnd(5)} ${mod} ${padMsg}`;
    const extras: string[] = [];
    if (fields.jobId) extras.push(fields.jobId);
    if (fields.jobType) extras.push(fields.jobType);
    if (fields.queue) extras.push(`queue=${fields.queue}`);
    if (fields.attempt !== undefined) extras.push(`attempt=${fields.attempt}`);
    if (fields.durationMs !== undefined) extras.push(`dur=${fmtDur(fields.durationMs)}`);
    for (const [k, v] of Object.entries(fields.kv ?? {})) extras.push(`${k}=${v}`);
    if (extras.length > 0) line += " " + extras.join(" ");
    if (fields.err) line += ` ${fields.err.name}: ${fields.err.message}`;
    line = line.trimEnd();
    this.stream.write(this.colorize(level, line) + "\n");
  }

  noteUnsafePayloads(): void {
    if (this.unsafePayloadsWarned) return;
    this.unsafePayloadsWarned = true;
    this.warn("unsafe payload logging enabled via QW_LOG_UNSAFE_PAYLOADS=1", {
      module: "logger",
    });
  }

  private colorize(level: LogLevel, line: string): string {
    if (!this.color) return line;
    const code = level === "error" ? 31 : level === "warn" ? 33 : level === "debug" ? 36 : 0;
    if (code === 0) return line;
    return `\x1b[${code}m${line}\x1b[0m`;
  }
}

export function redactPayload(payloadJson: string): string {
  try {
    const obj = JSON.parse(payloadJson);
    return JSON.stringify(redactValue(obj));
  } catch {
    return "[unparseable payload]";
  }
}

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEY.test(k) ? "***" : redactValue(v);
    }
    return out;
  }
  return value;
}

function fmtDur(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

class ChildLogger {
  constructor(
    private readonly parent: Logger,
    private readonly base: LogFields,
  ) {}

  debug(msg: string, fields: LogFields = {}): void {
    this.parent.debug(msg, merge(this.base, fields));
  }
  info(msg: string, fields: LogFields = {}): void {
    this.parent.info(msg, merge(this.base, fields));
  }
  warn(msg: string, fields: LogFields = {}): void {
    this.parent.warn(msg, merge(this.base, fields));
  }
  error(msg: string, fields: LogFields = {}): void {
    this.parent.error(msg, merge(this.base, fields));
  }
  child(base: LogFields): ChildLogger {
    return new ChildLogger(this.parent, merge(this.base, base));
  }
}

function merge(a: LogFields, b: LogFields): LogFields {
  return { ...a, ...b, kv: { ...a.kv, ...b.kv }, err: b.err ?? a.err };
}
