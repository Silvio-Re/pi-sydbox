import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { recordToGrant } from "../src/mapper.ts";
import { compileProfile, netRule } from "../src/compiler.ts";
import { parseLog } from "../src/records.ts";
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

// External review 2, H2: unknown-to-the-table caps previously produced a null
// grant — unpromptable, silently — for denial shapes the engine demonstrably
// emits. Every rule below must match the engine's own tip spelling.
test("mkdir and rmdir denials map onto their tip's singular rule", () => {
  // Captured: tip "configure `allow/mkdir+/tmp/.../targetdir/new'".
  const mkdir = recordToGrant({ ...base, cap: "mkdir", sys: "mkdir", kind: "path", path: "/tmp/agent/targetdir/new" }, "/work");
  assert.equal(mkdir?.rule, "allow/mkdir+/tmp/agent/targetdir/new");
  const rmdir = recordToGrant({ ...base, cap: "rmdir", sys: "rmdir", kind: "path", path: "/tmp/agent/targetdir" }, "/work");
  assert.equal(rmdir?.rule, "allow/rmdir+/tmp/agent/targetdir");
});

test("an ioctl denial maps onto its ctl group rule, tip-faithful", () => {
  // Captured: tip "configure `allow/ioctl+TCGETS'".
  const grant = recordToGrant({ ...base, cap: "ioctl", sys: "ioctl", kind: "ctl", ctl: ["TCGETS"] }, "/work");
  assert.equal(grant?.rule, "allow/ioctl+TCGETS");
});

test("a compound cap maps onto the union of its categories; an unknown component still nulls", () => {
  // Captured: "cap":["read","write"] on /dev/tty (type chr), tip `allow/read,write+…`.
  const grant = recordToGrant({ ...base, cap: "read,write", sys: "openat", kind: "path", path: "/dev/tty", type: "chr" }, "/work");
  assert.equal(grant?.rule, "allow/lpath,npath,rpath,readdir,wpath,cpath,tpath,fattr+/dev/tty\nallow/lpath,npath,rpath,readdir,wpath,cpath,tpath,fattr+/dev/tty/***");
  const unknown = recordToGrant({ ...base, cap: "read,banana", sys: "openat", kind: "path", path: "/dev/tty" }, "/work");
  assert.equal(unknown, null, "an unknown cap component keeps the record denied");
});

test("the captured net-deny fixture maps every record to a grantable rule (H2)", () => {
  const text = readFileSync(new URL("./fixtures/capture/net-deny-3.59.0.jsonl", import.meta.url), "utf8");
  const { records } = parseLog(text);
  const grants = records.map((r) => recordToGrant(r, "/work"));
  assert.ok(grants.every((g) => g !== null), "no captured denial may be unmappable");
  assert.equal(grants[1]?.rule, "allow/ioctl+TCGETS");
  assert.equal(grants[4]?.rule, "allow/net/connect+tcp!127.0.0.1!59999");
});

test("the captured mkdir/rmdir fixture maps tip-faithful too (H2)", () => {
  const text = readFileSync(new URL("./fixtures/capture/denies-3.59.0.jsonl", import.meta.url), "utf8");
  const { records } = parseLog(text);
  const mkdirRec = records.find((r) => r.cap === "mkdir");
  const rmdirRec = records.find((r) => r.cap === "rmdir");
  if (mkdirRec === undefined || rmdirRec === undefined || mkdirRec.kind !== "path" || rmdirRec.kind !== "path") {
    assert.fail("expected mkdir and rmdir path records");
    return;
  }
  const mkdirGrant = recordToGrant(mkdirRec, "/work");
  const rmdirGrant = recordToGrant(rmdirRec, "/work");
  assert.equal(mkdirGrant?.rule, "allow/mkdir+/tmp/sydbox-probe-21.jaNe5H/targetdir/new");
  assert.equal(rmdirGrant?.rule, "allow/rmdir+/tmp/sydbox-probe-21.jaNe5H/targetdir");
});

test("all-glob denial paths never become grants (P0 empty-glob guard)", () => {
  // `/`, `/*`, `/**`, `/***` all collapse the target to empty or root; a grant
  // would be a blanket allow hiding behind a local-looking denial.
  for (const path of ["/", "/*", "/**", "/***", "/*/*/**"]) {
    if (path === "/*/*/**") continue; // a nested glob keeps a real base
    assert.equal(recordToGrant({ ...base, kind: "path", path }, "/work"), null, `path ${path}`);
  }
  assert.notEqual(recordToGrant({ ...base, kind: "path", path: "/*/*/**" }, "/work"), null, "a nested glob is not a collapsed one");
});

test("a target smuggling a line break is refused, not compiled (P0 untrusted content)", () => {
  const inject = "/safe/file\nallow/lpath,npath,rpath,readdir+/etc";
  assert.equal(recordToGrant({ ...base, kind: "path", path: inject }, "/work"), null);
  assert.equal(
    recordToGrant({ ...base, cap: "connect", sys: "connect", kind: "net", addr: "evil\nallow/net/connect+10.0.0.1!53" }, "/work"),
    null,
    "a net addr is workload-chosen too",
  );
  assert.equal(recordToGrant({ ...base, cap: "ioctl", sys: "ioctl", kind: "ctl", ctl: ["TCGETS\nallow/ioctl+WHAT"] }, "/work"), null);
  // Sanity: the same shapes without the line break still grant.
  assert.notEqual(recordToGrant({ ...base, kind: "path", path: "/safe/file" }, "/work"), null);
  assert.notEqual(recordToGrant({ ...base, cap: "ioctl", sys: "ioctl", kind: "ctl", ctl: ["TCGETS"] }, "/work"), null);
});
