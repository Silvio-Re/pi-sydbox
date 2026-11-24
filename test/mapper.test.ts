import { test } from "node:test";
import assert from "node:assert/strict";
import { recordToGrant } from "../src/mapper.ts";
import type { AnyRecord } from "../src/records.ts";

const base = { cap: "read", act: "deny" as const, sys: "open" };

test("a denied exec maps onto the rule the engine itself suggests", () => {
  // Captured from 3.59.0: tip "configure `allow/exec+/usr/bin/true'".
  const grant = recordToGrant({ ...base, cap: "exec", sys: "execve", kind: "path", path: "/usr/bin/true" }, "/work");
  assert.deepEqual((grant?.rule ?? "").split("\n"), [
    "allow/lpath,npath,rpath,exec+/usr/bin/true",
    "allow/lpath,npath,rpath,exec+/usr/bin/true/***",
  ]);
});

test("read and write caps widen to their category lists", () => {
  const read = recordToGrant({ ...base, kind: "path", path: "/etc/hosts" }, "/work");
  assert.equal(read?.rule.split("\n")[0], "allow/lpath,npath,rpath+/etc/hosts");
  const write = recordToGrant({ ...base, cap: "write", kind: "path", path: "/work/out" }, "/work");
  assert.equal(write?.rule.split("\n")[0], "allow/lpath,npath,rpath,wpath,cpath,tpath+/work/out");
});

test("a relative path is resolved against the project root", () => {
  const grant = recordToGrant({ ...base, kind: "path", path: "build/out.o" }, "/home/x/project/");
  assert.equal(grant?.rule.split("\n")[0], "allow/lpath,npath,rpath+/home/x/project/build/out.o");
});

test("a recursive path keeps the engine's recursion spelling", () => {
  const grant = recordToGrant({ ...base, kind: "path", path: "/data/**" }, "/work");
  assert.equal(grant?.rule, "allow/lpath,npath,rpath+/data/***");
});

test("network records grant the host and port the engine reported", () => {
  // A hand-written `host:port` entry converts to the engine spelling…
  const grant = recordToGrant({ ...base, cap: "connect", sys: "connect", kind: "net", addr: "10.0.0.1:443" }, "/work");
  assert.equal(grant?.rule, "allow/net/connect+10.0.0.1!443");
  // …but the engine's own recorded addr already is `host!port` and passes
  // through verbatim — a blanket `:`→`!` rewrite would corrupt IPv6.
  const captured = recordToGrant({ ...base, cap: "connect", sys: "connect", kind: "net", addr: "127.0.0.1!22" }, "/work");
  assert.equal(captured?.rule, "allow/net/connect+127.0.0.1!22");
  const v6 = recordToGrant({ ...base, cap: "connect", sys: "connect", kind: "net", addr: "::1!443" }, "/work");
  assert.equal(v6?.rule, "allow/net/connect+::1!443");
});

test("a dir record grants the subtree, a file record stays bare", () => {
  const dir = recordToGrant({ ...base, kind: "path", path: "/work/out", type: "dir" }, "/work");
  assert.equal(dir?.rule, "allow/lpath,npath,rpath+/work/out/***");
  const file = recordToGrant({ ...base, kind: "path", path: "/work/out/o.txt", type: "reg" }, "/work");
  assert.equal(file?.rule, "allow/lpath,npath,rpath+/work/out/o.txt");
});

test("an unrecognised cap stays denied instead of guessing", () => {
  assert.equal(recordToGrant({ ...base, cap: "ptrace", kind: "path", path: "/proc/1/mem" }, "/work"), null);
});

test("an allow record is not turned into a grant", () => {
  const allowed: AnyRecord = { ...base, act: "allow", kind: "path", path: "/tmp/x" };
  assert.equal(recordToGrant(allowed, "/work"), null);
});

test("a record with no target stays denied", () => {
  assert.equal(recordToGrant({ ...base, kind: "path", path: "" }, "/work"), null);
});
