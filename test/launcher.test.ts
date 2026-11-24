import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildLaunch, buildSelfCheck, placeProfile, writeProfile, fsAllowFor, LaunchError } from "../src/launcher.ts";
import { PolicyError, compileProfile } from "../src/compiler.ts";

const profilePath = "/home/u/.cache/sydbox/sydbox.profile";
const ok = {
  sydPath: "/home/u/.local/opt/syd-3.60.0/syd",
  profile: "lock:on\ndeny/read+/tmp/x",
  profilePath,
  variant: "A" as const,
};

test("builds syd -P profile -- command argv", () => {
  const plan = buildLaunch(["sh", "-c", "echo hi"], ok);
  assert.deepEqual(plan.command, [ok.sydPath, "-P", profilePath, "--", "sh", "-c", "echo hi"]);
});

test("refuses a relative engine path (invariant 7: no PATH lookup)", () => {
  assert.throws(() => buildLaunch(["true"], { ...ok, sydPath: "syd" }), LaunchError);
});

test("refuses an empty command", () => {
  assert.throws(() => buildLaunch([], ok), LaunchError);
});

test("refuses a log fd below 3 so it cannot clobber stdout/stderr", () => {
  assert.throws(() => buildLaunch(["true"], { ...ok, logFd: 2 }), LaunchError);
});

test("refuses a profile that violates the namespace variant", () => {
  assert.throws(() => buildLaunch(["true"], { ...ok, profile: "unshare/user:1" }), PolicyError);
});

test("puts -P PATH right after the engine, before --", () => {
  const plan = buildLaunch(["true"], ok);
  assert.equal(plan.command[0], ok.sydPath);
  assert.equal(plan.command[1], "-P");
  assert.equal(plan.command[2], profilePath);
  assert.equal(plan.command.indexOf("--"), 3);
});

test("places engine flags between the profile and --", () => {
  const plan = buildLaunch(["true"], { ...ok, flags: ["-poff"] });
  assert.deepEqual(plan.command, [ok.sydPath, "-P", profilePath, "-poff", "--", "true"]);
  assert.throws(() => buildLaunch(["true"], { ...ok, flags: ["poff"] }), LaunchError);
});

test("refuses profile text without a path, and a relative profile path", () => {
  const unpathed = { sydPath: ok.sydPath, profile: ok.profile, variant: ok.variant };
  assert.throws(() => buildLaunch(["true"], unpathed), LaunchError);
  assert.throws(() => buildLaunch(["true"], { ...ok, profilePath: "sydbox.profile" }), LaunchError);
});

test("wires SYD_LOG_FD and reserves the descriptor in stdio", () => {
  const plan = buildLaunch(["true"], { ...ok, logFd: 4 });
  assert.equal(plan.env.SYD_LOG_FD, "4");
  assert.equal(plan.stdio.length, 5);
  assert.deepEqual(plan.stdio[4], { from: "log" });
  assert.equal(plan.stdio[3], "ignore");
});

test("drops an inherited SYD_LOG_FD when no log fd is given", () => {
  const saved = process.env.SYD_LOG_FD;
  process.env.SYD_LOG_FD = "9";
  try {
    const plan = buildLaunch(["true"], ok);
    assert.equal(plan.env.SYD_LOG_FD, undefined);
    assert.deepEqual(plan.stdio, ["inherit", "inherit", "inherit"]);
  } finally {
    if (saved === undefined) delete process.env.SYD_LOG_FD;
    else process.env.SYD_LOG_FD = saved;
  }
});

test("builds the engine self check argv", () => {
  assert.deepEqual(buildSelfCheck("/opt/syd/syd"), ["/opt/syd/syd", "--check"]);
  assert.throws(() => buildSelfCheck("syd"), LaunchError);
});

test("writes the profile 0600 through a same-directory rename", () => {
  const dir = mkdtempSync(join(tmpdir(), "sydbox-"));
  const path = writeProfile(dir, ok.profile);
  assert.equal(readFileSync(path, "utf8"), ok.profile);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  // syd also refuses a profile whose parent is group/world-writable (EPERM at
  // startup, sandbox.rs:10699), so the directory mode is part of the contract.
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  // syd refuses any other extension with rc=95 (docs/environment.md).
  assert.ok(path.endsWith(".syd-3"), `profile path must end in .syd-3, got ${path}`);
  assert.throws(() => writeProfile(dir, ""), LaunchError);
  assert.throws(() => writeProfile("relative/dir", ok.profile), LaunchError);
});

test("a pre-existing group-writable profile directory is tightened", () => {
  const dir = mkdtempSync(join(tmpdir(), "sydbox-"));
  chmodSync(dir, 0o775);
  const path = writeProfile(dir, ok.profile);
  assert.equal(statSync(dir).mode & 0o777, 0o700, "mkdir mode does not apply to an existing directory");
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("removes its temp file when the rename fails", () => {
  const dir = mkdtempSync(join(tmpdir(), "sydbox-"));
  // A directory at the target path makes rename fail after the temp file exists.
  mkdirSync(join(dir, "sydbox.syd-3"));
  assert.throws(() => writeProfile(dir, ok.profile));
  assert.deepEqual(readdirSync(dir).filter((name: string) => name.endsWith(".tmp")), []);
});

test("placeProfile keeps the profile in the work directory when that works", () => {
  const dir = mkdtempSync(join(tmpdir(), "sydbox-")); // 0700 from mkdtemp
  const placed = placeProfile(join(dir, "profiles"), join(dir, "cache"), ok.profile);
  assert.equal(placed.dir, join(dir, "profiles"));
  assert.equal(placed.relocated, undefined);
  assert.ok(placed.path.startsWith(join(dir, "profiles")), placed.path);
  assert.equal(statSync(placed.path).mode & 0o777, 0o600);
});

test("placeProfile relocates when the work directory cannot hold a private profile", () => {
  // A shared-folder mount keeps 0770 after chmod; a read-only parent has the
  // same effect on any filesystem: no private directory can be created there.
  const root = mkdtempSync(join(tmpdir(), "sydbox-ro-"));
  const locked = join(root, "locked");
  mkdirSync(locked);
  chmodSync(locked, 0o500);
  const cache = join(root, "cache");
  try {
    const placed = placeProfile(join(locked, "profiles"), cache, ok.profile);
    assert.ok(placed.relocated !== undefined, "the preferred directory must be abandoned");
    assert.ok(placed.path.startsWith(cache), placed.path);
    assert.equal(statSync(placed.path).mode & 0o777, 0o600);
    // Stable per work directory: two sessions must not overwrite each other, and
    // a restart must find the same file rather than leaking a new one per session.
    assert.equal(placeProfile(join(locked, "profiles"), cache, ok.profile).path, placed.path);
  } finally {
    chmodSync(locked, 0o700);
  }
});

test("placeProfile fails closed when no candidate directory can be private", () => {
  const root = mkdtempSync(join(tmpdir(), "sydbox-ro-"));
  const locked = join(root, "locked");
  mkdirSync(locked);
  chmodSync(locked, 0o500);
  try {
    assert.throws(() => placeProfile(join(locked, "a"), join(locked, "b"), ok.profile), LaunchError);
  } finally {
    chmodSync(locked, 0o700);
  }
  // Both candidates under a read-only parent: same fail-closed path, no mkdir of a
  // path outside the test root (the real sandbox traps that as a write denial).
  chmodSync(root, 0o500);
  try {
    assert.throws(() => placeProfile(join(root, "x"), join(root, "y"), ok.profile), LaunchError);
  } finally {
    chmodSync(root, 0o700);
  }
});

test("fsAllowFor emits one allow/fs line per distinct magic, deduplicating", () => {
  const probe = (path: string): bigint | null => (path === "/media/sf_doc/probe" ? 0x786f4256n : 0xef53n);
  assert.deepEqual(fsAllowFor(["/media/sf_doc/probe", "/media/sf_doc/probe/sub", "/home/u"], probe), [
    "allow/fs+0x786f4256",
  ]);
});

test("fsAllowFor drops the ext magic (include_profile already allows it) and skips unstatable paths", () => {
  assert.deepEqual(fsAllowFor(["/home/u/extwork"], () => 0xef53n), []);
  assert.deepEqual(fsAllowFor(["/nowhere"], () => null), []);
  assert.deepEqual(fsAllowFor(["rel/path"], () => 0x0n), []);
});

test("fsAllowFor climbs to the nearest existing ancestor for a path that does not exist yet", () => {
  // The climb is in the default probe (fsMagicOf), so exercise it for real:
  // tmpdir() always exists, the leaf never does; on an ext-family tmpdir the
  // line is dropped by design, on any other fstype the magic must be emitted.
  const lines = fsAllowFor([join(tmpdir(), "pi-sydbox-no-such-leaf/a/b")]);
  for (const line of lines) assert.match(line, /^allow\/fs\+0x[0-9a-f]+$/);
});

test("fsAllowFor lines ride extraAllows and never follow a deny of a compiled profile", () => {
  const policy = {
    filesystem: {
      allowWrite: ["/media/sf_doc/probe"],
      denyReadAlways: ["/media/sf_doc/probe/secret.txt"],
    },
  };
  const fsAllows = fsAllowFor(["/media/sf_doc/probe"], () => 0x786f4256n);
  const profile = compileProfile(policy, "A", fsAllows);
  const fsIdx = profile.indexOf("allow/fs+0x786f4256");
  const denyIdx = profile.indexOf("deny/");
  assert.ok(fsIdx > -1, "fs allow line missing");
  assert.ok(
    profile.includes("allow/lpath,npath,rpath,wpath,cpath,tpath+/media/sf_doc/probe\n"),
    "path allow must be emitted for the write target",
  );
  assert.ok(denyIdx > fsIdx, "deny must come after the fs allow");
});


