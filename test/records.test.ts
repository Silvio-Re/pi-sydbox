import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  normalizeAct,
  parseLine,
  parseLog,
  parseRecord,
  SchemaDriftError,
  tryParseAccessLine,
} from "../src/records.ts";

// Documentation-shaped path denial, written before any record had been
// captured. The captured sample at the bottom of this file is the reference;
// this object only covers field shapes the docs describe.
const pathDenial = {
  id: "0f1d3de2-1d4b-4a3c-9c40-1a1f5f7a9b21",
  pid: 4242,
  time: "2026-01-01T00:00:00Z",
  level: "warn",
  cmd: "cat /home/user/.ssh/id_ed25519",
  cwd: "/home/user",
  uid: 1000,
  arch: "x86_64",
  args: ["/home/user/.ssh/id_ed25519"],
  ctx: "pid:4242",
  cap: "read",
  act: "deny",
  sys: "openat",
  path: "/home/user/.ssh/id_ed25519",
};

const minimal = {
  ctx: "pid:42",
  cap: "read",
  act: "deny",
  sys: "openat",
  path: "/home/user/.ssh/id_ed25519",
};

test("parses a real path-denial line and keeps its extra fields", () => {
  const record = parseLine(JSON.stringify(pathDenial));
  assert.equal(record.kind, "path");
  assert.equal(record.act, "deny");
  assert.equal(record.cap, "read");
  assert.equal(record.sys, "openat");
  assert.equal(record.pid, 4242);
  assert.equal(record.uid, 1000);
  assert.equal(record.arch, "x86_64");
  assert.equal(record.cmd, pathDenial.cmd);
  assert.equal(record.cwd, pathDenial.cwd);
  assert.equal(record.time, pathDenial.time);
  assert.deepEqual(record.args, pathDenial.args);
  if (record.kind !== "path") throw new Error("expected a path record");
  assert.equal(record.path, pathDenial.path);
  for (const key of ["id", "pid", "time", "level", "cmd", "cwd", "uid", "arch", "args"]) {
    assert.ok(key in record, `extra field ${key} must be accepted and carried`);
  }
});

test("normalizes a capitalized act", () => {
  assert.equal(normalizeAct("Deny"), "deny");
  const record = parseRecord({ ...minimal, act: "Deny" });
  assert.equal(record.act, "deny");
});

test("parses a network violation as a net record", () => {
  const line = JSON.stringify({
    ctx: "access",
    cap: "connect",
    act: "deny",
    sys: "connect",
    addr: "127.0.0.1!22",
  });
  const record = parseLine(line);
  assert.equal(record.kind, "net");
  if (record.kind !== "net") throw new Error("expected a net record");
  assert.equal(record.addr, "127.0.0.1!22");
  assert.equal(record.act, "deny");
});

test("skips informational lines and counts them", () => {
  const notice = '{"level":"info","msg":"listener started","time":"2026-01-01T00:00:00Z"}';
  assert.equal(tryParseAccessLine(notice), null);
  const log = [notice, JSON.stringify(minimal), "", "   "].join("\n");
  const result = parseLog(log);
  assert.equal(result.records.length, 1);
  assert.equal(result.skipped, 1);
  assert.equal(result.records[0]?.kind, "path");
});

test("reports an unknown field as drift in strict mode", () => {
  assert.throws(
    () => parseRecord({ ...minimal, newkey: "x" }, { strict: true }),
    (err: unknown) => {
      assert.ok(err instanceof SchemaDriftError);
      assert.match(err.message, /newkey/);
      return true;
    },
  );
});

test("collects an unknown field in lenient mode", () => {
  const record = parseRecord({ ...minimal, nsid: "syd-1" });
  assert.equal(record.kind, "path");
  assert.equal(record.act, "deny");
  assert.deepEqual(record.unknown, { nsid: "syd-1" });
});

test("rejects the same unknown field in strict mode", () => {
  assert.throws(
    () => parseRecord({ ...minimal, nsid: "syd-1" }, { strict: true }),
    (err: unknown) => {
      assert.ok(err instanceof SchemaDriftError);
      assert.match(err.message, /nsid/);
      assert.match(err.message, /schema drift, upgrade blocked/);
      return true;
    },
  );
});

test("leaves unknown undefined when every field is known", () => {
  const record = parseLine(JSON.stringify(pathDenial));
  assert.equal(record.unknown, undefined);
  assert.ok(!("unknown" in record), "unknown must be absent, not empty");
});

test("rejects each missing required field and a non-string cap", () => {
  for (const field of ["act", "cap", "sys"]) {
    const partial: Record<string, unknown> = { ...minimal };
    delete partial[field];
    assert.throws(() => parseRecord(partial), SchemaDriftError, `missing ${field} must throw`);
  }
  assert.throws(() => parseRecord({ ...minimal, cap: 42 }), SchemaDriftError);
});

test("rejects an unknown act", () => {
  assert.throws(() => parseRecord({ ...minimal, act: "reject" }), SchemaDriftError);
});

test("rejects an access record with neither path nor addr/unix", () => {
  assert.throws(
    () => parseRecord({ ctx: "pid:42", cap: "read", act: "deny", sys: "openat" }),
    SchemaDriftError,
  );
});

test("rejects non-JSON and empty lines", () => {
  assert.throws(() => parseLine("not json"), SchemaDriftError);
  assert.throws(() => parseLine("   "), SchemaDriftError);
  assert.throws(() => tryParseAccessLine("not json"), SchemaDriftError);
  assert.throws(() => tryParseAccessLine(""), SchemaDriftError);
});

// One captured line is worth more than any amount of documentation: it fixed
// err as a number and added hid/syd/tty to the field list. Strict mode is on
// here on purpose, so a field the engine emits and the allowlist lacks fails
// this test instead of silently landing in `unknown`.
test("parses the captured 3.59.0 access record in strict mode", () => {
  const line = readFileSync(
    new URL("./fixtures/syd-3.59.0-access-deny.jsonl", import.meta.url),
    "utf8",
  ).trim();
  const record = parseLine(line, { strict: true });
  assert.equal(record.act, "deny");
  assert.equal(record.cap, "exec");
  assert.equal(record.sys, "execve");
  assert.equal(record.err, 13);
  assert.equal(record.pid, 115236);
  assert.equal(record.uid, 1000);
  assert.equal(record.cwd, "/home/silvio/.pi/agent/npm");
  assert.equal(record.tip, "configure `allow/exec+/usr/bin/true'");
  assert.equal(record.unknown, undefined);
  assert.equal(record.kind, "path");
  if (record.kind === "path") assert.equal(record.path, "/usr/bin/true");
  assert.deepEqual(record.args, [
    136037204963136, 136037205084192, 140734405496280, 18446744073709551615, 136037205084200, 136037204962256,
  ]);
});
