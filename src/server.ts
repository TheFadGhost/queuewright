import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { join, normalize, extname } from "node:path";
import type { Queuewright } from "./client.js";
import type { JobState } from "./types.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

export interface DashboardOptions {
  port?: number;
  host?: string;
}

export class DashboardServer {
  private server: Server | null = null;

  constructor(
    private readonly qw: Queuewright,
    private readonly assetsDir: string,
    private readonly opts: DashboardOptions = {},
  ) {}

  async start(): Promise<{ port: number; host: string }> {
    const port = this.opts.port ?? 7788;
    const host = this.opts.host ?? "127.0.0.1";
    const server = createServer((req, res) => {
      void this.handle(req, res).catch(() => {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "internal error" }));
      });
    });
    await new Promise<void>((resolve) => server.listen(port, host, resolve));
    this.server = server;
    return { port, host };
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }

  get address(): string | null {
    const a = this.server?.address();
    if (a === null || a === undefined) return null;
    return typeof a === "string" ? a : `http://localhost:${a.port}`;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = decodeURIComponent(url.pathname);
    if (path.startsWith("/api/")) {
      await this.handleApi(req, res, path, url.searchParams);
      return;
    }
    if (path === "/metrics") {
      const body = await this.renderMetrics();
      res.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8" });
      res.end(body);
      return;
    }
    if (path === "/healthz") {
      let storage = "down";
      try {
        storage = (await this.qw.storage.ping()) ? "ok" : "down";
      } catch {
        storage = "down";
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: storage === "ok" ? "ok" : "degraded", storage, uptimeMs: Math.round(process.uptime() * 1000) }));
      return;
    }
    await this.serveStatic(res, path);
  }

  private async renderMetrics(): Promise<string> {
    try {
      const stats = await this.qw.stats();
      this.qw.metrics.resetGauges("qw_jobs_state");
      for (const [state, n] of Object.entries(stats.states)) {
        this.qw.metrics.setGauge("qw_jobs_state", "Jobs by state", ["state"], [state], n);
      }
      this.qw.metrics.resetGauges("qw_queue_depth");
      for (const q of stats.queues) {
        for (const [state, n] of Object.entries(q)) {
          if (state === "queue") continue;
          this.qw.metrics.setGauge("qw_queue_depth", "Queue depth by state", ["queue", "state"], [q.queue, state], n as number);
        }
      }
    } catch {
      // metrics scrape must not fail because storage blipped; emit counters only
    }
    return this.qw.metrics.render();
  }

  private async handleApi(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    params: URLSearchParams,
  ): Promise<void> {
    const qw = this.qw;
    const sendJson = (code: number, body: unknown): void => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method !== "GET" && req.method !== "POST" && req.method !== "HEAD") {
      sendJson(405, { error: "method not allowed" });
      return;
    }
    try {
      if (path === "/api/stats" && req.method === "GET") {
        sendJson(200, await qw.stats());
        return;
      }
      if (path === "/api/timeseries" && req.method === "GET") {
        const windowMs = clampInt(params.get("windowMs"), 900_000, [900_000, 3_600_000, 21_600_000, 86_400_000]);
        const buckets = clampInt(params.get("buckets"), 60, [15, 30, 60, 120]);
        sendJson(200, { points: await qw.timeseries(windowMs, buckets) });
        return;
      }
      if (path === "/api/jobs" && req.method === "GET") {
        const states = (params.get("states") ?? "")
          .split(",")
          .filter((s): s is JobState => s.length > 0);
        const query: import("./storage/interface.js").ListJobsQuery = {
          states,
          limit: Math.min(500, Number(params.get("limit") ?? 50) || 50),
          cursor: params.get("cursor"),
          order: (params.get("order") as "created_desc" | "created_asc" | null) ?? "created_desc",
        };
        const queue = emptyToUndefined(params.get("queue"));
        const type = emptyToUndefined(params.get("type"));
        const search = emptyToUndefined(params.get("search"));
        if (queue !== undefined) query.queue = queue;
        if (type !== undefined) query.type = type;
        if (search !== undefined) query.search = search;
        sendJson(200, await qw.listJobs(query));
        return;
      }
      const jobMatch = /^\/api\/jobs\/([A-Za-z0-9_:-]+)(\/(events|retry|cancel|requeue))?$/.exec(path);
      if (jobMatch) {
        const jobId = jobMatch[1]!;
        const action = jobMatch[3];
        if (!action && req.method === "GET") {
          const job = await qw.getJob(jobId);
          if (!job) {
            sendJson(404, { error: `job "${jobId}" not found`, fix: "list jobs to find the correct id" });
            return;
          }
          sendJson(200, { job });
          return;
        }
        if (action === "events" && req.method === "GET") {
          sendJson(200, { events: await qw.storage.getJobEvents(jobId) });
          return;
        }
        if ((action === "retry" || action === "requeue") && req.method === "POST") {
          const existing = await qw.getJob(jobId);
          if (!existing) {
            sendJson(404, { error: `job "${jobId}" not found` });
            return;
          }
          try {
            const job = await qw.requeueJob(jobId, { resetAttempts: true });
            sendJson(200, { job });
          } catch (e) {
            sendJson(409, { error: describe(e), fix: `only dead/failed/succeeded/cancelled jobs can be requeued; current state is "${existing.state}"` });
          }
          return;
        }
        if (action === "cancel" && req.method === "POST") {
          try {
            const job = await qw.cancelJob(jobId);
            sendJson(200, { job });
          } catch (e) {
            sendJson(409, { error: describe(e), fix: "only queued/scheduled/retrying jobs can be cancelled" });
          }
          return;
        }
      }
      const queueMatch = /^\/api\/queues\/([a-zA-Z0-9_-]+)\/(pause|resume)$/.exec(path);
      if (queueMatch && req.method === "POST") {
        await qw.setPaused({ scope: "queue", queue: queueMatch[1]!, paused: queueMatch[2] === "pause" });
        sendJson(200, { ok: true });
        return;
      }
      if (path === "/api/pause-all" && req.method === "POST") {
        await qw.setPaused({ scope: "global", queue: null, paused: true });
        sendJson(200, { ok: true });
        return;
      }
      if (path === "/api/resume-all" && req.method === "POST") {
        await qw.setPaused({ scope: "global", queue: null, paused: false });
        sendJson(200, { ok: true });
        return;
      }
      sendJson(404, { error: `no route ${path}` });
    } catch (e) {
      sendJson(500, { error: describe(e) });
    }
  }

  private async serveStatic(res: ServerResponse, rawPath: string): Promise<void> {
    const rel = rawPath === "/" ? "/index.html" : rawPath;
    const safe = normalize(rel).replace(/^(\.\.[/\\])+/, "");
    const file = join(this.assetsDir, safe);
    if (!file.startsWith(this.assetsDir)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, {
        "content-type": MIME[extname(file)] ?? "application/octet-stream",
        "cache-control": "no-store",
      });
      res.end(body);
    } catch {
      const fallback = await readFile(join(this.assetsDir, "index.html")).catch(() => null);
      if (fallback) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(fallback);
        return;
      }
      res.writeHead(404).end("dashboard assets missing");
    }
  }
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function emptyToUndefined(v: string | null): string | undefined {
  return v === null || v.length === 0 ? undefined : v;
}

function clampInt(raw: string | null, fallback: number, allowed: number[]): number {
  const n = Number(raw);
  if (!Number.isInteger(n)) return fallback;
  return allowed.includes(n) ? n : fallback;
}
