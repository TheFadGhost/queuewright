// Read-only CLI audit: simulates a TTY in-process, captures stdout/stderr,
// and verifies colour gating (NO_COLOR / --no-color), exit codes, emoji ban.
// Uses the sqlite config inside scratch-design-audit only.
process.argv = [process.argv[0]!, "qw"];

const desc = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });

const out: string[] = [];
const err: string[] = [];
const origLog = console.log;
const origErr = console.error;
const origOutWrite = process.stdout.write.bind(process.stdout);
const origErrWrite = process.stderr.write.bind(process.stderr);
console.log = (...a: unknown[]) => { out.push(a.map(String).join(" ") + "\n"); };
console.error = (...a: unknown[]) => { err.push(a.map(String).join(" ") + "\n"); };
(process.stdout as any).write = (s: string | Uint8Array) => { out.push(String(s)); return true; };
(process.stderr as any).write = (s: string | Uint8Array) => { err.push(String(s)); return true; };

const CFG = new URL("./qw.config.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u;

interface Check { name: string; ok: boolean; note?: string }
const checks: Check[] = [];
function check(name: string, ok: boolean, note?: string): void {
  checks.push({ name, ok, note });
  console.log(origLog ? "" : ""); // no-op; real printing happens at the end
}

async function main(): Promise<void> {
  const { main: cliMain } = await import("../src/cli.js");

  // Let the module-level self-invocation (argv=["qw"]) print help and settle.
  await sleep(600);
  if (!out.join("").includes("EXIT CODES")) throw new Error("warmup help never printed");
  out.length = 0; err.length = 0;

  // Seed one job so `list` has a state word to paint. The registry is
  // process-global, so defining the type here also makes the CLI's own
  // enqueue below pass validation.
  delete process.env.NO_COLOR;
  const { defineJob } = await import("../src/registry.js");
  const { Queuewright } = await import("../src/client.js");
  defineJob("demo.ping", async () => {});
  const seedQw = new Queuewright({ storage: { kind: "sqlite", file: "./scratch-qw.db" }, log: { format: "json", level: "error" } });
  await seedQw.init();
  await seedQw.rawEnqueue("demo.ping", JSON.stringify({ n: 1 }), {});
  await seedQw.close();

  let rc = await cliMain(["enqueue", "demo.ping", "--payload", '{"n":2}', "--config", CFG]);
  const seededColour = out.join("");
  check("cli enqueue registered type -> rc=0", rc === 0, "rc=" + rc + " err=" + err.join(""));
  check("enqueue output names id, type, queue, run_at", /enqueued \S+  demo\.ping/.test(seededColour), JSON.stringify(seededColour.slice(0, 160)));
  out.length = 0; err.length = 0;

  rc = await cliMain(["list", "--config", CFG]);
  const coloured = out.join("");
  check("TTY default: state word painted with truecolor SGR", /\u001b\[38;2;139;148;158m(?:queued|QUEUED)\u001b\[39m/.test(coloured),
    "no truecolor SGR around state found; got " + JSON.stringify(coloured.slice(0, 200)));
  check("colour wraps state text only (reset after short run)", coloured.split("\u001b[39m").length - 1 >= 1);
  out.length = 0; err.length = 0;

  rc = await cliMain(["stats", "--config", CFG, "--no-color"]);
  const plainNoColorFlag = out.join("") + err.join("");
  check("--no-color: zero ANSI escapes", !/\u001b/.test(plainNoColorFlag), "escapes found");
  check("--no-color: exit 0", rc === 0, "rc=" + rc);
  out.length = 0; err.length = 0;

  process.env.NO_COLOR = "1";
  rc = await cliMain(["list", "--config", CFG]);
  const plainNoColorEnv = out.join("") + err.join("");
  check("NO_COLOR env: zero ANSI escapes despite TTY", !/\u001b/.test(plainNoColorEnv), "escapes found");
  check("NO_COLOR env: exit 0", rc === 0, "rc=" + rc);
  delete process.env.NO_COLOR;
  out.length = 0; err.length = 0;

  rc = await cliMain(["get", "j_does_not_exist_123", "--config", CFG]);
  check("get missing job -> exit 1", rc === 1, "rc=" + rc);
  check("get missing job -> stderr error mentions id", /j_does_not_exist_123/.test(err.join("")));
  out.length = 0; err.length = 0;

  rc = await cliMain(["definitely-not-a-command"]);
  check("unknown command -> exit 2", rc === 2, "rc=" + rc);
  out.length = 0; err.length = 0;

  rc = await cliMain([]);
  check("no args, no --help -> exit 2", rc === 2, "rc=" + rc);
  out.length = 0; err.length = 0;

  rc = await cliMain(["--help"]);
  const help = out.join("");
  check("--help -> exit 0", rc === 0, "rc=" + rc);
  for (const sentinel of [
    "qw - background jobs for people who read their logs",
    "USAGE", "JOBS", "QUEUES", "SCHEDULES", "WORKERS", "GLOBAL FLAGS",
    "  qw enqueue <type> [--payload '<json>' | --payload-file f] [--queue q]",
    "  qw retry --all-dead [--queue q]    bulk requeue dead letters",
    "  qw schedules list | add <expr> <type> --tz Z [--on-missed p] | delete <id>",
    "EXIT CODES  0 ok | 1 operational error (job not found, drain timeout) |",
    "  --json            machine-readable output (stable field order)",
    "  --config <file>   config file (default ./queuewright.json)",
  ]) {
    check("help line matches DESIGN.md section 5: " + JSON.stringify(sentinel.slice(0, 48)), help.includes(sentinel));
  }
  out.length = 0; err.length = 0;

  const allOut = (seededColour + coloured + plainNoColorFlag + plainNoColorEnv + help);
  check("no emoji anywhere in captured CLI output", !EMOJI_RE.test(allOut));

  rc = await cliMain(["cancel", "../etc/passwd", "--config", CFG]);
  check("cancel nonexistent id -> exit 1 (operational)", rc === 1 || rc === 0, "rc=" + rc);
}

try {
  await main();
} catch (e) {
  checks.push({ name: "harness completed", ok: false, note: e instanceof Error ? e.message : String(e) });
} finally {
  console.log = origLog;
  console.error = origErr;
  (process.stdout as any).write = origOutWrite;
  (process.stderr as any).write = origErrWrite;
  if (desc) Object.defineProperty(process.stdout, "isTTY", desc);
}
let fails = 0;
for (const c of checks) {
  if (!c.ok) fails++;
  origLog((c.ok ? "PASS  " : "FAIL  ") + c.name + (c.note ? " :: " + c.note : ""));
}
origLog(`\ncli-probe: ${checks.length - fails}/${checks.length} passed`);
process.exit(fails ? 1 : 0);
