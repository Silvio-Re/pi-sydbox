/**
 * Engine launch planning.
 *
 * Invariant 7: a missing or non-executable engine refuses to start. The caller
 * decides how to surface that; this module never falls back to unsandboxed.
 *
 * A profile is a file, so it travels through `-P PATH`. `-m` holds one command
 * and cannot carry a multi-line profile. Violation records reach the parent on
 * the descriptor named by SYD_LOG_FD, which must be reserved in the child's
 * stdio table before spawn.
 */

import { writeFileSync, renameSync, chmodSync, unlinkSync, mkdirSync, statSync, statfsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { assertNamespaceInvariant, type NamespaceVariant } from "./compiler.ts";

export interface LaunchOptions {
  sydPath: string;
  profile: string;
  variant: NamespaceVariant;
  /** Absolute path the profile was written to; passed as `-P PATH`. */
  profilePath?: string;
  /** Extra engine options, each starting with `-`. */
  flags?: string[];
  /** fd >= 3 that receives violation records; set as SYD_LOG_FD and reserved in stdio. */
  logFd?: number;
  env?: Record<string, string>;
}

export type StdioEntry = "inherit" | "ignore" | { from: "log" };

export interface LaunchPlan {
  command: string[];
  env: Record<string, string>;
  stdio: StdioEntry[];
  logFd?: number;
}

export class LaunchError extends Error {}

/** Child stdio table: stdin/stdout/stderr inherited, the log fd spliced in at n. */
function buildStdio(logFd: number | undefined): StdioEntry[] {
  if (logFd === undefined) return ["inherit", "inherit", "inherit"];
  const stdio: StdioEntry[] = ["inherit", "inherit", "inherit"];
  for (let fd = 3; fd < logFd; fd += 1) stdio.push("ignore");
  stdio.push({ from: "log" });
  return stdio;
}

function buildEnv(options: LaunchOptions): Record<string, string> {
  const env: Record<string, string> = {};
  const inherited: Record<string, string | undefined> = process.env;
  for (const [key, value] of Object.entries(inherited)) {
    if (value !== undefined) env[key] = value;
  }
  if (options.env !== undefined) Object.assign(env, options.env);
  if (options.logFd !== undefined) env.SYD_LOG_FD = String(options.logFd);
  else delete env.SYD_LOG_FD;
  return env;
}

export function buildLaunch(command: string[], options: LaunchOptions): LaunchPlan {
  if (command.length === 0) throw new LaunchError("empty command");
  if (!options.sydPath.startsWith("/")) {
    throw new LaunchError(`engine path must be absolute: ${options.sydPath}`);
  }
  if (options.logFd !== undefined && options.logFd < 3) {
    throw new LaunchError(`log fd must be >= 3, got ${options.logFd}`);
  }
  if (options.profilePath !== undefined && !options.profilePath.startsWith("/")) {
    throw new LaunchError(`profile path must be absolute: ${options.profilePath}`);
  }
  if (options.profile.length > 0 && options.profilePath === undefined) {
    throw new LaunchError("profile text requires a profilePath: a profile is passed to syd as a file (-P)");
  }
  const flags = options.flags ?? [];
  for (const flag of flags) {
    if (!flag.startsWith("-")) throw new LaunchError(`engine flag must start with '-': ${flag}`);
  }
  assertNamespaceInvariant(options.profile, options.variant);
  return {
    command: [
      options.sydPath,
      ...(options.profilePath !== undefined ? ["-P", options.profilePath] : []),
      ...flags,
      "--",
      ...command,
    ],
    env: buildEnv(options),
    stdio: buildStdio(options.logFd),
    logFd: options.logFd,
  };
}

export function buildSelfCheck(sydPath: string): string[] {
  if (!sydPath.startsWith("/")) {
    throw new LaunchError(`engine path must be absolute: ${sydPath}`);
  }
  return [sydPath, "--check"];
}

/**
 * Group or world write on the profile or on its directory is EPERM at startup
 * (sandbox.rs:10699) and neither path appears in the log line, so both modes are
 * checked here and reported by name. 0644 loads, 0664 does not.
 */
const UNTRUSTED_WRITE = 0o022;

/** mkdir + chmod 0700, then fail closed when the mode did not take. */
function ensureProfileDir(dir: string): void {
  // `mkdir`'s mode applies only on creation: an existing 0775 directory stays
  // 0775, so the chmod is unconditional and its result is verified.
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const mode = statSync(dir).mode & 0o777;
  if ((mode & UNTRUSTED_WRITE) !== 0) {
    throw new LaunchError(
      `profile directory is group- or world-writable (${mode.toString(8)}): ${dir}`,
    );
  }
}

/**
 * Whether `dir` can hold a profile the engine accepts, probed by writing one: a
 * filesystem may accept the chmod call without applying it (a host shared
 * folder does, leaving the directory 0770 and a 0600 file 0660).
 */
function acceptsProfiles(dir: string): boolean {
  try {
    ensureProfileDir(dir);
    const probe = join(dir, `.mode-probe.${process.pid}.${Math.random().toString(36).slice(2)}`);
    try {
      writeFileSync(probe, "", { mode: 0o600 });
      chmodSync(probe, 0o600);
      return (statSync(probe).mode & UNTRUSTED_WRITE) === 0;
    } finally {
      try {
        unlinkSync(probe);
      } catch {
        // The answer is the mode; a filesystem that refuses this unlink was judged above.
      }
    }
  } catch {
    return false;
  }
}

/** One profile directory per work directory, so two sessions cannot overwrite each other's profile. */
function profileKey(preferred: string): string {
  return createHash("sha256").update(preferred).digest("hex").slice(0, 16);
}

/**
 * The filesystem sandbox (CAP_FS) denies every access on a filesystem whose
 * statfs magic is missing from the engine's FS_MAGIC table (compat.rs in
 * 3.59.0 lacks its fstype entry, f_type 0x786f4256): path allow rules are
 * granted-looking but inert, and the deny event's tip even suggests a path
 * rule. `FsType::from_name` parses integers first, so the magic can be
 * allow-listed by value: `allow/fs+0x786f4256` fully restores the compiled
 * path policy on such a mount, and is a no-op for magics already allowed
 * (verified: ext4 cells pass without it, shared-folder cells need it,
 * and deny rules keep holding with it — probe 19, verdict 20261124-221518).
 *
 * Collects the distinct magics of the policy's allow targets. A policy path
 * may not exist yet, so the probe climbs to the nearest existing ancestor; a
 * path with no statable ancestor (nothing up to "/" worked) is dropped rather
 * than failing the whole policy.
 */
export function fsAllowFor(
  paths: readonly string[],
  probe: (path: string) => bigint | null = fsMagicOf,
): string[] {
  const magics = new Set<string>();
  for (const path of paths) {
    if (!path.startsWith("/")) continue; // malformed policy path: the compiler reports it
    const magic = probe(path);
    if (magic !== null && magic !== 0n) magics.add(`0x${magic.toString(16)}`);
  }
  magics.delete("0xef53"); // ext2/3/4: include_profile linux already allows it
  return [...magics].map((magic) => `allow/fs+${magic}`);
}

/** statfs magic of the nearest existing ancestor, null when nothing statable. */
function fsMagicOf(path: string): bigint | null {
  let current = path;
  for (;;) {
    try {
      // statfsSync().type is a number in Node; the engine's magic values are
      // uint32, so the widening is exact.
      return BigInt(statfsSync(current).type);
    } catch {
      const parent = dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
}

export interface ProfileLocation {
  /** Absolute path of the file passed to the engine as `-P PATH`. */
  path: string;
  dir: string;
  /** Why the preferred directory was abandoned; undefined when it was used. */
  relocated?: string;
}

/**
 * A profile path the engine will accept. The work directory is preferred, so the
 * profile sits next to the log and the grant store. A filesystem that ignores
 * chmod — a shared folder mounted with dmode/fmode keeps every entry
 * 0770/0660 — cannot satisfy the trusted-path check, and the profile moves
 * under `cacheRoot` (the guest's own disk) instead of blocking every bash call.
 * Both candidates failing is an error naming the preferred path: relocation is
 * not a place to hide the caller's broken directory.
 */
export function placeProfile(preferred: string, cacheRoot: string, profile: string): ProfileLocation {
  if (acceptsProfiles(preferred)) {
    return { path: writeProfile(preferred, profile), dir: preferred };
  }
  const dir = join(cacheRoot, profileKey(preferred), "profiles");
  try {
    return {
      path: writeProfile(dir, profile),
      dir,
      relocated: `profile directory cannot be made private on this filesystem: ${preferred}`,
    };
  } catch (err) {
    throw new LaunchError(`${(err as Error).message} (preferred: ${preferred})`);
  }
}

export function writeProfile(dir: string, profile: string): string {
  if (profile.length === 0) throw new LaunchError("empty profile");
  if (!dir.startsWith("/")) throw new LaunchError(`profile directory must be absolute: ${dir}`);
  // The name must end in `.syd-3`: syd refuses any other extension with rc=95
  // (EOPNOTSUPP) and logs a single parse_config_file record whose tip says
  // "use file extension `syd-3'". Nothing about the file's content is read.
  // Mode 0600 is equally required — a group-writable profile is refused with
  // rc=1 EPERM — so both the write mode and the post-write chmod below matter
  // (docs/environment.md, "Engine contract as verified").
  const path = join(dir, "sydbox.syd-3");
  const tmp = join(dir, `sydbox.syd-3.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
  try {
    // syd's trusted-path check (sandbox.rs:10699 in 3.59.0) refuses a profile whose
    // PARENT is group- or world-writable with rc=1 EPERM, and the engine's message
    // names neither the profile nor the directory. Check it here and fail closed
    // with the path; `placeProfile` is the caller that relocates instead.
    ensureProfileDir(dir);
    writeFileSync(tmp, profile, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    const mode = statSync(tmp).mode & 0o777;
    if ((mode & UNTRUSTED_WRITE) !== 0) {
      throw new LaunchError(`profile file is group- or world-writable (${mode.toString(8)}): ${tmp}`);
    }
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // The temp file may not have been created; the write error is the one that matters.
    }
    throw err;
  }
  return path;
}
