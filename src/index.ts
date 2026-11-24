/**
 * pi-sydbox extension entry.
 *
 * Wraps bash tool calls in the engine. The wrapping string is the only control
 * surface the bash tool offers — it takes a command, not a process table — so
 * violation records are collected through SYD_LOG (a file path) rather than
 * SYD_LOG_FD, which would need the child's own descriptor table.
 *
 * Flow, and why it is shaped this way:
 *   tool_call   compile the profile, wrap the command, mutate event.input.command
 *   tool_result append the new SYD_LOG records; for each denial ask the dialog and
 *               store the grant, then tell the user to re-run: the engine already
 *               refused this call, and pi cannot replay a tool call from a result
 *               hook, so a grant takes effect on the next identical call.
 *
 * Invariant 7: with no executable engine, bash calls are blocked rather than run
 * unsandboxed. Blocking is the only failure mode this module has.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { compileProfile, type NamespaceVariant, type SandboxPolicy } from "./compiler.ts";
import { buildLaunch, LaunchError, placeProfile, fsAllowFor } from "./launcher.ts";
import { tryParseAccessLine, type AnyRecord } from "./records.ts";
import { choose, type UiPort } from "./dialog.ts";
import { recordToGrant } from "./mapper.ts";
import { appendGrant, readGrants, rulesFor, type Tier } from "./store.ts";

export interface PiApi {
  registerTool?: (tool: unknown) => void;
  on?: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => void;
}

export const LOG_NAME = "syd.log";
export const PROFILE_DIR = "profiles";
export const GRANTS_NAME = "grants.json";

/** Highest installed engine under ~/.local/opt, or $SYD_PATH when set. */
export function resolveEngine(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env.SYD_PATH;
  if (explicit !== undefined && explicit !== "" && isExecutable(explicit)) return explicit;

  const opt = join(homedir(), ".local", "opt");
  let names: string[];
  try {
    names = readdirSync(opt);
  } catch {
    return null;
  }
  const versions = names
    .map((name) => ({ name, match: /^syd-(\d+)\.(\d+)\.(\d+)$/.exec(name) }))
    .filter((entry): entry is { name: string; match: RegExpExecArray } => entry.match !== null)
    .sort((a, b) => compareVersions(a.match, b.match));
  for (const { name } of versions) {
    const candidate = join(opt, name, "syd");
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

function isExecutable(path: string): boolean {
  try {
    const st = statSync(path);
    return st.isFile() && (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function compareVersions(a: RegExpExecArray, b: RegExpExecArray): number {
  for (const i of [1, 2, 3]) {
    const diff = Number(b[i]) - Number(a[i]);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Single-quote for a POSIX shell; the empty string becomes ''. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export interface WrapOptions {
  sydPath: string;
  profilePath: string;
  logPath: string;
  /** The profile text, so the namespace invariant is checked against the real one. */
  profile: string;
}

/**
 * The command pi should run instead of the user's command. It reproduces the
 * bash tool's own `bash -c <command>` semantics inside the sandbox.
 */
export function wrapCommand(command: string, options: WrapOptions): string {
  const plan = buildLaunch(["/bin/bash", "-c", command], {
    sydPath: options.sydPath,
    profile: options.profile,
    profilePath: options.profilePath,
    variant: "A",
  });
  return `SYD_LOG=${shellQuote(options.logPath)} ${plan.command.map(shellQuote).join(" ")}`;
}

/**
 * Records appended since `offset`. Returns the new offset so a later call does not
 * re-report the same denial. Unparseable lines advance the offset without
 * becoming records: the engine may write notices (level/msg) that are not
 * violations, and a parse bug must not re-prompt the user forever.
 */
export function newDenials(logText: string, offset: number): { records: AnyRecord[]; offset: number } {
  const slice = logText.slice(offset);
  const records: AnyRecord[] = [];
  for (const line of slice.split("\n")) {
    if (line.trim() === "") continue;
    let record: AnyRecord | null;
    try {
      record = tryParseAccessLine(line);
    } catch {
      // tryParseAccessLine throws on a non-JSON line or schema drift by contract.
      // Skipping keeps a corrupt line from re-prompting the user on every read.
      continue;
    }
    if (record !== null) records.push(record);
  }
  return { records: records.filter((r) => r.act === "deny"), offset: logText.length };
}

/** Prompt text: what was denied, and the exact rule the engine suggests. */
export function describeDenial(record: { cap: string; sys: string; path?: string; addr?: string }, rule: string): string {
  const target = record.path ?? record.addr ?? "(unknown target)";
  return `syd denied ${record.cap} on ${target} (${record.sys}).\nGrant: ${rule}`;
}

interface SessionState {
  profile: string;
  profilePath: string;
  logPath: string;
  logOffset: number;
  workDir: string;
}

/** Adapts pi's ctx.ui onto the dialog port; pi's select already resolves to a label. */
function uiPort(ctx: unknown): UiPort {
  const ui = (ctx as { ui?: { select?: UiPort["select"]; notify?: (m: string) => void } }).ui;
  return {
    select: (prompt, labels, opts) =>
      ui?.select !== undefined && ui.select.length >= 2
        ? ui.select(prompt, labels, opts as never)
        : Promise.resolve(undefined),
    notify: (message) => ui?.notify?.(message),
  };
}

interface BashBackend {
  exec: (command: string, cwd: string, options: unknown) => unknown;
}

/** A `result` is recorded instead of running anything: the fail-closed shape. */
function shellRefusal(reason: string) {
  return { output: `pi-sydbox: ${reason}`, exitCode: 126, cancelled: false, truncated: false };
}

export default function activate(pi: PiApi): void {
  let state: SessionState | null = null;

  /**
   * One profile per session: compiled once from the policy plus stored grants
   * plus the filesystem allow-list for filesystems the engine does not know
   * (fsAllowFor probes the allow targets' statfs magics — the engine denies
   * every access on an unknown fs, path rules included), then reused. Every
   * hook that runs a command must use the same file, or grants accumulate
   * against a profile no command reads.
   */
  const ensureState = (ctx: unknown): SessionState => {
    if (state !== null) return state;
    const cwd = (ctx as { cwd?: string }).cwd ?? process.cwd();
    const workDir = join(process.env.PI_SYDBOX_DIR ?? join(cwd, "agent_dir"), ".sydbox");
    const policy = loadPolicy(cwd);
    const allowPaths = [
      ...(policy.filesystem?.allowRead ?? []),
      ...(policy.filesystem?.allowWrite ?? []),
    ];
    const fsAllows = fsAllowFor(allowPaths);
    const profile = compileProfile(policy, "A" as NamespaceVariant, [...safeGrants(workDir), ...fsAllows]);
    // The work directory is preferred (profile next to log and grants), but it
    // may sit on a filesystem that cannot hold a trusted profile — a host
    // shared folder keeps 0770/0660 whatever chmod says — and then the engine
    // refuses to start. placeProfile moves only the profile to guest disk.
    const placed = placeProfile(join(workDir, PROFILE_DIR), cacheRoot(), profile);
    state = {
      workDir,
      profile,
      profilePath: placed.path,
      logPath: join(workDir, LOG_NAME),
      logOffset: 0,
    };
    return state;
  };

  pi.on?.("tool_call", async (event, ctx) => {
    const tool = (event as { toolName?: string }).toolName;
    const input = (event as { input?: { command?: unknown } }).input;
    if (tool !== "bash" || typeof input?.command !== "string") return undefined;

    const engine = resolveEngine();
    if (engine === null) {
      return { block: true, reason: "pi-sydbox: no syd engine installed, refusing to run bash unsandboxed" };
    }

    try {
      const current = ensureState(ctx);
      input.command = wrapCommand(input.command, {
        sydPath: engine,
        profilePath: current.profilePath,
        logPath: current.logPath,
        profile: current.profile,
      });
      return undefined;
    } catch (err) {
      // A compile or launch failure must not degrade into an unsandboxed run.
      return { block: true, reason: `pi-sydbox: ${(err as Error).message}` };
    }
  });

  pi.on?.("tool_result", async (_event, ctx) => {
    if (state === null) return undefined;
    let text: string;
    try {
      text = readFileSync(state.logPath, "utf8");
    } catch {
      return undefined;
    }
    const { records, offset } = newDenials(text, state.logOffset);
    state.logOffset = offset;
    const root = (ctx as { cwd?: string }).cwd ?? process.cwd();

    for (const record of records) {
      const grant = recordToGrant(record, root);
      if (grant === null) continue;
      const choice = await choose(uiPort(ctx), describeDenial(record, grant.rule));
      if (choice.kind === "reject" || choice.tier === undefined) continue;
      appendGrant(join(state.workDir, GRANTS_NAME), choice.tier as Tier, grant.rule);
      uiPort(ctx).notify?.(`pi-sydbox: ${choice.tier} grant stored — re-run the command to use it`);
    }
    return undefined;
  });

  // `!` and `!!` never reach tool_call, so without this hook the user's own
  // shell runs unconfined. Named the `user_bash` hook, it either supplies
  // wrapped operations or records a refusal — returning undefined from every
  // handler is what would let the unsandboxed backend run the command.
  pi.on?.("user_bash", async (event, ctx) => {
    const command = (event as { command?: unknown }).command;
    if (typeof command !== "string") return undefined;

    const engine = resolveEngine();
    if (engine === null) {
      return { result: shellRefusal("no syd engine installed, refusing to run an unsandboxed shell") };
    }

    try {
      const current = ensureState(ctx);
      // Imported lazily and by variable so the extension (and its tests) load
      // without pi resolvable, and without TypeScript needing the package types.
      const specifier = "@earendil-works/pi-coding-agent";
      const mod = (await import(specifier)) as { createLocalBashOperations?: () => BashBackend };
      const local = mod.createLocalBashOperations?.();
      if (local === undefined) throw new Error("createLocalBashOperations is missing in this pi build");
      return {
        operations: {
          // Wrap the command pi passes to exec, not the event's copy: they are the
          // same today, and this stays right if pi ever rewrites the command.
          exec: (command: string, cwd: string, options: unknown) =>
            local.exec(
              wrapCommand(command, {
                sydPath: engine,
                profilePath: current.profilePath,
                logPath: current.logPath,
                profile: current.profile,
              }),
              cwd,
              options,
            ),
        },
      };
    } catch (err) {
      return { result: shellRefusal((err as Error).message) };
    }
  });

  void pi.registerTool;
}

/**
 * Guest-disk fallback for the profile only: the log and the grant store stay in
 * the work directory, the profile is the one file the engine inspects modes on.
 */
function cacheRoot(): string {
  return join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "pi-sydbox");
}

function loadPolicy(cwd: string): SandboxPolicy {
  for (const candidate of [join(cwd, "sandbox.json"), join(cwd, "agent_dir", "sandbox.json")]) {    if (!existsSync(candidate)) continue;
    try {
      return JSON.parse(readFileSync(candidate, "utf8")) as SandboxPolicy;
    } catch (err) {
      throw new LaunchError(`${candidate}: ${(err as Error).message}`);
    }
  }
  return {};
}

function safeGrants(workDir: string): string[] {
  try {
    const grants = readGrants(join(workDir, GRANTS_NAME));
    return [...rulesFor(grants, "session"), ...rulesFor(grants, "project"), ...rulesFor(grants, "global")];
  } catch {
    // A corrupt store must not stop the sandbox from starting; denies still hold.
    return [];
  }
}
