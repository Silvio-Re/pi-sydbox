#!/usr/bin/env node
/**
 * P0 auto-deny measurement harness (headless RPC probe).
 *
 * Drives the real pi binary in RPC mode with the real pi-sydbox extension
 * loaded, answers nothing to the denial select, and measures the agent-side
 * auto-resolve. Model work comes from an in-process fake openai-completions
 * server on 127.0.0.1 (no network LLM): requests 1/3 reply with a bash tool
 * call, requests 2/4 with a plain completion, so pi's real bash tool runs
 * twice and the extension's real tool_call/tool_result pipeline executes.
 *
 * The engine is a stub (harness dir ../engine/syd): the probe measures the
 * EXTENSION DIALOG LAYER (the timeout key and the auto-resolve), not engine
 * confinement. The denial record is a real committed capture, appended to
 * the extension's session log between the two rounds.
 *
 * Usage:
 *   node run-probe.mjs \
 *     --pi <path to pi cli.js> \
 *     --ext <path to pi-sydbox src/index.ts> \
 *     --provider-ext <path to the fake provider extension> \
 *     --repo <repo root, for the fixture line> \
 *     --work <scratch dir: state, project, logs> \
 *     --expect-timeout-ms <N, sanity: the select must carry this timeout> \
 *     [--pi-arg ...] (extra args passed to pi, e.g. --offline)
 *
 * Output: prints a JSON summary on stdout and writes <work>/rpc-records.jsonl
 * (every RPC record seen) and <work>/model-server.jsonl (every model request).
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : fallback;
}
const extraPiArgs = (() => {
  const i = process.argv.indexOf("--pi-arg");
  return i === -1 ? [] : process.argv.slice(i + 1);
})();

const PI = arg("pi");
const EXT = arg("ext");
const PROVIDER_EXT = arg("provider-ext", join(new URL(".", import.meta.url).pathname, "fake-provider.ts"));
const REPO = arg("repo");
const WORK = arg("work");
const EXPECT_MS = Number(arg("expect-timeout-ms", "0"));
const PORT = Number(arg("port", "18771"));

if (!PI || !EXT || !PROVIDER_EXT || !REPO || !WORK) {
  console.error("missing arguments (pi/ext/provider-ext/repo/work)");
  process.exit(2);
}
mkdirSync(WORK, { recursive: true });
const projectDir = join(WORK, "project");
mkdirSync(projectDir, { recursive: true });
// The stub engine: passes the gate self-check, execs nothing. The probe
// measures the dialog layer; engine confinement is out of its scope, and no
// real engine exists in the probe environment by design.
const stubEngine = join(WORK, "engine", "syd");
mkdirSync(join(WORK, "engine"), { recursive: true });
writeFileSync(stubEngine, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
const recordsLog = join(WORK, "rpc-records.jsonl");
const serverLog = join(WORK, "model-server.jsonl");
writeFileSync(recordsLog, "");
writeFileSync(serverLog, "");

const DENIAL_LINE = (() => {
  // The exec deny from the committed W3 capture set: the same record the
  // unit fixtures use (test/fixtures/syd-3.59.0-access-deny.jsonl, line 1).
  const text = readFileSync(join(REPO, "test/fixtures/syd-3.59.0-access-deny.jsonl"), "utf8");
  return text.split("\n").find((l) => l.trim() !== "");
})();

const logRecord = (file, obj) => appendFileSync(file, `${JSON.stringify({ ...obj, ts: new Date().toISOString() })}\n`);

// --- 1. The fake model server: scripted by request ordinal. ---------------
const modelRequests = []; // {n, arrived}
let n = 0;
const server = createServer((req, res) => {
  const index = ++n;
  const arrived = Date.now();
  modelRequests.push({ index, arrived });
  logRecord(serverLog, { event: "model_request", n: index, method: req.method, url: req.url });
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    logRecord(serverLog, { event: "model_body", n: index, chars: body.length });
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    const sse = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
    const chunkBase = { id: `chatcmpl-probe-${index}`, object: "chat.completion.chunk", created: 0, model: "fake-chat" };
    if (index % 2 === 1) {
      // A bash tool call: the extension's tool_call hook wraps it, the real
      // tool executes (under the stub engine), and the tool_result hook runs.
      sse({
        ...chunkBase, choices: [{
          index: 0,
          delta: { role: "assistant", tool_calls: [{ index: 0, id: `call-${index}`, type: "function", function: { name: "bash", arguments: "{\"command\":\"echo probe\"}" } }] },
          finish_reason: null,
        }],
      });
      sse({ ...chunkBase, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
    } else {
      sse({ ...chunkBase, choices: [{ index: 0, delta: { role: "assistant", content: "Done." }, finish_reason: null }] });
      sse({ ...chunkBase, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    }
    sse({ ...chunkBase, choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    res.write("data: [DONE]\n\n");
    res.end();
    logRecord(serverLog, { event: "model_replied", n: index });
  });
});

await new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve));

// --- 2. Spawn pi in RPC mode with the real extension. --------------------
const env = {
  ...process.env,
  SYD_PATH: stubEngine,
  PI_SYDBOX_DIR: join(WORK, "state"),
};
// The machine pin must not exist here on purpose: the self-check gate holds.
const child = spawn(process.execPath, [PI, "--mode", "rpc", "--no-session",
  "--provider", "probe", "--model", "fake-chat",
  "--offline", "--no-skills", "--no-prompt-templates", "--no-themes",
  "-e", EXT, "-e", PROVIDER_EXT,
  ...extraPiArgs], { cwd: projectDir, env, stdio: ["pipe", "pipe", "pipe"] });

const stderrTail = [];
child.stderr.on("data", (d) => { stderrTail.push(String(d)); if (stderrTail.length > 40) stderrTail.shift(); });

const seen = { select: null };       // { arrived, timeout }
let buffer = "";
child.stdout.on("data", (d) => {
  buffer += String(d);
  let idx;
  while ((idx = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, idx).replace(/\r$/, "");
    buffer = buffer.slice(idx + 1);
    if (line.trim() === "") continue;
    let record;
    try { record = JSON.parse(line); } catch { logRecord(recordsLog, { event: "unparseable", line: line.slice(0, 400) }); continue; }
    logRecord(recordsLog, { event: "rpc", record });
    if (record?.type === "extension_ui_request" && record?.method === "select" && seen.select === null) {
      seen.select = { arrived: Date.now(), timeout: record.timeout ?? null, raw: record };
    }
  }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitModelRequest = (ordinal, deadlineMs) => new Promise((resolve, reject) => {
  const t0 = Date.now();
  const poll = setInterval(() => {
    if (modelRequests.some((r) => r.index === ordinal)) { clearInterval(poll); resolve(); }
    else if (Date.now() - t0 > deadlineMs) { clearInterval(poll); reject(new Error(`model request #${ordinal} never arrived`)); }
  }, 50);
});

const summary = { pi: PI, ext: EXT, expectTimeoutMs: EXPECT_MS, phases: {} };
const fail = (phase, err) => {
  summary.phases[phase] = { ok: false, error: String(err && err.message ? err.message : err) };
  child.kill("SIGKILL");
  console.error(JSON.stringify(summary, null, 2));
  console.error("stderr tail:\n" + stderrTail.join(""));
  process.exit(1);
};

try {
  // Round A: one bash tool call creates the session state (offset seeded,
  // log file opened empty by the wrap shell), then a short completion ends it.
  child.stdin.write(`${JSON.stringify({ id: "pA", type: "prompt", message: "Round A: run the probe command." })}\n`);
  try { await waitModelRequest(2, 90_000); } catch (e) { fail("roundA", e); }
  summary.phases.roundA = { ok: true };

  // Seed the real captured denial AFTER the state exists (so the record is
  // new, not history) and BEFORE round B's tool_result reads the log.
  const stateRoot = join(env.PI_SYDBOX_DIR, ".sydbox");
  await sleep(800); // let extension settle writes; the record is read at tool_result
  const seeded = (() => {
    const entries = readdirSync(stateRoot, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name.startsWith("w-"));
    let wrote = null;
    for (const e of entries) {
      const log = join(stateRoot, e.name, "syd.log");
      mkdirSync(join(stateRoot, e.name), { recursive: true });
      appendFileSync(log, `${DENIAL_LINE}\n`);
      wrote = log;
    }
    if (wrote === null) {
      // state dir may not exist if the extension did not load: fail loudly
      throw new Error(`no state workspace dir under ${stateRoot}: extension state never created`);
    }
    return wrote;
  })();
  summary.phases.seed = { ok: true, log: seeded, chars: DENIAL_LINE.length };

  // Round B: bash runs again; the tool_result hook sees the seeded denial and
  // issues the select. This client stays SILENT on it: the auto-deny path.
  child.stdin.write(`${JSON.stringify({ id: "pB", type: "prompt", message: "Round B: run the probe command again." })}\n`);
  try { await waitModelRequest(3, 90_000); } catch (e) { fail("roundB", e); }
  summary.phases.roundB_toolcall = { ok: true, t_req3: modelRequests.find((r) => r.index === 3)?.arrived };

  // Wait for the select request (extension_ui_request, method select).
  const selectDeadline = Date.now() + 120_000;
  while (seen.select === null && Date.now() < selectDeadline) await sleep(50);
  if (seen.select === null) fail("select", new Error("no extension_ui_request(select) arrived"));
  const tSelect = seen.select.arrived;
  summary.select = { arrived: new Date(tSelect).toISOString(), timeoutFieldMs: seen.select.timeout };

  // The answer never comes: wait for the post-timeout continuation, i.e. the
  // model's second round-B request (only reachable after the dialog resolved).
  try { await waitModelRequest(4, 300_000); } catch (e) { fail("continuation", e); }
  const tContinue = modelRequests.find((r) => r.index === 4)?.arrived ?? Date.now();
  const delta = tContinue - tSelect;
  summary.autoDeny = {
    selectAt: new Date(tSelect).toISOString(),
    continuedAt: new Date(tContinue).toISOString(),
    measuredMs: delta,
  };
  summary.checks = {
    timeoutFieldMatchesExpectation: EXPECT_MS ? seen.select.timeout === EXPECT_MS : null,
    measuredWithinTolerance: EXPECT_MS ? delta >= EXPECT_MS - 2500 && delta <= EXPECT_MS + 2500 : null,
  };
  await sleep(1200);
  child.kill("SIGTERM");
  summary.ok = true;
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
} catch (err) {
  fail("unexpected", err);
}
