import { test } from "node:test";
import assert from "node:assert/strict";
import { recordToGrant } from "../src/mapper.ts";
import { compileProfile, netRule } from "../src/compiler.ts";
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
  assert.equal(read?.rule.split("\n")[0], "allow/lpath,npath,rpath,readdir+/etc/hosts");
  const write = recordToGrant({ ...base, cap: "write", kind: "path", path: "/work/out" }, "/work");
  assert.equal(write?.rule.split("\n")[0], "allow/lpath,npath,rpath,readdir,wpath,cpath,tpath,fattr+/work/out");
});

test("a relative path is resolved against the project root", () => {
  const grant = recordToGrant({ ...base, kind: "path", path: "build/out.o" }, "/home/x/project/");
  assert.equal(grant?.rule.split("\n")[0], "allow/lpath,npath,rpath,readdir+/home/x/project/build/out.o");
});

test("a recursive path keeps the engine's recursion spelling", () => {
  const grant = recordToGrant({ ...base, kind: "path", path: "/data/**" }, "/work");
  assert.equal(grant?.rule, "allow/lpath,npath,rpath,readdir+/data/***");
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
  assert.equal(dir?.rule, "allow/lpath,npath,rpath,readdir+/work/out/***");
  const file = recordToGrant({ ...base, kind: "path", path: "/work/out/o.txt", type: "reg" }, "/work");
  assert.equal(file?.rule, "allow/lpath,npath,rpath,readdir+/work/out/o.txt");
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

test("network policy entries and captured addrs share one truth table (C3)", () => {
  // The compiler used to take the last colon of every entry, corrupting a
  // bare IPv6 literal into `:!1`.
  assert.equal(netRule("::1"), "allow/net/connect+::1");
  assert.equal(netRule("example.com:443"), "allow/net/connect+example.com!443");
  assert.equal(netRule("[::1]:443"), "allow/net/connect+[::1]!443");
  assert.equal(netRule("example.com!443"), "allow/net/connect+example.com!443");
  assert.equal(netRule("/run/dbus/system_bus_socket"), "allow/net/connect+/run/dbus/system_bus_socket");
  // Captured engine addrs already carry the bang form and stay verbatim.
  const v6 = recordToGrant({ ...base, kind: "net", addr: "::1!443" }, "/work");
  assert.equal(v6?.rule, "allow/net/connect+::1!443");
});

test("readdir and fattr caps map to their category lists (C4)", () => {
  const ls = recordToGrant({ ...base, cap: "readdir", kind: "path", path: "/work/out", type: "dir" }, "/work");
  assert.equal(ls?.rule, "allow/lpath,npath,rpath,readdir+/work/out/***");
  const chmod = recordToGrant({ ...base, cap: "fattr", kind: "path", path: "/work/out/o.txt", type: "reg" }, "/work");
  assert.equal(chmod?.rule, "allow/lpath,npath,rpath,readdir,wpath,cpath,tpath,fattr+/work/out/o.txt");
});

test("one netRule table for policy and records: compiler output is exact per shape (C3)", () => {
  const cases: ReadonlyArray<[string, string]> = [
    ["::1", "allow/net/connect+::1"],
    ["::", "allow/net/connect+::"],
    ["example.com:443", "allow/net/connect+example.com!443"],
    ["[::1]:443", "allow/net/connect+[::1]!443"],
    ["example.com!443", "allow/net/connect+example.com!443"],
    ["/run/x.sock", "allow/net/connect+/run/x.sock"],
  ];
  for (const [entry, want] of cases) {
    const profile = compileProfile({ network: { allow: [entry] } }, "A");
    assert.ok(profile.includes(`\n${want}\n`), `${entry} -> ${want}\n${profile}`);
  }
});
