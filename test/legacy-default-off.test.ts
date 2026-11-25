import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import activate, { stateLayout } from "../src/index.ts";

/**
 * Legacy-grant import (S2, external review): a pre-0.2 grants file inside the
 * workspace must never preload a fresh clone with permanent grants. The
 * default is no import; PI_SYDBOX_IMPORT_LEGACY=1 is the explicit opt-in.
 *
 * The import runs once, while the FIRST tool call creates the session state —
 * and the module's state singleton lives as long as the process. One process
 * cannot test both the default and the opt-in, so each gets its own file
 * (node --test runs every file in its own process). If PI_SYDBOX_IMPORT_LEGACY
 * is set while this default-off file runs, mark the env and the whole case
 * fails — the two files share nothing except process.env from the runner.
 */
test("default: a workspace legacy store is not imported (fresh clone safety)", async () => {
  assert.notEqual(process.env.PI_SYDBOX_IMPORT_LEGACY, "1", "running the default case with the opt-in set is a broken test env");
  const dir = mkdtempSync(join(tmpdir(), "sydbox-leg-"));
  const engine = join(dir, "syd");
  writeFileSync(engine, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const legacy = join(dir, "agent_dir", ".sydbox");
  mkdirSync(legacy, { recursive: true });
  writeFileSync(join(legacy, "grants.json"), JSON.stringify([{ tier: "project", rule: "allow/lpath,npath,rpath+/etc/passwd" }]));

  const handlers = new Map<string, (event: unknown, ctx?: unknown) => unknown>();
  activate({ on: (name: string, handler: (e: unknown, c?: unknown) => unknown) => { handlers.set(name, handler); return () => {}; } } as never);
  const saved = process.env.SYD_PATH;
  process.env.SYD_PATH = engine;
  process.env.PI_SYDBOX_DIR = dir;
  try {
    await handlers.get("tool_call")?.({ toolName: "bash", input: { command: "echo hi" } }, { cwd: dir });
    assert.equal(existsSync(stateLayout(dir).projectGrants), false, "the confined tree preloads nothing by default");
  } finally {
    if (saved === undefined) delete process.env.SYD_PATH;
    else process.env.SYD_PATH = saved;
    delete process.env.PI_SYDBOX_DIR;
  }
});
