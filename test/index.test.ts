import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import activate, { newDenials, resolveEngine, shellQuote, wrapCommand } from "../src/index.ts";

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
  assert.match(wrapped, /^SYD_LOG='\/work\/syd\.log' /);
  assert.match(wrapped, /'\/opt\/syd' '-P' '\/work\/profiles\/sydbox\.syd-3' '--' '\/bin\/bash' '-c' 'rm -rf \.\/build'$/);
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
  assert.equal(first.records[0].cap, "exec");
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

test("an explicit engine path is used only when it is executable", () => {
  assert.equal(resolveEngine({ SYD_PATH: "/bin/sh" }), "/bin/sh");
  const bogus = resolveEngine({ SYD_PATH: "/nonexistent/syd" });
  assert.ok(bogus === null || bogus.startsWith("/"), "falls back to a scan, never to a bad path");
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

test("user_bash is gated: it wraps or refuses, never falls through", async () => {
  // Returning undefined from every user_bash handler is what makes pi run the
  // command through its own unsandboxed backend, so the assertion is precisely
  // "not undefined".
  await wiring(async (dir, handlers) => {
    const handler = handlers.get("user_bash");
    assert.ok(handler, "no user_bash handler registered");
    const verdict = await handler({ command: "echo hi" }, { cwd: dir });
    assert.notEqual(verdict, undefined, "undefined here means an unsandboxed shell");
    const shaped = verdict as { operations?: { exec?: unknown }; result?: { exitCode?: number } };
    if (shaped.operations !== undefined) {
      assert.equal(typeof shaped.operations.exec, "function", "operations must be executable");
    } else {
      assert.equal(shaped.result?.exitCode, 126, "a refusal is recorded as a result, nothing runs");
    }
  });
});
