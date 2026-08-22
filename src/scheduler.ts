import { parseCron, nextFireAfter, type ParsedCron } from "./cron.js";
import type { Queuewright } from "./client.js";
import type { ScheduleRecord } from "./types.js";

const MAX_CATCH_UP_SLOTS = 1000;

/**
 * Evaluates recurring schedules. Ticks once per second; every due schedule
 * materialises job rows atomically via storage.recordScheduleFires.
 *
 * Missed-schedule policies (per schedule):
 *  - catch_up: enqueue one job per missed fire slot (bounded at MAX_CATCH_UP_SLOTS)
 *  - skip: advance past all missed slots
 *  - run_once: enqueue a single job for the most recent missed slot
 */
export class Scheduler {
  private qw: Queuewright;
  private workerId: string;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private parsed = new Map<string, ParsedCron>();

  constructor(qw: Queuewright, workerId: string) {
    this.qw = qw;
    this.workerId = workerId;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => {
      void this.tick().catch((e) => {
        this.qw.logger.error("scheduler tick failed", { module: "scheduler", err: errOf(e) });
      });
    }, 1000);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    const now = this.qw.clock();
    const schedules = await this.qw.listSchedules();
    for (const sched of schedules) {
      await this.processSchedule(sched, now);
    }
  }

  private async processSchedule(sched: ScheduleRecord, now: number): Promise<void> {
    let parsed = this.parsed.get(sched.id);
    if (!parsed || parsed.expression !== sched.cron) {
      try {
        parsed = parseCron(sched.cron);
        this.parsed.set(sched.id, parsed);
      } catch (e) {
        this.qw.logger.error(
          `schedule "${sched.id}" has an invalid cron expression and is skipped`,
          { module: "scheduler", kv: { cron: sched.cron }, err: errOf(e) },
        );
        return;
      }
    }
    let nextFireAt = sched.nextFireAt;
    if (nextFireAt === null) {
      const base = Math.max(now, sched.lastFiredAt ?? now);
      nextFireAt = nextFireAfter(parsed, sched.timezone, base);
      if (nextFireAt === null) return;
      await this.qw.storage.recordScheduleFires(sched.id, [], nextFireAt);
      return;
    }
    if (sched.paused || nextFireAt > now) return;
    const missed = collectMissed(parsed, sched.timezone, sched.lastFiredAt, nextFireAt, now);
    let fireTimes: number[];
    switch (sched.onMissed) {
      case "catch_up":
        fireTimes = missed.all.slice(0, MAX_CATCH_UP_SLOTS);
        break;
      case "skip":
        fireTimes = [];
        break;
      case "run_once":
      default:
        fireTimes = missed.all.length > 0 ? [missed.all[missed.all.length - 1]!] : [nextFireAt];
        break;
    }
    await this.qw.storage.recordScheduleFires(sched.id, fireTimes, missed.next);
    if (fireTimes.length > 0) {
      this.qw.metrics.inc("qw_schedule_fires_total", [["schedule", sched.id]], fireTimes.length);
      this.qw.logger.info("schedule fired", {
        module: "scheduler",
        kv: { schedule: sched.id, fires: fireTimes.length, policy: sched.onMissed },
      });
    }
  }

  async tickOnceForTests(): Promise<void> {
    await this.tick();
  }

  get ownerId(): string {
    return this.workerId;
  }
}

function collectMissed(
  parsed: ParsedCron,
  tz: string,
  _lastFiredAt: number | null,
  firstDue: number,
  now: number,
): { all: number[]; next: number } {
  const all: number[] = [];
  let cursor = firstDue;
  let guard = 0;
  while (cursor <= now && guard < MAX_CATCH_UP_SLOTS * 2) {
    all.push(cursor);
    const next = nextFireAfter(parsed, tz, cursor);
    if (next === null) break;
    cursor = next;
    guard++;
  }
  const next = cursor > now ? cursor : nextFireAfter(parsed, tz, now);
  return { all, next: next ?? now };
}

function errOf(e: unknown): { name: string; message: string; stack: string | null } {
  if (e instanceof Error) return { name: e.name, message: e.message, stack: e.stack ?? null };
  return { name: "NonErrorThrow", message: String(e), stack: null };
}
