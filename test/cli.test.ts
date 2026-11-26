import { test } from "node:test";
import assert from "node:assert/strict";
import { appendGrant, readGrants } from "../src/store.ts";
import { stateLayout } from "../src/index.ts";
import { effectiveProfile, listGrants, revokeByIndex, runCli, type CliEnv } from "../src/cli.ts";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A CLI environment with a throwaway state root and a captured sink. */
function env(dir: string, project: string): { cliEnv: CliEnv; lines: string[] } {
  const lines: string[] = [];
  return {
    cliEnv: {
      cwd: project,
      env: { PI_SYDBOX_DIR: dir, HOME: dir },
      write: (line) => lines.push(line),
    },
    lines,
  };
}

function tempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "sydbox-cli-"));
  return join(dir, "project");
}

test("list reads the same store the extension writes (project and global)", () => {
  const project = tempProject();
  try {
    const layout = stateLayout(project, { PI_SYDBOX_DIR: project, HOME: project });
    appendGrant(layout.projectGrants, "project", "allow/rpath+/work/project/ok");
    appendGrant(layout.globalGrants, "global", "allow/lpath,npath,rpath+***/public");
    const { cliEnv, lines } = env(project, project);
    const outcome = runCli(["list"], cliEnv);
    assert.equal(outcome.status, 0);
    assert.match(lines.join("\n"), /1\s+project\s+allow\/rpath\+\/work\/project\/ok/);
    const globalView = runCli(["list", "--global"], cliEnv);
    assert.equal(globalView.status, 0);
    assert.match(globalView.lines.join("\n"), /global.*allow\/lpath,npath,rpath\+\*\*\*\/public/);
    // the store the CLI read is byte-identical to the one the extension reads
    assert.deepEqual(listGrants("project", project, cliEnv.env).map((g) => g.rule), readGrants(layout.projectGrants).map((g) => g.rule));
  } finally {
    rmSync(join(project, ".."), { recursive: true, force: true });
  }
});

test("revoke removes exactly one grant and reports a bad index", () => {
  const project = tempProject();
  try {
    const layout = stateLayout(project, { PI_SYDBOX_DIR: project, HOME: project });
    appendGrant(layout.projectGrants, "project", "allow/rpath+/a");
    appendGrant(layout.projectGrants, "project", "allow/rpath+/b");
    const { cliEnv, lines } = env(project, project);
    const outcome = runCli(["revoke", "1"], cliEnv);
    assert.equal(outcome.status, 0);
    assert.match(lines.join("\n"), /revoked \(project\) allow\/rpath\+\/a/);
    assert.deepEqual(readGrants(layout.projectGrants).map((g) => g.rule), ["allow/rpath+/b"]);
    assert.equal(revokeByIndex("project", project, cliEnv.env, 9), null, "an out-of-range index revokes nothing");
    const bad = runCli(["revoke", "9"], cliEnv);
    assert.equal(bad.status, 2);
    assert.match(bad.lines.join("\n"), /no grant at index 9/);
  } finally {
    rmSync(join(project, ".."), { recursive: true, force: true });
  }
});

test("effective-policy compiles the approved policy plus stored grants and the standing denies", () => {
  const project = tempProject();
  try {
    const layout = stateLayout(project, { PI_SYDBOX_DIR: project, HOME: project });
    mkdirSync(layout.stateDir, { recursive: true });
    writeFileSync(join(layout.stateDir, "policy.json"), JSON.stringify({ filesystem: { allowRead: ["/work"], denyReadAlways: ["/work/secret"] } }));
    appendGrant(layout.projectGrants, "project", "allow/rpath+/work/ok");
    appendGrant(layout.globalGrants, "global", "allow/lpath,npath,rpath+***/public");
    const { cliEnv, lines } = env(project, project);
    const outcome = runCli(["effective-policy"], cliEnv);
    assert.equal(outcome.status, 0);
    const text = lines.join("\n");
    assert.match(text, /policy: .*policy\.json/, "the adopted policy is named");
    assert.match(text, /allow\/rpath\+\/work\/ok/, "project grants appear");
    assert.match(text, /allow\/lpath,npath,rpath\+\*\*\*\/public/, "global grants appear");
    assert.match(text, /deny\/lpath,npath,rpath,readdir\+\/work\/secret/, "the sandbox.json deny compiles in (reads use READ_CATS)");
    assert.match(text, new RegExp(layout.stateRoot.replaceAll(".", "\\.")), "the standing self-protection denies cover the state root");
    const { profile } = effectiveProfile(project, cliEnv.env);
    assert.match(profile, /allow\/rpath\+\/work\/ok/, "the returned profile carries the grants");
    // no policy adopted: still a compile, everything outside the defaults denied
    const bare = effectiveProfile(join(project, "other"), cliEnv.env);
    assert.match(bare.profile, /deny\//, "an empty policy still compiles with the standing denies");
  } finally {
    rmSync(join(project, ".."), { recursive: true, force: true });
  }
});

test("usage and unknown commands", () => {
  const project = tempProject();
  try {
    const { cliEnv } = env(project, project);
    const help = runCli(["help"], cliEnv);
    assert.equal(help.status, 0);
    assert.match(help.lines.join("\n"), /usage: sydbox list/);
    assert.equal(runCli(["nonsense"], cliEnv).status, 2);
    assert.equal(runCli(["revoke"], cliEnv).status, 2, "revoke without an index is a usage error");
  } finally {
    rmSync(join(project, ".."), { recursive: true, force: true });
  }
});
