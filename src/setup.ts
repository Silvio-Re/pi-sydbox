/**
 * Machine-setup helpers (roadmap P3, item 1): kernel-band detection and
 * machine-lock provisioning, as pure functions so the suite can test them
 * without an engine, plus a tiny CLI the bash orchestrator
 * (tools/setup/setup.sh, wrapped by `make setup`) calls into:
 *
 *   node --experimental-strip-types src/setup.ts band --release "$(uname -r)"
 *   node --experimental-strip-types src/setup.ts write-lock \
 *     --repo-lock syd.lock --engine ~/.local/opt/syd-3.59.0/syd [--out DIR]
 *
 * The band rule is docs/environment.md's "Engine, two paths": Linux >= 7.2
 * (landlock ABI 10) runs the 3.60.0 signed release; anything older must use
 * the 3.59.0 source build, because 3.60.0 refuses to start below 7.2.
 *
 * The machine lock is a copy of the repository syd.lock with the LOCAL
 * engine path and the sha256 of the binary that was ACTUALLY installed; the
 * extension's gate (src/index.ts gateEngine) then refuses every other
 * engine, including one swapped in under a known name.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** The kernel band floor: the first major.minor with landlock ABI 10. */
export const BAND_FLOOR = { major: 7, minor: 2 } as const;

export type KernelBand = "release" | "source";

export interface KernelBandInfo {
  major: number;
  minor: number;
  /** release: >= 7.2 (signed tarball); source: anything older (source build). */
  band: KernelBand;
}

/**
 * Parses a `uname -r` release string ("6.8.0-151-generic", "7.2.0-arch1-1").
 * Returns null for anything that does not start major.minor: a machine whose
 * kernel we cannot parse gets the SOURCE band question printed for a human,
 * never a silent default either way.
 */
export function kernelBandFromRelease(release: string): KernelBandInfo | null {
  const match = /^(\d+)\.(\d+)(?:\.|$)/.exec(release.trim());
  if (match === null) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major > BAND_FLOOR.major) return { major, minor, band: "release" };
  if (major === BAND_FLOOR.major && minor >= BAND_FLOOR.minor) return { major, minor, band: "release" };
  return { major, minor, band: "source" };
}

interface LockShape {
  version?: unknown;
  engine?: { path?: unknown; binary?: { sha256?: unknown } };
  sourceBuild?: { version?: unknown; installedPath?: unknown; binary?: { sha256?: unknown } };
  hosts?: unknown;
  notes?: unknown;
}

function asLock(value: unknown): LockShape {
  if (typeof value !== "object" || value === null) throw new Error("lock is not a JSON object");
  return value as LockShape;
}

export interface MachineLockInput {
  /** The engine binary that was actually installed on this machine. */
  path: string;
  /** sha256 of that binary, hex lowercase. */
  sha256: string;
}

/**
 * Builds the machine lock from the repository syd.lock: a deep copy with the
 * local engine path and the installed binary's sha256 written into the two
 * places the extension's gate reads (engine, and sourceBuild when the
 * installed engine IS the source build). Nothing else is invented; every
 * other field is carried over verbatim so the machine lock stays a copy of
 * the repo pin, never a second source of truth.
 */
export function buildMachineLock(repoLock: unknown, installed: MachineLockInput, generatedAt: string): Record<string, unknown> {
  const lock = asLock(repoLock);
  const copy = structuredClone(lock) as Record<string, unknown>;
  if (typeof installed.path !== "string" || installed.path === "") throw new Error("installed engine path is empty");
  if (!/^[0-9a-f]{64}$/.test(installed.sha256)) throw new Error(`not a sha256 hex digest: ${installed.sha256}`);

  const engine = (copy.engine ??= {}) as Record<string, unknown>;
  engine.path = installed.path;
  const engineBinary = (engine.binary ??= {}) as Record<string, unknown>;
  engineBinary.sha256 = installed.sha256;

  // The sourceBuild block is updated only when the installed engine IS that
  // source build (its version names the directory): when the release artifact
  // was installed instead, sourceBuild describes a tag this machine did not
  // build and stays untouched.
  const sourceBuild = copy.sourceBuild as Record<string, unknown> | undefined;
  if (sourceBuild !== undefined && sourceBuild.installedPath !== undefined && installed.path.endsWith(`syd-${String(sourceBuild.version)}/syd`)) {
    sourceBuild.installedPath = installed.path;
    const sourceBinary = (sourceBuild.binary ??= {}) as Record<string, unknown>;
    sourceBinary.sha256 = installed.sha256;
  }

  const notes = (copy.notes ??= []) as unknown[];
  if (Array.isArray(notes)) {
    notes.push(`Machine lock generated ${generatedAt} by make setup from this repository's syd.lock; engine.path and binary sha256 record the binary actually installed here.`);
  }
  return copy;
}

/**
 * Field-level differences between the repository lock and a machine lock —
 * what `make setup` prints so the operator can see the lock is a copy plus
 * local paths, not a divergence.
 */
export function machineLockDiff(repoLock: unknown, machineLock: unknown): string[] {
  const repo = asLock(repoLock);
  const machine = asLock(machineLock);
  const out: string[] = [];
  const pairs: Array<[unknown, unknown, string]> = [
    [repo.engine?.path, machine.engine?.path, "engine.path"],
    [repo.engine?.binary?.sha256, machine.engine?.binary?.sha256, "engine.binary.sha256"],
    [repo.sourceBuild?.installedPath, machine.sourceBuild?.installedPath, "sourceBuild.installedPath"],
    [repo.sourceBuild?.binary?.sha256, machine.sourceBuild?.binary?.sha256, "sourceBuild.binary.sha256"],
  ];
  for (const [before, after, name] of pairs) {
    if (before !== after) out.push(`${name}: ${String(before ?? "(unset)")} -> ${String(after ?? "(unset)")}`);
  }
  const repoNotes = Array.isArray(repo.notes) ? repo.notes.length : 0;
  const machineNotes = Array.isArray(machine.notes) ? machine.notes.length : 0;
  if (machineNotes > repoNotes) out.push(`notes: +${machineNotes - repoNotes} generation note(s)`);
  return out;
}

/** sha256 of a file, for the write-lock CLI below. */
function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function writeLockAtomic(path: string, lock: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(lock, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

/** The CLI entry `tools/setup/setup.sh` drives. Returns a process exit code. */
export function setupCli(args: readonly string[], env: NodeJS.ProcessEnv = process.env): number {
  const flag = (name: string): string | undefined => {
    const at = args.indexOf(name);
    return at !== -1 && at + 1 < args.length ? args[at + 1] : undefined;
  };
  const command = args[0];
  if (command === "band") {
    const release = flag("--release") ?? "";
    const info = kernelBandFromRelease(release);
    if (info === null) {
      console.error(`cannot parse kernel release '${release}' — decide the band manually (docs/environment.md, Engine, two paths)`);
      return 2;
    }
    console.log(info.band);
    return 0;
  }
  if (command === "write-lock") {
    const repoLockPath = flag("--repo-lock") ?? "syd.lock";
    const engine = flag("--engine");
    const out = flag("--out") ?? `${env.HOME ?? "/home"}/.local/opt/syd.lock`;
    if (engine === undefined || !existsSync(engine)) {
      console.error(`write-lock: --engine <path> must name the installed engine binary`);
      return 2;
    }
    let repoLock: unknown;
    try {
      repoLock = JSON.parse(readFileSync(repoLockPath, "utf8"));
    } catch (err) {
      console.error(`cannot read the repository lock ${repoLockPath}: ${(err as Error).message}`);
      return 2;
    }
    const sha256 = sha256File(engine);
    const machine = buildMachineLock(repoLock, { path: engine, sha256 }, new Date().toISOString());
    writeLockAtomic(out, machine);
    for (const line of machineLockDiff(repoLock, machine)) console.log(`lock: ${line}`);
    console.log(`machine lock written: ${out} (engine ${engine}, sha256 ${sha256.slice(0, 16)}…)`);
    return 0;
  }
  console.error("usage: src/setup.ts band --release <uname -r> | write-lock --repo-lock syd.lock --engine <path> [--out <file>]");
  return 2;
}

if (process.argv[1] !== undefined && process.argv[1].endsWith("setup.ts")) {
  process.exit(setupCli(process.argv.slice(2)));
}
