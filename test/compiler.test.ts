import { test } from "node:test";
import assert from "node:assert/strict";
import { assertNamespaceInvariant, namespaceViolations, PolicyError, compileProfile, toSydGlobs } from "../src/compiler.ts";

test("variant A rejects any unshare rule", () => {
  const profile = "lock:on\nunshare/mount:1\ndeny/read+/tmp/x";
  assert.deepEqual(namespaceViolations(profile, "A"), ["unshare/mount:1"]);
  assert.throws(() => assertNamespaceInvariant(profile, "A"), PolicyError);
});

test("variant A rejects bind rules because they need a mount namespace", () => {
  const profile = "lock:on\nbind+/etc:/etc:ro,nodev\n";
  assert.throws(() => assertNamespaceInvariant(profile, "A"), /bind rule/);
});

test("variant A accepts a clean landlock+seccomp profile", () => {
  const profile = "lock:on\ndeny/read,stat,write+/tmp/secret\nallow/net/connect+any!443\n";
  assert.deepEqual(namespaceViolations(profile, "A"), []);
  assert.doesNotThrow(() => assertNamespaceInvariant(profile, "A"));
});

test("variant B permits a mount namespace", () => {
  assert.doesNotThrow(() => assertNamespaceInvariant("unshare/mount:1\nlock:on", "B"));
});

test("variant B still rejects the user namespace, alone or in a list", () => {
  assert.throws(() => assertNamespaceInvariant("unshare/user:1", "B"), PolicyError);
  assert.throws(() => assertNamespaceInvariant("unshare/mount,user,pid:1", "B"), /user/);
});

test("compileProfile emits the verified engine shape", () => {
  const profile = compileProfile({}, "A");
  const lines = profile.trimEnd().split("\n");
  assert.deepEqual(lines, ["include_profile linux", "sandbox/lock:off"]);
  // The generated text must survive the invariant the launcher enforces.
  assert.doesNotThrow(() => assertNamespaceInvariant(profile, "A"));
});

test("compileProfile puts denies last so they win", () => {
  const profile = compileProfile(
    { filesystem: { allowWrite: ["/work"], denyReadAlways: ["/work/secret"] } },
    "A",
  );
  const lines = profile.trimEnd().split("\n");
  const lastAllow = lines.findLastIndex((l) => l.startsWith("allow/"));
  const deny = lines.findIndex((l) => l.startsWith("deny/"));
  assert.ok(lastAllow < deny, `deny must follow every allow:\n${profile}`);
  assert.ok(lines.includes("deny/lpath,npath,rpath+/work/secret/***"), `deny must cover the subtree:\n${profile}`);
});

test("compileProfile maps each policy field onto the engine vocabulary", () => {
  const profile = compileProfile(
    {
      shell: { readAccess: "host" },
      network: { enabled: true, allow: ["example.com:443", "localhost"] },
      filesystem: {
        allowRead: ["/data/**"],
        allowWrite: ["/work"],
        denyRead: ["/home/x/.ssh"],
        denyWrite: ["/work/locked"],
      },
    },
    "A",
  );
  assert.match(profile, /^allow\/lpath,npath,rpath\+\/\*\*\*$/m);
  assert.match(profile, /^allow\/lpath,npath,rpath\+\/data\/\*\*\*$/m);
  assert.match(profile, /^allow\/lpath,npath,rpath,wpath,cpath,tpath\+\/work\/\*\*\*$/m);
  assert.match(profile, /^allow\/lpath,npath,rpath,exec\+\/work\/\*\*\*$/m);
  assert.match(profile, /^allow\/net\/connect\+example\.com!443$/m);
  assert.match(profile, /^allow\/net\/connect\+localhost$/m);
  assert.match(profile, /^deny\/lpath,npath,rpath\+\/home\/x\/\.ssh\/\*\*\*$/m);
  assert.match(profile, /^deny\/lpath,npath,rpath,wpath,cpath,tpath\+\/work\/locked\/\*\*\*$/m);
});

test("a disabled sandbox turns the engine off rather than emitting nothing", () => {
  assert.equal(compileProfile({ enabled: false }, "A"), "include_profile off\n");
});

test("network is not granted when disabled, even with an allow list", () => {
  const profile = compileProfile({ network: { enabled: false, allow: ["example.com:443"] } }, "A");
  assert.doesNotMatch(profile, /net\/connect/);
});

test("a stored grant lands before the denies, never after them", () => {
  const profile = compileProfile(
    { filesystem: { denyReadAlways: ["/work/secret"] } },
    "A",
    ["allow/lpath,npath,rpath,exec+/usr/bin/true"],
  );
  const lines = profile.trimEnd().split("\n");
  const grant = lines.indexOf("allow/lpath,npath,rpath,exec+/usr/bin/true");
  const deny = lines.findIndex((l) => l.startsWith("deny/"));
  assert.ok(grant >= 0, `grant missing:\n${profile}`);
  assert.ok(grant < deny, `grant must precede the deny block:\n${profile}`);
});

test("a stored grant cannot smuggle a denial or a second line", () => {
  assert.throws(() => compileProfile({}, "A", ["deny/lpath,npath,rpath+/etc"]), PolicyError);
  assert.throws(() => compileProfile({}, "A", ["allow/x+/a\nallow/y+/b"]), PolicyError);
});

test("toSydGlobs covers both object and subtree spellings", () => {
  assert.deepEqual(toSydGlobs("/data/**"), ["/data", "/data/***"]);
  assert.deepEqual(toSydGlobs("/data"), ["/data", "/data/***"], "the kind of a policy path is unknown");
  assert.deepEqual(toSydGlobs("/data/"), ["/data", "/data/***"]);
  assert.deepEqual(toSydGlobs("/data/***"), ["/data", "/data/***"], "already explicit, unchanged");
  assert.deepEqual(toSydGlobs("/"), ["/***"]);
  assert.throws(() => toSydGlobs("relative/path"), PolicyError);
});

test("relative policy paths are refused rather than silently compiled", () => {
  assert.throws(() => compileProfile({ filesystem: { denyRead: ["secrets"] } }, "A"), PolicyError);
});
