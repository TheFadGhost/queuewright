import type { StorageBackend } from "./storage/interface.js";
import { IdempotencyKeyBusyError, WrappedThrowError } from "./errors.js";

/**
 * Runs `fn` at most once per `key` for the lifetime of the store. The result
 * (or the error) is recorded, so a retried job that re-enters with the same
 * key receives the cached outcome instead of repeating side effects.
 *
 * If another execution currently holds the key, this throws
 * IdempotencyKeyBusyError so the normal retry machinery re-runs the attempt
 * later instead of duplicating the side effect.
 */
export async function runIdempotent<T>(
  storage: StorageBackend,
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const begun = await storage.beginIdempotency(key);
  if (begun.status === "busy") throw new IdempotencyKeyBusyError(key);
  if (begun.status === "done") {
    try {
      return JSON.parse(begun.result) as T;
    } catch {
      return undefined as unknown as T;
    }
  }
  let value: T;
  try {
    value = await fn();
  } catch (e) {
    await storage.releaseIdempotency(key);
    throw e instanceof Error ? e : new WrappedThrowError(e);
  }
  await storage.completeIdempotency(
    key,
    JSON.stringify(value === undefined ? null : value),
  );
  return value;
}
