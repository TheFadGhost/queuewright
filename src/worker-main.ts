#!/usr/bin/env node
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Queuewright } from "./client.js";
import { DashboardServer } from "./server.js";
import { DEFAULTS, loadConfigFile, type QueuewrightConfig } from "./config.js";

export async function runWorkerMain(argv: string[] = process.argv.slice(2)): Promise<number> {
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const configPath = flag("--config") ?? "queuewright.json";
  const config: QueuewrightConfig = {
    ...loadConfigFile(configPath),
  };
  if (flag("--concurrency") !== undefined) config.concurrency = Number(flag("--concurrency"));
  const queuesFlag = flag("--queues");
  if (queuesFlag !== undefined) config.queues = queuesFlag.split(",").map((q) => q.trim()).filter((q) => q.length > 0);

  const qw = new Queuewright(config);
  await qw.init();
  await qw.applyStartupRules(config);
  const worker = qw.createWorker();

  let dashboardUrl: string | null = null;
  if (config.dashboard !== false && !flag("--no-dashboard")) {
    const dashCfg = config.dashboard ?? {};
    const assetsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "dashboard-assets");
    const dashboard = new DashboardServer(qw, assetsDir, {
      port: dashCfg.port ?? DEFAULTS.dashboardPort,
      host: dashCfg.host ?? DEFAULTS.dashboardHost,
    });
    try {
      const addr = await dashboard.start();
      dashboardUrl = `http://${addr.host === "127.0.0.1" ? "localhost" : addr.host}:${addr.port}`;
    } catch (e) {
      qw.logger.warn("dashboard could not start; continuing without it", {
        module: "worker-main",
        err: e instanceof Error ? { name: e.name, message: e.message, stack: e.stack ?? null } : { name: "Error", message: String(e), stack: null },
      });
    }
  }
  qw.logger.info("queuewright worker ready", {
    module: "worker-main",
    kv: { concurrency: qw.concurrency, dashboard: dashboardUrl ?? "off" },
  });
  await worker.runUntilSignal();
  await qw.close();
  return 0;
}

const invokedDirectly = process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href;

if (invokedDirectly || process.env["QW_FORCE_WORKER_MAIN"] === "1") {
  void runWorkerMain().then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Error: ${msg}\n`);
      process.exitCode = err instanceof Error && err.name === "ConfigValidationError" ? 2 : 1;
    },
  );
}
