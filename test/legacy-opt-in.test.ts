import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import activate, { stateLayout } from "../src/index.ts";

/** The S2 opt-in case: see legacy-default-off.test.ts for why this is a file. */
test("PI_SYDBOX_IMPORT_LEGACY=1 imports the workspace legacy store once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sydbox-leg-"));
  const engine = join(dir, "syd");
  writeFileSync(engine, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const legacy = join(dir, "agent_dir", ".sydbox");
  mkdirSync(legacy, { recursive: true });
  const rule = "allow/lpath,npath,rpath+/etc/passwd";
  writeFileSync(join(legacy, "grants.json"), JSON.stringify([{ tier: "project", rule }]));

  const handlers = new Map<string, (event: unknown, ctx?: unknown) => unknown>();
  activate({ on: (name: string, handler: (e: unknown, c?: unknown) => unknown) => { handlers.set(name, handler); return () => {}; } } as never);
  const saved = { SYD_PATH: process.env.SYD_PATH };
  process.env.SYD_PATH = engine;
  process.env.PI_SYDBOX_DIR = dir;
  process.env.PI_SYDBOX_IMPORT_LEGACY = "1";
  try {
    await handlers.get("tool_call")?.({ toolName: "bash", input: { command: "echo hi" } }, { cwd: dir });
    const store = stateLayout(dir).projectGrants;
    assert.equal(existsSync(store), true, "the opt-in imports the legacy record");
    assert.match(readFileSync(store, "utf8"), /allow\/lpath,npath,rpath\+\/etc\/passwd/);
  } finally {
    if (saved.SYD_PATH === undefined) delete process.env.SYD_PATH;
    else process.env.SYD_PATH = saved.SYD_PATH;
    delete process.env.PI_SYDBOX_DIR;
    delete process.env.PI_SYDBOX_IMPORT_LEGACY;
  }
});
