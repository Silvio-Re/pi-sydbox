import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendGrant, GrantStoreError, MEMORY_TIERS, readGrants, rulesFor } from "../src/store.ts";

const store = () => join(mkdtempSync(join(tmpdir(), "sydbox-store-")), "grants.json");

test("a missing store reads as empty", () => {
  assert.deepEqual(readGrants(store()), []);
});

test("appending keeps the tier and the rule verbatim", () => {
  const file = store();
  appendGrant(file, "project", "allow/lpath,npath,rpath,exec+/usr/bin/true");
  const grants = readGrants(file);
  assert.equal(grants.length, 1);
  assert.equal(grants[0]?.tier, "project");
  assert.equal(grants[0]?.rule, "allow/lpath,npath,rpath,exec+/usr/bin/true");
  assert.match(grants[0]?.at ?? "", /^\d{4}-\d{2}-\d{2}T/);
});

test("once and session are memory-only: persisting them is refused", () => {
  const file = store();
  for (const tier of ["once", "session"] as const) {
    assert.throws(() => appendGrant(file, tier, "allow/lpath,npath,rpath+/etc/hosts"), GrantStoreError);
  }
  assert.ok(MEMORY_TIERS.has("once"));
  assert.ok(MEMORY_TIERS.has("session"));
  assert.throws(() => appendGrant(store(), "once" as never, "x"), GrantStoreError); // never persists, never a silent no-op
  assert.deepEqual(readGrants(file), [], "nothing was written by the refused calls");
});

test("the same grant is stored once, different tiers separately", () => {
  const file = store();
  const rule = "allow/lpath,npath,rpath+/etc/hosts";
  appendGrant(file, "project", rule);
  appendGrant(file, "project", rule);
  appendGrant(file, "global", rule);
  assert.equal(readGrants(file).length, 2);
  assert.deepEqual(rulesFor(readGrants(file), "global"), [rule]);
});

test("a rule that would break the profile is refused", () => {
  const file = store();
  assert.throws(() => appendGrant(file, "project", "allow/x+/a\nunshare/user:1"), GrantStoreError);
  assert.throws(() => appendGrant(file, "project", "   "), GrantStoreError);
  assert.throws(() => appendGrant(file, "forever" as never, "allow/x+/a"), GrantStoreError);
});

test("a corrupt store is reported, not silently reset", () => {
  const file = store();
  writeFileSync(file, "{not json");
  assert.throws(() => readGrants(file), SyntaxError);
  writeFileSync(file, JSON.stringify([{ rule: "allow/x+/a", at: "now" }]));
  assert.throws(() => readGrants(file), /unknown tier/);
});

test("a write leaves no temporary file behind", () => {
  const file = store();
  appendGrant(file, "project", "allow/lpath,npath,rpath+/tmp/x");
  const raw = readFileSync(file, "utf8");
  assert.doesNotMatch(raw, /tmp-\d+/);
  assert.equal(JSON.parse(raw).length, 1);
});
