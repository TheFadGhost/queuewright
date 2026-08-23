#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  ConfigValidationError,
  DrainTimeoutError,
  DuplicateDefinitionError,
  InvalidCronError,
  InvalidTimezoneError,
  InvalidTransitionError,
  JobNotFoundError,
  PayloadTooLargeError,
  QueuewrightError,
  RateLimitConfigError,
  UnregisteredJobTypeError,
} from "./errors.js";
import { loadConfigFile, type QueuewrightConfig } from "./config.js";
import { Queuewright } from "./client.js";
import { registeredTypes } from "./registry.js";
import type { LoggerOptions } from "./observability/logger.js";
import type { Worker } from "./worker.js";
import { JOB_STATES } from "./types.js";
import type {
  AttemptRecord,
  JobRecord,
  JobState,
  LifecycleEvent,
  ListJobsQuery,
  OnMissedPolicy,
  ScheduleRecord,
} from "./types.js";

type RawEnqueueOpts = Parameters<Queuewright["rawEnqueue"]>[2];

class UsageError extends Error {
  readonly hint: string | null;
  constructor(message: string, hint: string | null = null) {
    super(message);
    this.hint = hint;
  }
}

function usage(message: string, hint: string | null = null): UsageError {
  return new UsageError(message, hint);
}

interface Globals {
  json: boolean;
  noColor: boolean;
  help: boolean;
  config: string | null;
}

const DEFAULT_CONFIG_FILE = "./queuewright.json";
const DEFAULT_LIMIT = 20;

function extractGlobals(argv: string[]): { globals: Globals; rest: string[] } {
  const globals: Globals = { json: false, noColor: false, help: false, config: null };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    if (tok === "--json") globals.json = true;
    else if (tok === "--no-color") globals.noColor = true;
    else if (tok === "--help") globals.help = true;
    else if (tok === "--config") {
      const v = argv[i + 1];
      if (v === undefined) throw usage('option "--config" requires a file path');
      globals.config = v;
      i++;
    } else if (tok.startsWith("--config=")) {
      const v = tok.slice("--config=".length);
      if (v.length === 0) throw usage('option "--config" requires a file path');
      globals.config = v;
    } else {
      rest.push(tok);
    }
  }
  return { globals, rest };
}

interface FlagSpec {
  name: string;
  value: boolean;
}

interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string | boolean>;
}

function parseFlags(argv: string[], specs: readonly FlagSpec[]): ParsedArgs {
  const known = new Map<string, FlagSpec>(specs.map((s) => [s.name, s]));
  const positionals: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    if (!tok.startsWith("--")) {
      positionals.push(tok);
      continue;
    }
    const body = tok.slice(2);
    const eq = body.indexOf("=");
    const name = eq >= 0 ? body.slice(0, eq) : body;
    const inlineValue = eq >= 0 ? body.slice(eq + 1) : null;
    if (name.length === 0) throw usage(`malformed option "${tok}"`);
    const spec = known.get(name);
    if (!spec) {
      throw usage(
        `unknown option "--${name}"`,
        specs.length > 0
          ? `valid options for this command: ${specs.map((s) => `--${s.name}`).join(", ")}`
          : "this command takes no options besides the global flags",
      );
    }
    if (spec.value) {
      let value: string;
      if (inlineValue !== null) value = inlineValue;
      else {
        const next = argv[i + 1];
        if (next === undefined) throw usage(`option "--${name}" requires a value`);
        value = next;
        i++;
      }
      flags.set(name, value);
    } else if (inlineValue !== null) {
      const b = inlineValue.toLowerCase();
      if (b !== "true" && b !== "false") {
        throw usage(
          `option "--${name}" is boolean; got "${inlineValue}"`,
          "pass it bare, or as --flag=true / --flag=false",
        );
      }
      flags.set(name, b === "true");
    } else {
      flags.set(name, true);
    }
  }
  return { positionals, flags };
}

function strFlag(args: ParsedArgs, name: string): string | undefined {
  const v = args.flags.get(name);
  if (v === undefined) return undefined;
  if (typeof v === "boolean") throw usage(`option "--${name}" requires a value`);
  return v;
}

function boolFlag(args: ParsedArgs, name: string): boolean {
  return args.flags.get(name) === true;
}

function intFlag(args: ParsedArgs, name: string, min: number): number | undefined {
  const v = strFlag(args, name);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min) {
    throw usage(`option "--${name}" expects an integer >= ${min}, got "${v}"`);
  }
  return n;
}

function positional(args: ParsedArgs, index: number): string | undefined {
  return args.positionals[index];
}

function requirePositional(args: ParsedArgs, index: number, what: string): string {
  const v = positional(args, index);
  if (v === undefined) throw usage(`missing required argument <${what}>`);
  return v;
}

type ThemeName = "qw-dark" | "qw-light";

type Palette = Record<JobState, string>;

const THEMES: Record<ThemeName, Palette> = {
  "qw-dark": {
    queued: "#8b949e",
    scheduled: "#c9a227",
    running: "#58a6ff",
    succeeded: "#3fb950",
    retrying: "#f0883e",
    failed: "#ff6b63",
    dead: "#db61a2",
    cancelled: "#97a4b0",
  },
  "qw-light": {
    queued: "#57606a",
    scheduled: "#7d6600",
    running: "#0b62d6",
    succeeded: "#116e32",
    retrying: "#b45309",
    failed: "#b3261e",
    dead: "#7c1d6f",
    cancelled: "#5b6875",
  },
};

function detectTheme(): ThemeName {
  const env = process.env["QW_CLI_THEME"];
  if (env === "qw-light" || env === "light") return "qw-light";
  if (env === "qw-dark" || env === "dark") return "qw-dark";
  const fgbg = process.env["COLORFGBG"];
  if (fgbg) {
    const parts = fgbg.split(";");
    const bg = Number(parts[parts.length - 1] ?? NaN);
    if (Number.isFinite(bg)) return bg === 0 || bg >= 8 ? "qw-dark" : "qw-light";
  }
  if (process.platform === "darwin" && process.env["TERM_PROGRAM"] === "Apple_Terminal") {
    return "qw-light";
  }
  return "qw-dark";
}

let USE_COLOR = false;
let PALETTE: Palette = THEMES["qw-dark"];

function initAppearance(globals: Globals): void {
  const disabled =
    globals.noColor || process.env["NO_COLOR"] !== undefined || process.stdout.isTTY !== true;
  USE_COLOR = !disabled;
  PALETTE = THEMES[detectTheme()];
}

function hexToSgr(hex: string): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `${r};${g};${b}`;
}

function paint(state: JobState, text: string): string {
  if (!USE_COLOR) return text;
  return `\u001b[38;2;${hexToSgr(PALETTE[state])}m${text}\u001b[39m`;
}

interface Cell {
  t: string;
  s?: JobState;
}

function cell(text: string, state?: JobState): Cell {
  return state === undefined ? { t: text } : { t: text, s: state };
}

function renderTable(headers: string[], rows: Cell[][], right: boolean[] = []): string[] {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i]?.t.length ?? 0)),
  );
  const fmt = (cells: Cell[], isHeader: boolean): string =>
    cells
      .map((c, i) => {
        const w = widths[i] ?? 0;
        const padded = right[i] && !isHeader ? c.t.padStart(w) : c.t.padEnd(w);
        return c.s === undefined || isHeader ? padded : paint(c.s, padded);
      })
      .join("  ")
      .trimEnd();
  const lines = [fmt(headers.map((h) => cell(h)), true)];
  for (const row of rows) lines.push(fmt(row, false));
  return lines;
}

function truncateMiddle(s: string, max = 13): string {
  if (s.length <= max) return s;
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  const tail = keep - head;
  return tail > 0 ? `${s.slice(0, head)}\u2026${s.slice(s.length - tail)}` : `${s.slice(0, head)}\u2026`;
}

function iso(ms: number | null): string {
  return ms === null ? "-" : new Date(ms).toISOString();
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function fmtDur(ms: number | null): string {
  if (ms === null) return "-";
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${round1(s)}s`;
  const m = Math.floor(s / 60);
  return `${m}m${Math.round(s - m * 60)}s`;
}

function kv(label: string, value: string): string {
  return `${label.padEnd(14)}${value}`;
}

function parseJsonStrict(raw: string, source: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw usage(
      `invalid JSON in ${source}: ${e instanceof Error ? e.message : String(e)}`,
      'pass strict JSON, e.g. \'{"userId":"u_1042"}\' quoted for your shell; object keys need double quotes',
    );
  }
}

function parsePayloadFlag(args: ParsedArgs): unknown {
  const inline = strFlag(args, "payload");
  const file = strFlag(args, "payload-file");
  if (inline !== undefined && file !== undefined) {
    throw usage("--payload and --payload-file are mutually exclusive", "use one of them, not both");
  }
  if (file !== undefined) {
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch (e) {
      throw usage(
        `cannot read --payload-file "${file}": ${e instanceof Error ? e.message : String(e)}`,
        "check the path and that the file exists",
      );
    }
    return parseJsonStrict(raw, `payload file "${file}"`);
  }
  if (inline !== undefined) return parseJsonStrict(inline, "--payload");
  return {};
}

function compactJson(raw: string | null): string {
  if (raw === null) return "-";
  try {
    return JSON.stringify(JSON.parse(raw));
  } catch {
    return raw;
  }
}

function parseJsonLoose(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function parseJsonLooseOrNull(raw: string | null): unknown {
  return raw === null ? null : parseJsonLoose(raw);
}

function jobJson(rec: JobRecord): Record<string, unknown> {
  return {
    id: rec.id,
    type: rec.type,
    queue: rec.queue,
    state: rec.state,
    priority: rec.priority,
    payload: parseJsonLoose(rec.payload),
    payloadVersion: rec.payloadVersion,
    runAt: iso(rec.runAt),
    createdAt: iso(rec.createdAt),
    updatedAt: iso(rec.updatedAt),
    attempts: rec.attempts,
    maxAttempts: rec.maxAttempts,
    timeoutMs: rec.timeoutMs,
    retry: {
      strategy: rec.retry.strategy,
      baseDelayMs: rec.retry.baseDelayMs,
      maxDelayMs: rec.retry.maxDelayMs,
      jitter: rec.retry.jitter,
    },
    dedupeKey: rec.dedupeKey,
    scheduleId: rec.scheduleId,
    leaseUntil: iso(rec.leaseUntil),
    leaseOwner: rec.leaseOwner,
    lastError:
      rec.lastErrorName === null && rec.lastErrorMessage === null
        ? null
        : { name: rec.lastErrorName, message: rec.lastErrorMessage },
    result: parseJsonLooseOrNull(rec.result),
    progress:
      rec.progress === null
        ? null
        : { fraction: rec.progress.fraction, note: rec.progress.note, at: iso(rec.progress.at) },
    attemptsHistory: rec.attemptsHistory.map((a) => ({
      attempt: a.attempt,
      startedAt: iso(a.startedAt),
      finishedAt: iso(a.finishedAt),
      durationMs: a.durationMs,
      outcome: a.outcome,
      error:
        a.errorName === null && a.errorMessage === null
          ? null
          : { name: a.errorName, message: a.errorMessage },
      stack: a.stack,
    })),
    events: rec.events.map((e) => ({ ts: iso(e.ts), event: e.event, detail: e.detail })),
  };
}

function emitJson(value: unknown): void {
  console.log(JSON.stringify(value));
}

function printLines(lines: readonly string[]): void {
  for (const line of lines) console.log(line);
}

function stateWord(state: JobState): string {
  const word = state.toUpperCase();
  if (!USE_COLOR) return word;
  return `\u001b[38;2;${hexToSgr(PALETTE[state])}m${word}\u001b[39m`;
}

function attemptCell(a: AttemptRecord): string {
  if (a.errorName === null && a.errorMessage === null) return "-";
  return truncateMiddle(`${a.errorName ?? "Error"}: ${a.errorMessage ?? ""}`, 64);
}

function renderJobDetailHuman(rec: JobRecord): string[] {
  const lines: string[] = [
    `${truncateMiddle(rec.id, 24)}  ${rec.type}  ${stateWord(rec.state)}`,
    "",
    kv("state", rec.state),
    kv("queue", rec.queue),
    kv("priority", String(rec.priority)),
    kv("attempts", `${rec.attempts}/${rec.maxAttempts}`),
    kv("timeout", fmtDur(rec.timeoutMs)),
    kv("created", iso(rec.createdAt)),
    kv("updated", iso(rec.updatedAt)),
    kv("run_at", iso(rec.runAt)),
    kv(
      "lease",
      rec.leaseUntil === null ? "-" : `until=${iso(rec.leaseUntil)} owner=${rec.leaseOwner ?? "?"}`,
    ),
    kv("dedupe_key", rec.dedupeKey ?? "-"),
    kv("schedule", rec.scheduleId ?? "-"),
    kv(
      "last_error",
      rec.lastErrorName === null ? "-" : `${rec.lastErrorName}: ${rec.lastErrorMessage ?? ""}`,
    ),
    kv("result", compactJson(rec.result)),
  ];
  if (rec.progress !== null) {
    lines.push(
      kv(
        "progress",
        `${Math.round(rec.progress.fraction * 100)}%${rec.progress.note ? ` (${rec.progress.note})` : ""}`,
      ),
    );
  }
  lines.push(kv("payload", compactJson(rec.payload)));
  lines.push("");
  lines.push("ATTEMPTS");
  if (rec.attemptsHistory.length === 0) {
    lines.push("  (no attempts yet)");
  } else {
    lines.push(
      ...renderTable(
        ["#", "started", "duration", "outcome", "error"],
        rec.attemptsHistory.map((a) => [
          cell(String(a.attempt)),
          cell(iso(a.startedAt)),
          cell(fmtDur(a.durationMs)),
          cell(a.outcome),
          cell(attemptCell(a)),
        ]),
        [true],
      ),
    );
  }
  lines.push("");
  lines.push("EVENT LOG");
  if (rec.events.length === 0) {
    lines.push("  (no events)");
  } else {
    lines.push(
      ...renderTable(
        ["timestamp", "event", "detail"],
        rec.events.map((e: LifecycleEvent) => [cell(iso(e.ts)), cell(e.event), cell(e.detail ?? "-")]),
      ),
    );
  }
  return lines;
}

function listQueryFromFlags(args: ParsedArgs): ListJobsQuery {
  const query: ListJobsQuery = {
    limit: intFlag(args, "limit", 1) ?? DEFAULT_LIMIT,
    cursor: strFlag(args, "cursor") ?? null,
    order: "created_desc",
  };
  const state = strFlag(args, "state");
  if (state !== undefined) {
    if (!(JOB_STATES as readonly string[]).includes(state)) {
      throw usage(`unknown state "${state}"`, `valid states: ${JOB_STATES.join(", ")}`);
    }
    query.states = [state as JobState];
  }
  const queue = strFlag(args, "queue");
  if (queue !== undefined) query.queue = queue;
  const type = strFlag(args, "type");
  if (type !== undefined) query.type = type;
  return query;
}

function buildConfig(configFile: string | null): QueuewrightConfig {
  const fileCfg = loadConfigFile(configFile ?? DEFAULT_CONFIG_FILE);
  const cfg: QueuewrightConfig = { ...fileCfg };
  const log: LoggerOptions = { ...fileCfg.log };
  const fmt = process.env["QW_LOG_FORMAT"];
  if (fmt === "json" || fmt === "pretty") log.format = fmt;
  cfg.log = log;
  return cfg;
}

async function withClient<T>(
  configFile: string | null,
  fn: (qw: Queuewright) => Promise<T>,
): Promise<T> {
  const qw = new Queuewright(buildConfig(configFile));
  await qw.init();
  try {
    return await fn(qw);
  } finally {
    await qw.close().catch(() => {});
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function cmdEnqueue(args: ParsedArgs, globals: Globals): Promise<number> {
  const type = requirePositional(args, 0, "type");
  const payload = parsePayloadFlag(args);
  const opts: RawEnqueueOpts = {};
  const queue = strFlag(args, "queue");
  if (queue !== undefined) opts.queue = queue;
  const delaySec = strFlag(args, "delay");
  if (delaySec !== undefined) {
    const n = Number(delaySec);
    if (!Number.isFinite(n) || n < 0) throw usage(`--delay expects seconds >= 0, got "${delaySec}"`);
    opts.delayMs = Math.round(n * 1000);
  }
  const dedupeKey = strFlag(args, "dedupe-key");
  if (dedupeKey !== undefined) opts.dedupeKey = dedupeKey;
  const priority = intFlag(args, "priority", -1_000_000_000);
  if (priority !== undefined) opts.priority = priority;
  return withClient(globals.config, async (qw) => {
    const known = registeredTypes();
    const unregistered = !known.includes(type);
    if (unregistered && known.length > 0) {
      throw new UnregisteredJobTypeError(type, known);
    }
    const rec = await qw.rawEnqueue(type, JSON.stringify(payload), opts);
    if (!globals.json && unregistered) {
      printLines([
        `note: "${type}" is not defined in this process; enqueued with default options (queue ${rec.queue}, 3 attempts). The worker that runs it must have this type registered.`,
      ]);
    }
    if (globals.json) emitJson(jobJson(rec));
    else {
      printLines([
        `enqueued ${truncateMiddle(rec.id, 24)}  ${rec.type}  ${stateWord(rec.state)}  queue=${rec.queue}  run_at=${iso(rec.runAt)}`,
      ]);
    }
    return 0;
  });
}

async function cmdGet(args: ParsedArgs, globals: Globals): Promise<number> {
  const id = requirePositional(args, 0, "job-id");
  return withClient(globals.config, async (qw) => {
    const rec = await qw.getJob(id);
    if (rec === null) throw new JobNotFoundError(id);
    if (globals.json) emitJson(jobJson(rec));
    else printLines(renderJobDetailHuman(rec));
    return 0;
  });
}

function isTerminalLike(rec: JobRecord): boolean {
  return (
    rec.state === "succeeded" ||
    rec.state === "failed" ||
    rec.state === "dead" ||
    rec.state === "cancelled"
  );
}

async function cmdList(args: ParsedArgs, globals: Globals): Promise<number> {
  const query = listQueryFromFlags(args);
  return withClient(globals.config, async (qw) => {
    const page = await qw.listJobs(query);
    if (globals.json) {
      emitJson({ items: page.jobs.map(jobJson), cursor: query.cursor, nextCursor: page.cursor });
      return 0;
    }
    if (page.jobs.length === 0) {
      printLines(["No jobs match the current filters."]);
    } else {
      printLines(
        renderTable(
          ["state", "id", "type", "queue", "att", "next_run_or_finished", "created"],
          page.jobs.map((j) => [
            cell(j.state, j.state),
            cell(truncateMiddle(j.id, 17)),
            cell(truncateMiddle(j.type, 28)),
            cell(j.queue),
            cell(`${j.attempts}/${j.maxAttempts}`),
            cell(iso(isTerminalLike(j) ? j.updatedAt : j.runAt)),
            cell(iso(j.createdAt)),
          ]),
          [false, false, false, false, true],
        ),
      );
    }
    if (page.cursor !== null) console.log(`next cursor: ${page.cursor}`);
    return 0;
  });
}

async function cmdRetry(args: ParsedArgs, globals: Globals): Promise<number> {
  const allDead = boolFlag(args, "all-dead");
  const jobId = positional(args, 0);
  if (allDead && jobId !== undefined) throw usage("pass either <job-id> or --all-dead, not both");
  if (!allDead && jobId === undefined) {
    throw usage(
      "missing argument: give <job-id> or use --all-dead",
      'retry one job with "qw retry j_..." or bulk-retry dead letters with "qw retry --all-dead [--queue q]"',
    );
  }
  return withClient(globals.config, async (qw) => {
    if (allDead) {
      const queue = strFlag(args, "queue") ?? null;
      const count = await qw.retryDeadLetters(queue);
      if (globals.json) emitJson({ retried: count, queue });
      else {
        printLines([
          `requeued ${count} dead job${count === 1 ? "" : "s"}${queue ? ` in queue "${queue}"` : ""}`,
        ]);
      }
      return 0;
    }
    const rec = await qw.requeueJob(jobId!, { resetAttempts: true });
    if (globals.json) emitJson(jobJson(rec));
    else {
      printLines([`requeued ${truncateMiddle(rec.id, 24)}  ${stateWord(rec.state)}  queue=${rec.queue}`]);
    }
    return 0;
  });
}

async function cmdCancel(args: ParsedArgs, globals: Globals): Promise<number> {
  const id = requirePositional(args, 0, "job-id");
  return withClient(globals.config, async (qw) => {
    const rec = await qw.cancelJob(id);
    if (globals.json) emitJson(jobJson(rec));
    else printLines([`cancelled ${truncateMiddle(rec.id, 24)}  ${stateWord(rec.state)}`]);
    return 0;
  });
}

function statsJson(st: Awaited<ReturnType<Queuewright["stats"]>>): Record<string, unknown> {
  const states = {} as Record<JobState, number>;
  for (const s of JOB_STATES) states[s] = st.states[s];
  return {
    states,
    queues: st.queues.map((q) => ({
      queue: q.queue,
      queued: q.queued,
      scheduled: q.scheduled,
      running: q.running,
      retrying: q.retrying,
      dead: q.dead,
      failed: q.failed,
      succeeded: q.succeeded,
      cancelled: q.cancelled,
    })),
    types: st.types.map((t) => ({ type: t.type, total: t.total, dead: t.dead, failed: t.failed })),
    globalPaused: st.globalPaused,
    pausedQueues: st.pausedQueues,
    oldestQueuedAt: st.oldestQueuedAt === null ? null : iso(st.oldestQueuedAt),
  };
}

async function cmdStats(_args: ParsedArgs, globals: Globals): Promise<number> {
  return withClient(globals.config, async (qw) => {
    const st = await qw.stats();
    if (globals.json) {
      emitJson(statsJson(st));
      return 0;
    }
    const lines: string[] = [
      kv("global_paused", st.globalPaused ? "yes" : "no"),
      kv("paused_queues", st.pausedQueues.length === 0 ? "(none)" : st.pausedQueues.join(", ")),
      kv("oldest_queued", st.oldestQueuedAt === null ? "-" : iso(st.oldestQueuedAt)),
      "",
      "STATES",
      ...renderTable(
        ["state", "count"],
        JOB_STATES.map((s) => [cell(s), cell(String(st.states[s]))]),
        [false, true],
      ),
      "",
      "QUEUES",
    ];
    if (st.queues.length === 0) {
      lines.push("  (no queues yet)");
    } else {
      lines.push(
        ...renderTable(
          ["queue", "queued", "scheduled", "running", "retrying", "dead", "failed", "succeeded", "cancelled"],
          st.queues.map((q) => [
            cell(q.queue),
            cell(String(q.queued)),
            cell(String(q.scheduled)),
            cell(String(q.running)),
            cell(String(q.retrying)),
            cell(String(q.dead)),
            cell(String(q.failed)),
            cell(String(q.succeeded)),
            cell(String(q.cancelled)),
          ]),
          [false, true, true, true, true, true, true, true, true],
        ),
      );
    }
    lines.push("", "TOP JOB TYPES");
    if (st.types.length === 0) {
      lines.push("  (no jobs yet)");
    } else {
      const top = [...st.types].sort((a, b) => b.total - a.total).slice(0, 10);
      lines.push(
        ...renderTable(
          ["type", "total", "dead", "failed"],
          top.map((t) => [cell(t.type), cell(String(t.total)), cell(String(t.dead)), cell(String(t.failed))]),
          [false, true, true, true],
        ),
      );
    }
    printLines(lines);
    return 0;
  });
}

async function pauseResume(args: ParsedArgs, globals: Globals, paused: boolean): Promise<number> {
  const verb = paused ? "pause" : "resume";
  const pos0 = positional(args, 0);
  const allFlag = boolFlag(args, "all");
  if (allFlag && pos0 !== undefined && pos0 !== "all") {
    throw usage("cannot combine a queue name with --all");
  }
  const globalScope = allFlag || pos0 === "all";
  if (!globalScope && pos0 === undefined) {
    throw usage("missing target", `give a queue name ("qw ${verb} email") or pass --all`);
  }
  return withClient(globals.config, async (qw) => {
    await qw.setPaused(
      globalScope ? { scope: "global", queue: null, paused } : { scope: "queue", queue: pos0!, paused },
    );
    if (globals.json) {
      emitJson(globalScope ? { scope: "global", paused } : { scope: "queue", queue: pos0!, paused });
    } else {
      printLines([globalScope ? `${verb}d: all queues` : `${verb}d: queue "${pos0}"`]);
    }
    return 0;
  });
}

async function cmdPause(args: ParsedArgs, globals: Globals): Promise<number> {
  return pauseResume(args, globals, true);
}

async function cmdResume(args: ParsedArgs, globals: Globals): Promise<number> {
  return pauseResume(args, globals, false);
}

async function cmdDrain(args: ParsedArgs, globals: Globals): Promise<number> {
  const queue = strFlag(args, "queue") ?? null;
  const timeoutSec = intFlag(args, "timeout", 0) ?? 300;
  const startedAt = Date.now();
  const deadline = startedAt + timeoutSec * 1000;
  return withClient(globals.config, async (qw) => {
    let remaining = 0;
    for (;;) {
      const st = await qw.stats();
      remaining = st.queues
        .filter((q) => queue === null || q.queue === queue)
        .reduce((sum, q) => sum + q.queued + q.scheduled + q.retrying, 0);
      if (remaining === 0) break;
      if (Date.now() >= deadline) throw new DrainTimeoutError(queue ?? "*", remaining, timeoutSec * 1000);
      await sleep(500);
    }
    const elapsedMs = Date.now() - startedAt;
    if (globals.json) emitJson({ scope: queue === null ? "all" : "queue", queue, pending: 0, elapsedMs });
    else {
      printLines([
        `drained ${queue === null ? "(all queues)" : `queue "${queue}"`}: 0 pending after ${(elapsedMs / 1000).toFixed(1)}s`,
      ]);
    }
    return 0;
  });
}

const ON_MISSED_VALUES: readonly OnMissedPolicy[] = ["catch_up", "skip", "run_once"];

function scheduleJson(s: ScheduleRecord): Record<string, unknown> {
  return {
    id: s.id,
    cron: s.cron,
    timezone: s.timezone,
    jobType: s.jobType,
    queue: s.queue,
    onMissed: s.onMissed,
    payload: parseJsonLoose(s.payload),
    priority: s.priority,
    maxAttempts: s.maxAttempts,
    timeoutMs: s.timeoutMs,
    paused: s.paused,
    nextFireAt: iso(s.nextFireAt),
    lastFiredAt: iso(s.lastFiredAt),
    createdAt: iso(s.createdAt),
  };
}

async function cmdSchedulesList(_args: ParsedArgs, globals: Globals): Promise<number> {
  return withClient(globals.config, async (qw) => {
    const schedules = await qw.listSchedules();
    if (globals.json) emitJson(schedules.map(scheduleJson));
    else if (schedules.length === 0) printLines(["No schedules defined."]);
    else {
      printLines(
        renderTable(
          ["id", "cron", "tz", "type", "queue", "on_missed", "paused", "next_fire"],
          schedules.map((s) => [
            cell(truncateMiddle(s.id, 20)),
            cell(s.cron),
            cell(s.timezone),
            cell(truncateMiddle(s.jobType, 28)),
            cell(s.queue),
            cell(s.onMissed),
            cell(s.paused ? "yes" : "no"),
            cell(iso(s.nextFireAt)),
          ]),
        ),
      );
    }
    return 0;
  });
}

async function cmdSchedulesAdd(args: ParsedArgs, globals: Globals): Promise<number> {
  const cron = requirePositional(args, 0, "cron");
  const jobType = requirePositional(args, 1, "job-type");
  const onMissedRaw = strFlag(args, "on-missed");
  if (onMissedRaw !== undefined && !(ON_MISSED_VALUES as readonly string[]).includes(onMissedRaw)) {
    throw usage(`invalid --on-missed value "${onMissedRaw}"`, `pick one of: ${ON_MISSED_VALUES.join(", ")}`);
  }
  const tz = strFlag(args, "tz");
  const queue = strFlag(args, "queue");
  const id = strFlag(args, "id") ?? `sch_${randomBytes(4).toString("hex")}`;
  const payload = parsePayloadFlag(args);
  return withClient(globals.config, async (qw) => {
    const rec = await qw.createSchedule({
      id,
      cron,
      ...(tz !== undefined ? { timezone: tz } : {}),
      jobType,
      ...(queue !== undefined ? { queue } : {}),
      payload,
      ...(onMissedRaw !== undefined ? { onMissed: onMissedRaw as OnMissedPolicy } : {}),
    });
    if (globals.json) emitJson(scheduleJson(rec));
    else {
      printLines([
        `scheduled ${rec.id}  cron="${rec.cron}"  tz=${rec.timezone}  type=${rec.jobType}  queue=${rec.queue}  on_missed=${rec.onMissed}  next_fire=${iso(rec.nextFireAt)}`,
      ]);
    }
    return 0;
  });
}

async function cmdSchedulesDelete(args: ParsedArgs, globals: Globals): Promise<number> {
  const id = requirePositional(args, 0, "schedule-id");
  return withClient(globals.config, async (qw) => {
    await qw.deleteSchedule(id);
    if (globals.json) emitJson({ id, deleted: true });
    else printLines([`deleted schedule ${id}`]);
    return 0;
  });
}

function splitQueueList(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function waitUntilIdle(qw: Queuewright, worker: Worker): Promise<void> {
  for (;;) {
    const st = await qw.stats();
    if (
      worker.inflightCount === 0 &&
      st.states.running === 0 &&
      st.states.queued === 0 &&
      st.states.retrying === 0
    ) {
      return;
    }
    await sleep(250);
  }
}

async function cmdWorker(args: ParsedArgs, globals: Globals): Promise<number> {
  const cfg = buildConfig(globals.config);
  const concurrency = intFlag(args, "concurrency", 1);
  if (concurrency !== undefined) cfg.concurrency = concurrency;
  const queuesRaw = strFlag(args, "queues");
  if (queuesRaw !== undefined) {
    const queues = splitQueueList(queuesRaw);
    if (queues.length === 0) throw usage('--queues expects a comma-separated list like "default,email"');
    cfg.queues = queues;
  }
  const onceRaw = strFlag(args, "once");
  if (onceRaw !== undefined && onceRaw !== "true" && onceRaw !== "false") {
    throw usage('"--once" expects true or false');
  }
  const once = onceRaw === "true";
  const qw = new Queuewright(cfg);
  await qw.init();
  try {
    await qw.applyStartupRules(cfg);
    const worker = qw.createWorker();
    if (once) {
      worker.start();
      await waitUntilIdle(qw, worker);
      await worker.stop();
    } else {
      await worker.runUntilSignal();
    }
  } finally {
    await qw.close().catch(() => {});
  }
  return 0;
}

interface CommandContext {
  args: ParsedArgs;
  globals: Globals;
}

interface CommandSpec {
  readonly usageLine: string;
  readonly summary: string;
  readonly detail: readonly string[];
  readonly flags: readonly FlagSpec[];
  readonly run: (ctx: CommandContext) => Promise<number>;
}

const NO_FLAGS: readonly FlagSpec[] = [];

function f(name: string, value: boolean): FlagSpec {
  return { name, value };
}

const COMMANDS: Record<string, CommandSpec> = {
  enqueue: {
    usageLine: "qw enqueue <type> [--payload '<json>' | --payload-file f] [--queue q]",
    summary: "Enqueue one job by registered type.",
    detail: [
      "--payload '<json>'   inline JSON payload (default {})",
      "--payload-file f     read the JSON payload from a file",
      "--queue q            target queue (overrides the definition)",
      "--delay seconds      schedule the job N seconds from now",
      "--dedupe-key k       collapse concurrent duplicate enqueues",
      "--priority n         higher runs first within the queue",
      "",
      "exit codes: 0 enqueued | 1 storage failure | 2 invalid JSON, unregistered type, bad flags",
    ],
    flags: [f("payload", true), f("payload-file", true), f("queue", true), f("delay", true), f("dedupe-key", true), f("priority", true)],
    run: (ctx) => cmdEnqueue(ctx.args, ctx.globals),
  },
  get: {
    usageLine: "qw get <job-id>",
    summary: "Show one job with full attempt history and event log.",
    detail: ["exit codes: 0 ok | 1 job not found | 2 bad flags"],
    flags: NO_FLAGS,
    run: (ctx) => cmdGet(ctx.args, ctx.globals),
  },
  list: {
    usageLine: "qw list [--state s] [--queue q] [--type t] [--limit n] [--cursor c]",
    summary: "List jobs newest first; prints the next cursor when more pages exist.",
    detail: [
      "--state s    one of queued|scheduled|running|succeeded|failed|retrying|dead|cancelled",
      "--limit n    page size (default 20)",
      "exit codes: 0 ok | 2 bad flags",
    ],
    flags: [f("state", true), f("queue", true), f("type", true), f("limit", true), f("cursor", true)],
    run: (ctx) => cmdList(ctx.args, ctx.globals),
  },
  retry: {
    usageLine: "qw retry <job-id>  |  qw retry --all-dead [--queue q]",
    summary: "Requeue a dead/failed/succeeded/cancelled job, or bulk requeue dead letters.",
    detail: ["--all-dead      retry every dead job (optionally scoped to one queue)", "exit codes: 0 requeued | 1 job not found | 2 bad flags"],
    flags: [f("all-dead", false), f("queue", true)],
    run: (ctx) => cmdRetry(ctx.args, ctx.globals),
  },
  cancel: {
    usageLine: "qw cancel <job-id>",
    summary: "Cancel a pending or running job.",
    detail: ["exit codes: 0 cancelled | 1 job not found / illegal transition target | 2 bad flags"],
    flags: NO_FLAGS,
    run: (ctx) => cmdCancel(ctx.args, ctx.globals),
  },
  stats: {
    usageLine: "qw stats",
    summary: "Depths per queue, totals per state, top job types.",
    detail: ["exit codes: 0 ok | 1 storage failure"],
    flags: NO_FLAGS,
    run: (ctx) => cmdStats(ctx.args, ctx.globals),
  },
  pause: {
    usageLine: "qw pause <queue> | qw pause --all",
    summary: "Stop claiming jobs for one queue, or globally.",
    detail: ["exit codes: 0 ok | 2 missing target / bad flags"],
    flags: [f("all", false)],
    run: (ctx) => cmdPause(ctx.args, ctx.globals),
  },
  resume: {
    usageLine: "qw resume <queue> | qw resume --all",
    summary: "Resume claiming jobs for one queue, or globally.",
    detail: ["exit codes: 0 ok | 2 missing target / bad flags"],
    flags: [f("all", false)],
    run: (ctx) => cmdResume(ctx.args, ctx.globals),
  },
  drain: {
    usageLine: "qw drain [--queue q] [--timeout seconds]",
    summary: "Poll every 500ms until no queued/scheduled/retrying jobs remain in scope.",
    detail: [
      "--timeout seconds   give up after this long (default 300); exits 1 on timeout",
      "exit codes: 0 drained | 1 drain timeout | 2 bad flags",
    ],
    flags: [f("queue", true), f("timeout", true)],
    run: (ctx) => cmdDrain(ctx.args, ctx.globals),
  },
  worker: {
    usageLine: "qw worker [--concurrency n] [--queues a,b] [--once false]",
    summary: "Run a worker until SIGINT/SIGTERM (same as qw-worker).",
    detail: [
      "--concurrency n     parallel slots (default 4)",
      "--queues a,b        serve only these queues (default all)",
      "--once              exit after the backlog is idle instead of waiting for a signal",
      "",
      "logs go through the library logger; QW_LOG_FORMAT=json|pretty picks the format",
      "exit codes: 0 clean shutdown | 1 storage failure | 2 configuration error",
    ],
    flags: [f("concurrency", true), f("queues", true), f("once", true)],
    run: (ctx) => cmdWorker(ctx.args, ctx.globals),
  },
  "schedules list": {
    usageLine: "qw schedules list",
    summary: "List recurring schedules.",
    detail: ["exit codes: 0 ok | 1 storage failure"],
    flags: NO_FLAGS,
    run: (ctx) => cmdSchedulesList(ctx.args, ctx.globals),
  },
  "schedules add": {
    usageLine:
      "qw schedules add <cron> <jobType> [--tz Z] [--on-missed catch_up|skip|run_once] [--payload '<json>'] [--queue q] [--id s]",
    summary: "Register a cron schedule for a registered job type.",
    detail: [
      "--tz Z            IANA timezone (default UTC)",
      "--on-missed p     catch_up | skip | run_once (default run_once)",
      "--id s            stable id; generated when omitted",
      "exit codes: 0 created | 2 invalid cron/timezone or unregistered job type",
    ],
    flags: [f("tz", true), f("on-missed", true), f("payload", true), f("queue", true), f("id", true)],
    run: (ctx) => cmdSchedulesAdd(ctx.args, ctx.globals),
  },
  "schedules delete": {
    usageLine: "qw schedules delete <id>",
    summary: "Delete a schedule by id.",
    detail: ["exit codes: 0 ok | 2 missing id"],
    flags: NO_FLAGS,
    run: (ctx) => cmdSchedulesDelete(ctx.args, ctx.globals),
  },
};

const MAIN_HELP: string[] = [
  "qw - background jobs for people who read their logs",
  "",
  "USAGE",
  "  qw <command> [args]",
  "",
  "JOBS",
  "  qw enqueue <type> [--payload '<json>' | --payload-file f] [--queue q]",
  "             [--delay seconds] [--dedupe-key k] [--priority n]",
  "  qw get <job-id>                    show one job with full attempt history",
  "  qw list [--state s] [--queue q] [--type t] [--limit n] [--cursor c]",
  "  qw retry <job-id>                  requeue a dead/failed/succeeded/cancelled job",
  "  qw retry --all-dead [--queue q]    bulk requeue dead letters",
  "  qw cancel <job-id>",
  "QUEUES",
  "  qw stats                           depths, throughput, percentiles, failures",
  "  qw pause <queue> | qw resume <queue> | qw pause --all | qw resume --all",
  "  qw drain [--queue q] [--timeout seconds]   wait until queue is empty",
  "SCHEDULES",
  "  qw schedules list | add <expr> <type> --tz Z [--on-missed p] | delete <id>",
  "WORKERS",
  "  qw worker                          run a worker (same as qw-worker)",
  "GLOBAL FLAGS",
  "  --json            machine-readable output (stable field order)",
  "  --no-color        disable colour even on a TTY (NO_COLOR also honoured)",
  "  --config <file>   config file (default ./queuewright.json)",
  "  --help            this text; per-command help via qw <command> --help",
  "",
  "EXIT CODES  0 ok | 1 operational error (job not found, drain timeout) |",
  "            2 configuration/usage error",
];

const SCHEDULES_HELP: string[] = [
  "qw schedules - recurring cron schedules",
  "",
  "USAGE",
  "  qw schedules list",
  "  qw schedules add <cron> <jobType> [--tz Z] [--on-missed catch_up|skip|run_once]",
  "                  [--payload '<json>'] [--queue q] [--id s]",
  "  qw schedules delete <id>",
  "",
  "Per-command help: qw schedules <verb> --help",
];

function commandHelp(spec: CommandSpec): string[] {
  const lines = ["USAGE", `  ${spec.usageLine}`, "", spec.summary];
  if (spec.detail.length > 0) lines.push("", ...spec.detail);
  lines.push("", "Global flags (--json, --no-color, --config, --help) work on every command.");
  return lines;
}

const USAGE_ERROR_CLASSES: readonly (new (...args: never[]) => Error)[] = [
  UsageError,
  ConfigValidationError,
  UnregisteredJobTypeError,
  InvalidCronError,
  InvalidTimezoneError,
  DuplicateDefinitionError,
  PayloadTooLargeError,
  RateLimitConfigError,
  InvalidTransitionError,
];

function exitCodeFor(err: unknown): number {
  return USAGE_ERROR_CLASSES.some((c) => err instanceof c) ? 2 : 1;
}

function reportError(err: unknown): number {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`Error: ${message}\n`);
  const hint = err instanceof QueuewrightError ? err.hint : err instanceof UsageError ? err.hint : null;
  if (hint !== null) process.stderr.write(`fix: ${hint}\n`);
  return exitCodeFor(err);
}

async function invoke(spec: CommandSpec, argTokens: string[], globals: Globals): Promise<number> {
  const args = parseFlags(argTokens, spec.flags);
  if (globals.help) {
    printLines(commandHelp(spec));
    return 0;
  }
  return spec.run({ args, globals });
}

export async function main(argv: string[]): Promise<number> {
  try {
    const { globals, rest } = extractGlobals(argv);
    initAppearance(globals);
    if (rest.length === 0) {
      printLines(MAIN_HELP);
      return globals.help ? 0 : 2;
    }
    const noun = rest[0]!;
    if (noun === "schedules") {
      const verb = rest[1];
      if (verb === undefined) {
        printLines(SCHEDULES_HELP);
        return globals.help ? 0 : 2;
      }
      const spec = COMMANDS[`schedules ${verb}`];
      if (!spec) {
        throw usage(
          `unknown command "schedules ${verb}"`,
          'known verbs: list, add, delete; see "qw schedules --help"',
        );
      }
      return await invoke(spec, rest.slice(2), globals);
    }
    const spec = COMMANDS[noun];
    if (!spec) {
      const names = Object.keys(COMMANDS)
        .filter((k) => !k.startsWith("schedules "))
        .concat("schedules")
        .sort();
      throw usage(`unknown command "${noun}"`, `known commands: ${names.join(", ")}`);
    }
    return await invoke(spec, rest.slice(1), globals);
  } catch (err) {
    return reportError(err);
  }
}

void main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  },
);
