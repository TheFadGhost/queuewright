import type { StorageBackend } from "./storage/interface.js";
import { WrappedThrowError } from "./errors.js";

/**
 * Runs `fn` at most once per `key` for the lifetime of the store. The result
 * (or the error) is recorded, so a retried job that re-enters with the same
 * key receives the cached outcome instead of repeating side effects.
 *
 * This makes storage-backed effects idempotent; it cannot cover external
 * side effects that are not themselves guarded by a key.
 */
export async function runIdempotent<T>(
  storage: StorageBackend,
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const begun = await storage.beginIdempotency(key);
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
