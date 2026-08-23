import { Worker as NodeWorker } from "node:worker_threads";
import { pathToFileURL } from "node:url";

export interface ThreadExecutionSpec {
  module: string;
  export: string;
}

export class ThreadRunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ThreadRunError";
  }
}

const BOOTSTRAP = `
const { workerData, parentPort } = require("node:worker_threads");
(async () => {
  try {
    const mod = await import(workerData.moduleUrl);
    const fn = mod[workerData.exportName];
    if (typeof fn !== "function") {
      throw new Error('export "' + workerData.exportName + '" is not a function in ' + workerData.moduleUrl);
    }
    const result = await fn(workerData.payload);
    parentPort.postMessage({ ok: true, result: result === undefined ? null : result });
  } catch (e) {
    parentPort.postMessage({
      ok: false,
      name: e && e.name ? e.name : "Error",
      message: e && e.message ? String(e.message) : String(e),
      stack: e && e.stack ? e.stack : null,
    });
  }
})();
`;

/**
 * Run a handler inside a worker thread so a timeout can TERMINATE it.
 * Unlike inline execution, a spinning synchronous handler cannot outlive
 * its deadline.
 */
export function runInThread(
  spec: ThreadExecutionSpec,
  payload: unknown,
  timeoutMs: number,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let w: NodeWorker;
    try {
      const moduleUrl = pathToFileURL(spec.module).href;
      w = new NodeWorker(BOOTSTRAP, {
        eval: true,
        workerData: { moduleUrl, exportName: spec.export, payload },
        stdout: false,
        stderr: false,
      });
    } catch (e) {
      reject(e);
      return;
    }
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      void w.terminate();
      reject(
        new ThreadRunError(
          `thread-isolated handler (${spec.module}#${spec.export}) exceeded its ${timeoutMs}ms timeout and its thread was terminated`,
        ),
      );
    }, timeoutMs);
    timer.unref?.();
    w.on("message", (msg: { ok: boolean; name?: string; message?: string; stack?: string | null }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void w.terminate();
      if (msg.ok) resolve();
      else {
        const err = new Error(msg.message ?? "thread handler failed");
        err.name = msg.name ?? "Error";
        if (msg.stack) err.stack = msg.stack;
        reject(err);
      }
    });
    w.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e instanceof Error ? e : new ThreadRunError(String(e)));
    });
    w.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new ThreadRunError(`thread exited before posting a result (exit code ${code})`));
    });
  });
}
