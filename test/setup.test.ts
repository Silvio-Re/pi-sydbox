import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BAND_FLOOR, buildMachineLock, kernelBandFromRelease, machineLockDiff, setupCli } from "../src/setup.ts";

const repoLock = JSON.parse(readFileSync(new URL("../syd.lock", import.meta.url).pathname, "utf8")) as Record<string, unknown>;

test("the kernel band follows the landlock ABI 10 floor", () => {
  assert.equal(BAND_FLOOR.major, 7);
  assert.equal(BAND_FLOOR.minor, 2);
  assert.deepEqual(kernelBandFromRelease("6.8.0-151-generic"), { major: 6, minor: 8, band: "source" });
  assert.deepEqual(kernelBandFromRelease("7.2.0"), { major: 7, minor: 2, band: "release" });
  assert.deepEqual(kernelBandFromRelease("7.2.1-arch1-1"), { major: 7, minor: 2, band: "release" });
  assert.deepEqual(kernelBandFromRelease("7.10.0"), { major: 7, minor: 10, band: "release" });
  assert.deepEqual(kernelBandFromRelease("8.0.0"), { major: 8, minor: 0, band: "release" });
  // one below the floor on either side stays source: 7.1, 6.x
  assert.deepEqual(kernelBandFromRelease("7.1.9"), { major: 7, minor: 1, band: "source" });
  assert.equal(kernelBandFromRelease("totally-made-up"), null, "an unparseable release is not silently classified");
});

test("the machine lock is the repo lock plus local paths and the installed hash", () => {
  const machine = buildMachineLock(
    repoLock,
    { path: "/home/new/.local/opt/syd-3.59.0/syd", sha256: "a".repeat(64) },
    "2026-11-26T12:00:00.000Z",
  ) as { engine: { path: string; binary: { sha256: string } }; sourceBuild: { installedPath: string; binary: { sha256: string }; commit: string }; notes: string[] };
  // the installed source build lands in both places the extension's gate reads
  assert.equal(machine.engine.path, "/home/new/.local/opt/syd-3.59.0/syd");
  assert.equal(machine.engine.binary.sha256, "a".repeat(64));
  assert.equal(machine.sourceBuild.installedPath, "/home/new/.local/opt/syd-3.59.0/syd");
  assert.equal(machine.sourceBuild.binary.sha256, "a".repeat(64));
  // carried over verbatim from the repo lock: no second source of truth
  assert.equal(machine.sourceBuild.commit, (repoLock.sourceBuild as { commit: string }).commit);
  assert.ok(machine.notes.length > (repoLock.notes as string[]).length, "the generation note is appended");
});

test("the sourceBuild block is left alone when the release artifact was installed", () => {
  const machine = buildMachineLock(
    repoLock,
    { path: "/home/new/.local/opt/syd-3.60.0/syd", sha256: "b".repeat(64) },
    "2026-11-26T12:00:00.000Z",
  ) as { engine: { path: string }; sourceBuild: { installedPath: string } };
  assert.equal(machine.engine.path, "/home/new/.local/opt/syd-3.60.0/syd");
  const repoSource = (repoLock.sourceBuild as { installedPath: string }).installedPath;
  assert.equal(machine.sourceBuild.installedPath, repoSource, "a release install must not rewrite the source-build record");
});

test("the lock generator refuses junk instead of pinning garbage", () => {
  assert.throws(() => buildMachineLock(repoLock, { path: "", sha256: "a".repeat(64) }, "x"));
  assert.throws(() => buildMachineLock(repoLock, { path: "/e/syd", sha256: "nothex" }, "x"));
  assert.throws(() => buildMachineLock("not-an-object", { path: "/e/syd", sha256: "a".repeat(64) }, "x"));
});

test("machineLockDiff names exactly the fields a copy plus local paths changes", () => {
  const machine = buildMachineLock(
    repoLock,
    { path: "/home/new/.local/opt/syd-3.59.0/syd", sha256: "c".repeat(64) },
    "2026-11-26T12:00:00.000Z",
  );
  const diff = machineLockDiff(repoLock, machine);
  assert.ok(diff.some((line) => line.startsWith("engine.path:")), "engine.path is reported");
  assert.ok(diff.some((line) => line.startsWith("engine.binary.sha256:")), "the installed hash is reported");
  assert.ok(diff.some((line) => line.startsWith("notes: +")), "the generation note is reported");
  const identical = machineLockDiff(repoLock, JSON.parse(JSON.stringify(repoLock)));
  assert.deepEqual(identical, [], "an unmodified copy reports no differences");
});

test("the write-lock CLI writes an atomic, parseable lock from a real engine file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sydbox-setup-"));
  try {
    const engine = join(dir, "syd");
    writeFileSync(engine, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const out = join(dir, "syd.lock");
    const status = setupCli(["write-lock", "--repo-lock", new URL("../syd.lock", import.meta.url).pathname, "--engine", engine, "--out", out], { HOME: dir });
    assert.equal(status, 0);
    assert.ok(existsSync(out), "the machine lock was written");
    const written = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(written.engine.path, engine);
    assert.equal(written.engine.binary.sha256, createHash("sha256").update(readFileSync(engine)).digest("hex"));
    assert.equal(setupCli(["band", "--release", "6.8.0"], { HOME: dir }), 0);
    assert.equal(setupCli(["band", "--release", "nonsense"], { HOME: dir }), 2, "an unclassifiable kernel is a stop, not a guess");
    assert.equal(setupCli(["write-lock", "--engine", join(dir, "missing")], { HOME: dir }), 2);
    assert.equal(setupCli([], { HOME: dir }), 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
