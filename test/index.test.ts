import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import activate, { initialLogOffset, LockedEngineError, newDenials, resolveEngine, shellQuote, wrapCommand, stateLayout } from "../src/index.ts";
import { PROMPT_BUDGET } from "../src/dialog.ts";

const FIXTURE = new URL("./fixtures/syd-3.59.0-access-deny.jsonl", import.meta.url).pathname;
const fixture = readFileSync(FIXTURE, "utf8").trimEnd();

test("shellQuote survives quotes, spaces and the empty string", () => {
  assert.equal(shellQuote("plain"), "'plain'");
  assert.equal(shellQuote("it's"), String.raw`'it'\''s'`);
  assert.equal(shellQuote(""), "''");
});

test("the wrapped command keeps the tool's bash -c semantics and logs to a file", () => {
  const wrapped = wrapCommand("rm -rf ./build", {
    sydPath: "/opt/syd",
    profilePath: "/work/profiles/sydbox.syd-3",
    logPath: "/work/syd.log",
    profile: "include_profile linux\nsandbox/lock:off\n",
  });
  assert.match(wrapped, /^exec 3>>'\/work\/syd\.log'; SYD_LOG_FD=3 /);
  assert.match(wrapped, /'\/bin\/bash' '-c' 'exec 3>&-; rm -rf \.\/build'$/);
});

test("the record fd crosses the engine's execve and is closed inside the workload", () => {
  const w = wrapCommand("true", {
    sydPath: "/opt/syd",
    profilePath: "/work/p.syd-3",
    logPath: "/work/syd.log",
    profile: "include_profile linux\nsandbox/lock:off\n",
  });
  // S1 corrected (fd-forge verdict 20261125-105950): CLOEXEC in the wrap
  // shell blinds the engine too (syd is exec'd by that same shell), so the
  // seal moves one level down — the workload's own first statement closes
  // fd 3. The engine (parent, never execs again) keeps the channel; the
  // workload and its descendants see EBADF, and the standing denies on the
  // log path (canonical-path checked, so /proc/self/fd/3 too) block reopening.
  assert.ok(!w.includes("set_inheritable"), "no CLOEXEC helper: the engine's channel must survive the exec");
  const workload = w.indexOf("exec 3>&-;");
  assert.ok(workload !== -1, "the workload runs the fd closer as its first statement");
  // The closer must live INSIDE the workload argv, after the engine's -- and
  // /bin/bash -c, not in the wrap shell that owns the real fd 3.
  const engineArg = w.indexOf("'/bin/bash' '-c'");
  assert.ok(engineArg !== -1 && engineArg < workload, "the closer is inside the child's command, after the bash argv");
});

test("a profile that breaks the namespace invariant is refused at wrap time", () => {
  assert.throws(() =>
    wrapCommand("true", {
      sydPath: "/opt/syd",
      profilePath: "/work/p.syd-3",
      logPath: "/work/syd.log",
      profile: "unshare/mount:1\n",
    }),
  );
});

test("only lines after the offset are reported, and only denials", () => {
  const first = newDenials(`${fixture}\n`, 0);
  assert.equal(first.records.length, 1);
  assert.equal(first.records[0]?.cap, "exec");
  assert.equal(first.offset, fixture.length + 1);

  const second = newDenials(`${fixture}\n`, first.offset);
  assert.equal(second.records.length, 0, "a re-read must not re-report the same denial");
  assert.equal(second.offset, first.offset);
});

test("a notice or a corrupt line advances the offset without becoming a record", () => {
  const log = '{"level":"info","msg":"starting"}\nnot json at all\n';
  const { records, offset } = newDenials(log, 0);
  assert.deepEqual(records, []);
  assert.equal(offset, log.length);
});

test("kill, panic, abort and filter are denials too — worse news must not vanish", () => {
  const line = (act: string) =>
    JSON.stringify({ ctx: "pid:42", cap: "read", act, sys: "openat", path: "/x" });
  for (const act of ["kill", "panic", "abort", "filter"]) {
    assert.equal(newDenials(`${line(act)}\n`, 0).records.length, 1, `${act} must be a denial`);
  }
  assert.equal(newDenials(`${line("allow")}\n${line("warn")}\n${line("exit")}\n`, 0).records.length, 0);
});

test("initialLogOffset is the existing log size, so history is not re-prompted", () => {
  const dir = mkdtempSync(join(tmpdir(), "sydbox-off-"));
  const missing = join(dir, "syd.log");
  assert.equal(initialLogOffset(missing), 0, "no log yet: nothing to skip");
  writeFileSync(missing, "old line\n");
  assert.equal(initialLogOffset(missing), "old line\n".length, "a prior session's records stay silent");
});

test("stateLayout is per-project and outside the workspace by default", () => {
  const env = { HOME: "/home/u", XDG_STATE_HOME: "/home/u/.local/state" };
  const layout = stateLayout("/work/project", env);
  assert.equal(layout.stateRoot, "/home/u/.local/state/pi-sydbox");
  assert.ok(layout.stateDir.startsWith("/home/u/.local/state/pi-sydbox/w-"), layout.stateDir);
  assert.equal(layout.logPath, join(layout.stateDir, "syd.log"));
  assert.equal(layout.projectGrants, join(layout.stateDir, "grants.json"));
  assert.equal(layout.globalGrants, "/home/u/.local/state/pi-sydbox/global/grants.json");
  const overridden = stateLayout("/work/project", { ...env, PI_SYDBOX_DIR: "/test/dir" });
  assert.equal(overridden.stateRoot, "/test/dir/.sydbox", "PI_SYDBOX_DIR keeps overriding for tests");
  // Two distinct projects never share a state directory.
  assert.notEqual(stateLayout("/work/other", env).stateDir, layout.stateDir);
});

test("an explicit engine path is used only when it is executable", () => {
  assert.equal(resolveEngine({ SYD_PATH: "/bin/sh" }), "/bin/sh");
  const env = { SYD_PATH: "/nonexistent/syd", PI_SYDBOX_LOCK: join("/nonexistent", "tree", "syd.lock") };
  const bogus = resolveEngine(env);
  // With no readable lock, the resolver scans the machine: on a host with an
  // installed engine that is a path, on a bare host it is null — never the
  // bad explicit path.
  assert.ok(bogus === null || bogus !== "/nonexistent/syd", "falls back to a scan, never to a bad path");
});

test("C5: a machine lock naming a missing engine refuses instead of scanning to a newer one", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sydbox-lock-"));
  const lock = join(dir, "syd.lock");
  // Exactly the shape a machine setup records — and a future uninstall breaks.
  writeFileSync(lock, JSON.stringify({ sourceBuild: { installedPath: join(dir, "gone", "syd") } }));
  const explicit = join(dir, "engine", "syd");
  mkdirSync(join(dir, "engine"), { recursive: true });
  writeFileSync(explicit, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

  // The explicit override still wins before the lock is even read.
  assert.equal(resolveEngine({ SYD_PATH: explicit, PI_SYDBOX_LOCK: lock }), explicit);

  let refused: unknown;
  try {
    resolveEngine({ PI_SYDBOX_LOCK: lock });
    assert.fail("a broken pin must refuse, never fall back to the version scan");
  } catch (err) {
    refused = err;
  }
  assert.ok(refused instanceof LockedEngineError, "the refusal is the lock error, not a scan result");
  const lockError = refused as LockedEngineError;
  assert.equal(lockError.lockPath, lock);
  assert.match(lockError.message, /refusing to run bash with an unvalidated engine/);

  // end-to-end: the refusal reaches the tool_call blocker and names the lock.
  const handlers = new Map<string, Handler>();
  activate({ on: (name: string, handler: Handler) => { handlers.set(name, handler); return () => {}; } } as never);
  process.env.PI_SYDBOX_LOCK = lock;
  delete process.env.SYD_PATH;
  try {
    const blocked = (await handlers.get("tool_call")?.({ toolName: "bash", input: { command: "echo hi" } }, { cwd: dir })) as
      | { block?: boolean; reason?: string }
      | undefined;
    assert.equal(blocked?.block, true);
    assert.ok(blocked?.reason?.includes(lock), "the block names the lock that pinned it");
  } finally {
    delete process.env.PI_SYDBOX_LOCK;
  }
});

type Handler = (event: unknown, ctx?: unknown) => unknown;

function fakePi() {
  const handlers = new Map<string, Handler>();
  const pi = {
    on: (name: string, handler: Handler) => {
      handlers.set(name, handler);
      return () => {};
    },
  };
  return { pi, handlers };
}

/**
 * The wiring is what the helper tests cannot reach: which hooks are registered
 * and what the bash hook does to the tool input. A registered-but-dead hook
 * passes every helper test, so activate() is driven through a fake PiApi.
 */
async function wiring(should: (dir: string, handlers: Map<string, Handler>) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "sydbox-wire-"));
  const engine = join(dir, "syd");
  writeFileSync(engine, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const saved = { SYD_PATH: process.env.SYD_PATH, PI_SYDBOX_DIR: process.env.PI_SYDBOX_DIR };
  process.env.SYD_PATH = engine;
  process.env.PI_SYDBOX_DIR = dir;
  try {
    const { pi, handlers } = fakePi();
    activate(pi as never);
    await should(dir, handlers);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("activate registers the tool_call and tool_result hooks", async () => {
  await wiring(async (_dir, handlers) => {
    assert.ok(handlers.has("tool_call"), "without tool_call nothing is sandboxed");
    assert.ok(handlers.has("tool_result"), "without tool_result denials never become prompts");
    assert.ok(handlers.has("user_bash"), "without user_bash `!` runs unconfined");
  });
});

test("a bash tool call is rewritten to run under the engine", async () => {
  await wiring(async (dir, handlers) => {
    const input = { command: "echo hi" };
    const verdict = await handlers.get("tool_call")?.({ toolName: "bash", input }, { cwd: dir });
    assert.equal(verdict, undefined, "an ordinary bash call is not blocked");
    assert.match(input.command, /'-P' '/, "the profile flag is passed, quoted like every argv element");
    assert.ok(input.command.includes(dir), "the profile lives under PI_SYDBOX_DIR");
    const profilePath = /'([^']+\.syd-3)'/.exec(input.command)?.[1];
    assert.ok(profilePath?.endsWith(".syd-3"), `profile path: ${profilePath}`);

    // One profile per session: a recompile per call would discard grants, and a
    // fresh path per call would leak a file per bash invocation.
    const second = { command: "echo again" };
    await handlers.get("tool_call")?.({ toolName: "bash", input: second }, { cwd: dir });
    assert.equal(/'([^']+\.syd-3)'/.exec(second.command)?.[1], profilePath);
  });
});

test("tools other than bash and non-string commands pass through untouched", async () => {
  await wiring(async (dir, handlers) => {
    const read = { path: "/etc/hosts" };
    assert.equal(await handlers.get("tool_call")?.({ toolName: "read", input: read }, { cwd: dir }), undefined);
    assert.deepEqual(read, { path: "/etc/hosts" });

    const odd = { command: 42 };
    assert.equal(await handlers.get("tool_call")?.({ toolName: "bash", input: odd }, { cwd: dir }), undefined);
    assert.equal(odd.command, 42, "a non-string command is not rewritten into garbage");
  });
});

/** A ctx.ui double: answers every prompt with a canned label, records calls. */
class UiProbe {
  public readonly selectCalls: string[] = [];
  public readonly notes: string[] = [];
  private readonly answer: string;
  constructor(answer: string) {
    this.answer = answer;
  }
  public readonly select = async (_prompt: string): Promise<string | undefined> => {
    this.selectCalls.push(this.answer);
    return this.answer;
  };
  public readonly notify = (message: string): void => {
    this.notes.push(message);
  };
}

test("a session grant is compiled into the profile the next call uses", async () => {
  // THE review bug (grants stored but never compiled): answering a prompt
  // must rewrite the very file the next spawn reads, in place.
  await wiring(async (dir, handlers) => {
    const ui = new UiProbe("Allow for this session");
    const ctx = { cwd: dir, ui: { select: ui.select, notify: ui.notify } };

    const input = { command: "echo hi" };
    await handlers.get("tool_call")?.({ toolName: "bash", input }, ctx);
    const profilePath = /'([^']+\.syd-3)'/.exec(String(input.command))?.[1];
    assert.ok(profilePath, "sanity: wrapped with a profile path");

    const layout = stateLayout(dir);
    mkdirSync(dirname(layout.logPath), { recursive: true });
    const line = JSON.stringify({ ctx: "pid:1", cap: "read", act: "deny", sys: "openat", path: "/work/data.txt" });
    writeFileSync(layout.logPath, `${line}\n`);

    await handlers.get("tool_result")?.({}, ctx);
    assert.equal(ui.selectCalls.length, 1, "one prompt, one denial");
    assert.match(ui.notes.join("|"), /session grant applied/);

    // Session grants are memory, not a write to the project store.
    assert.equal(existsSync(layout.projectGrants), false, "session tier does not touch disk");
    const rebuilt = readFileSync(profilePath!, "utf8");
    assert.match(rebuilt, /allow\/[a-z,]+\+\/work\/data\.txt/, "the grant must be in the file the engine reads next");
  });
});

test("the prompt budget stops the batch and reports what was left denied", async () => {
  await wiring(async (dir, handlers) => {
    const ui = new UiProbe("Deny");
    const ctx = { cwd: dir, ui: { select: ui.select, notify: ui.notify } };
    await handlers.get("tool_call")?.({ toolName: "bash", input: { command: "echo hi" } }, ctx);

    const layout = stateLayout(dir);
    mkdirSync(layout.stateDir, { recursive: true });
    const lines = Array.from({ length: PROMPT_BUDGET + 3 }, (_, i) =>
      JSON.stringify({ ctx: "pid:1", cap: "read", act: "deny", sys: "openat", path: `/work/f${i}.txt` }),
    );
    writeFileSync(layout.logPath, `${lines.join("\n")}\n`);

    await handlers.get("tool_result")?.({}, ctx);
    assert.equal(ui.selectCalls.length, PROMPT_BUDGET, "the budget caps the prompts");
    assert.match(ui.notes.join("|"), /3 further denial/, "the overflow is reported, not silently dropped");
  });
});

test("user_bash is gated: it wraps or refuses, never falls through", async () => {
  // Returning undefined from every user_bash handler is what makes pi run the
  // command through its own unsandboxed backend, so the assertion is precisely
  // "not undefined".
  await wiring(async (dir, handlers) => {
    const handler = handlers.get("user_bash");
    const ui = new UiProbe("Deny");
    const verdict = await handler?.({ command: "echo hi" }, { cwd: dir, ui: { select: ui.select, notify: ui.notify } });
    assert.notEqual(verdict, undefined, "undefined here means an unsandboxed shell");
    const shaped = verdict as { operations?: { exec?: unknown }; result?: { exitCode?: number } };
    if (shaped.operations !== undefined) {
      assert.equal(typeof shaped.operations.exec, "function", "operations must be executable");
    } else {
      assert.equal(shaped.result?.exitCode, 126, "a refusal is recorded as a result, nothing runs");
    }
  });
});

test("initialLogOffset counts UTF-16 units, not bytes (C1)", () => {
  const dir = mkdtempSync(join(tmpdir(), "sydbox-off-"));
  const log = join(dir, "records.jsonl");
  // A record with multibyte content: byte size and string length disagree.
  const line = JSON.stringify({ path: "déjà-vu.txt", cap: "read", act: "deny" });
  writeFileSync(log, `${line}\n`);
  const text = readFileSync(log, "utf8");
  assert.ok(Buffer.byteLength(line) > line.length, "sanity: multibyte present");
  assert.equal(initialLogOffset(log), text.length);
  // The seed must behave like newDenials' slice index: from it, the whole
  // file is "history" and a later call reports only what was appended after.
  assert.deepEqual(newDenials(text, initialLogOffset(log)).records, []);
});

test("an allow-once grant feeds exactly one spawn and can prompt again (C2)", async () => {
  await wiring(async (dir, handlers) => {
    const ui = new UiProbe("Allow once");
    const ctx = { cwd: dir, ui: { select: ui.select, notify: ui.notify } };

    const first = { command: "echo hi" };
    await handlers.get("tool_call")?.({ toolName: "bash", input: first }, ctx);
    const profilePath = /'([^']+\.syd-3)'/.exec(String(first.command))?.[1];
    assert.ok(profilePath, "sanity: wrapped with a profile path");

    const layout = stateLayout(dir);
    mkdirSync(dirname(layout.logPath), { recursive: true });
    const line = JSON.stringify({ ctx: "pid:1", cap: "read", act: "deny", sys: "openat", path: "/work/once.txt" });
    writeFileSync(layout.logPath, `${line}\n`);
    await handlers.get("tool_result")?.({}, ctx);
    assert.match(readFileSync(profilePath!, "utf8"), /allow\/[a-z,]+\+\/work\/once\.txt/, "grant is compiled for the next spawn");

    // That spawn consumes the mandate: the file still carries the rule NOW
    // (it feeds this very child), and the NEXT call recompiles clean.
    const second = { command: "echo there" };
    await handlers.get("tool_call")?.({ toolName: "bash", input: second }, ctx);
    assert.match(readFileSync(profilePath!, "utf8"), /once\.txt/, "the spawn the grant feeds is still granted");
    const third = { command: "echo again" };
    await handlers.get("tool_call")?.({ toolName: "bash", input: third }, ctx);
    assert.doesNotMatch(readFileSync(profilePath!, "utf8"), /once\.txt/, "after the granted spawn the next recompile is clean");

    // The lapsed rule must be able to prompt again, not be swallowed by a
    // dedupe that remembers the expired grant.
    const again = JSON.stringify({ ctx: "pid:2", cap: "read", act: "deny", sys: "openat", path: "/work/once.txt" });
    appendFileSync(layout.logPath, `${again}\n`);
    await handlers.get("tool_result")?.({}, ctx);
    assert.ok(ui.selectCalls.length >= 2, "a lapsed once-grant prompts again");
    assert.equal(existsSync(layout.projectGrants), false, "once never touches the project store");
  });
});

test("a sandbox.json deny is reported as a policy deny, not offered as a grant (S3)", async () => {
  await wiring(async (dir, handlers) => {
    // The policy is read once at first state creation: it must exist before
    // the first call.
    writeFileSync(join(dir, "sandbox.json"), JSON.stringify({ filesystem: { denyWrite: ["/work/locked-area"] } }));
    const ui = new UiProbe("Allow for this session");
    const ctx = { cwd: dir, ui: { select: ui.select, notify: ui.notify } };

    await handlers.get("tool_call")?.({ toolName: "bash", input: { command: "echo hi" } }, ctx);
    const layout = stateLayout(dir);
    mkdirSync(dirname(layout.logPath), { recursive: true });
    const line = JSON.stringify({ ctx: "pid:1", cap: "create", act: "deny", sys: "mknod", path: "/work/locked-area/new.txt" });
    writeFileSync(layout.logPath, `${line}\n`);

    await handlers.get("tool_result")?.({}, ctx);
    assert.equal(ui.selectCalls.length, 0, "a policy deny must never reach the grant tiers");
    assert.match(ui.notes.join("|"), /policy deny \(sandbox\.json\)/, "the dialog says where the deny comes from");
    assert.equal(existsSync(layout.projectGrants), false, "no dead grant is persisted");
  });
});

test("unrecognised log lines are counted and reported, not swallowed (D3)", async () => {
  await wiring(async (dir, handlers) => {
    const ui = new UiProbe("Deny");
    const ctx = { cwd: dir, ui: { select: ui.select, notify: ui.notify } };
    await handlers.get("tool_call")?.({ toolName: "bash", input: { command: "echo hi" } }, ctx);

    const layout = stateLayout(dir);
    mkdirSync(dirname(layout.logPath), { recursive: true });
    const line = JSON.stringify({ ctx: "pid:1", cap: "read", act: "deny", sys: "openat", path: "/work/data.txt" });
    writeFileSync(layout.logPath, `not-a-record\n${line}\n{"garbled":\n`);

    await handlers.get("tool_result")?.({}, ctx);
    assert.equal(ui.selectCalls.length, 1, "the real denial still prompts");
    assert.match(ui.notes.join("|"), /2 log line\(s\) not recognised/, "drift is visible to the operator");
  });
});
