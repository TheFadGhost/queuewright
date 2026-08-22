import { appendFileSync, readFileSync, existsSync } from "node:fs";

/**
 * Durable side-effect ledger used by chaos tests: each handler execution
 * appends one line. The invariant checked by tests: every enqueued job id
 * appears at least once (no lost jobs); duplicate appearances are permitted
 * only within the at-least-once contract (bounded by injected crashes).
 */
export function recordExecution(ledgerFile: string, jobId: string, workerId: string): void {
  appendFileSync(ledgerFile, `${jobId}\t${workerId}\n`, "utf8");
}

export interface LedgerEntry {
  jobId: string;
  workerId: string;
}

export function readLedger(ledgerFile: string): LedgerEntry[] {
  if (!existsSync(ledgerFile)) return [];
  return readFileSync(ledgerFile, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => {
      const [jobId, workerId] = l.split("\t");
      return { jobId: jobId!, workerId: workerId ?? "" };
    });
}
