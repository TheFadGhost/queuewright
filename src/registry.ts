import { DuplicateDefinitionError, UnregisteredJobTypeError } from "./errors.js";
import { DEFAULT_RETRY_POLICY, type RetryPolicy } from "./types.js";

export interface JobContext {
  readonly jobId: string;
  readonly jobType: string;
  readonly queue: string;
  readonly attempt: number;
  readonly signal: AbortSignal;
  progress(fraction: number, note?: string): void;
  idempotency<T>(key: string, fn: () => Promise<T>): Promise<T>;
}

export type Handler<P> = (payload: P, ctx: JobContext) => void | Promise<void>;

export interface JobOptions {
  queue?: string;
  priority?: number;
  timeoutMs?: number;
  maxAttempts?: number;
  retry?: Partial<RetryPolicy>;
  /** Reject payloads failing this predicate at enqueue time. */
  validate?: (payload: unknown) => string | null;
  /** Current payload schema version; payloads of older versions pass through migrate before execution. */
  version?: number;
  migrate?: (payload: any, fromVersion: number) => any;
  /** Enqueue the named job type after a successful run (single-successor continuation). */
  onSuccess?: { type: string; buildPayload: (result: void | unknown, sourcePayload: any) => unknown };
}

export interface ResolvedJobOptions {
  queue: string;
  priority: number;
  timeoutMs: number;
  maxAttempts: number;
  retry: RetryPolicy;
  validate: ((payload: unknown) => string | null) | null;
  version: number;
  migrate: ((payload: any, fromVersion: number) => any) | null;
  onSuccess: JobOptions["onSuccess"] | null;
}

export interface JobDefinition<P> {
  readonly type: string;
  readonly options: ResolvedJobOptions;
  readonly handler: Handler<P>;
}

const JOB_TYPE_RE = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/;

const registry = new Map<string, JobDefinition<never>>();

export function resolveOptions(options: JobOptions = {}): ResolvedJobOptions {
  return {
    queue: options.queue ?? "default",
    priority: options.priority ?? 0,
    timeoutMs: options.timeoutMs ?? 30_000,
    maxAttempts: options.maxAttempts ?? 3,
    retry: { ...DEFAULT_RETRY_POLICY, ...(options.retry ?? {}) },
    validate: options.validate ?? null,
    version: options.version ?? 1,
    migrate: options.migrate ?? null,
    onSuccess: options.onSuccess ?? null,
  };
}

export function defineJob<P>(
  type: string,
  handler: Handler<P>,
): JobDefinition<P>;
export function defineJob<P>(
  type: string,
  options: JobOptions,
  handler: Handler<P>,
): JobDefinition<P>;
export function defineJob<P>(
  type: string,
  optionsOrHandler: JobOptions | Handler<P>,
  maybeHandler?: Handler<P>,
): JobDefinition<P> {
  const options = typeof optionsOrHandler === "function" ? {} : optionsOrHandler;
  const handler = (typeof optionsOrHandler === "function" ? optionsOrHandler : maybeHandler)!;
  if (!JOB_TYPE_RE.test(type)) {
    throw new Error(
      `invalid job type "${type}": use lowercase dotted names like "mail.welcome" (pattern ${JOB_TYPE_RE.source})`,
    );
  }
  if (registry.has(type)) throw new DuplicateDefinitionError(type);
  const def: JobDefinition<P> = { type, options: resolveOptions(options), handler };
  registry.set(type, def as JobDefinition<never>);
  return def;
}

export function registerDefinition<P>(def: JobDefinition<P>): void {
  if (registry.has(def.type)) throw new DuplicateDefinitionError(def.type);
  registry.set(def.type, def as JobDefinition<never>);
}

export function getDefinition(type: string): JobDefinition<never> {
  const def = registry.get(type);
  if (!def) throw new UnregisteredJobTypeError(type, [...registry.keys()]);
  return def;
}

export function findDefinition(type: string): JobDefinition<never> | undefined {
  return registry.get(type);
}

export function registeredTypes(): string[] {
  return [...registry.keys()].sort();
}

export function resetRegistryForTests(): void {
  registry.clear();
}
