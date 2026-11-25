/**
 * pi-sydbox extension entry.
 *
 * Wraps bash tool calls in the engine. The wrapping string is the only control
 * surface the bash tool offers — it takes a command, not a process table — so
 * violation records are collected on the descriptor named by SYD_LOG_FD —
 * SYD_LOG is a level variable in the engine (log level words only, parsed
 * by the engine's log/mod.rs), it has no file-path form, so the wrap command
 * opens the append-mode log fd itself and the engine child inherits it
 * (four-cell shape verified against syd 3.59.0: pi-shape and outer both carry
 * records in append mode).
 *
 * Flow:
 *   tool_call   resolve the engine (env override, machine lock, then scan),
 *               gate it once per session (self-check, lock hash), recompile
 *               the profile from the CURRENT grants, wrap the command
 *   tool_result offer a dialog per new denial within the budget, apply the
 *               tier the user chose, rebuild the profile in place: the engine
 *               already refused this call, and pi cannot replay a tool call
 *               from a result hook — the grant lands on the next identical
 *               call, and only if that call's profile contains it.
 *
 * Tier semantics (actually implemented, not stored-and-hoped):
 *   once|session  process memory of this pi session, gone at exit
 *   project       <stateRoot>/w-<slug>/grants.json (per project cwd)
 *   global        <stateRoot>/global/grants.json
 *
 * The state root defaults to XDG_STATE_HOME (~/.local/state/pi-sydbox), outside
 * every workspace a sandboxed command can write: the workload must not be able
 * to append itself a grant or rewrite the profile it runs under. Standing deny
 * rules for both config trees are compiled into every profile (appended last,
 * so nothing overrides them), and the profile is rewritten before every spawn.
 *
 * Invariant 7: with no usable engine, bash calls are blocked rather than run
 * unsandboxed. Blocking is the only failure mode this module has.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { compileProfile, toSydGlobs, WRITE_CATS, type NamespaceVariant, type SandboxPolicy } from "./compiler.ts";
import { buildLaunch, buildSelfCheck, LaunchError, placeProfile, writeProfile, fsAllowFor } from "./launcher.ts";
import { tryParseAccessLine, type AnyRecord } from "./records.ts";
import { choose, PROMPT_BUDGET, type UiPort } from "./dialog.ts";
import { recordToGrant, DENIALS } from "./mapper.ts";
import { appendGrant, readGrants, rulesFor, type Tier } from "./store.ts";

export interface PiApi {
  registerTool?: (tool: unknown) => void;
  on?: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => void;
}

export const LOG_NAME = "syd.log";
export const PROFILE_DIR = "profiles";
export const GRANTS_NAME = "grants.json";

/** Where a machine pin lives: a copy of the repo's syd.lock (machine-setup step). */
export function lockFile(env: NodeJS.ProcessEnv = process.env): string {
  return env.PI_SYDBOX_LOCK ?? join(homedir(), ".local", "opt", "syd.lock");
}

/** The engine named by the machine lock, when it names a usable one. */
export function lockedEngine(env: NodeJS.ProcessEnv = process.env): string | null {
  const file = lockFile(env);
  let lock: { engine?: { path?: string }; sourceBuild?: { installedPath?: string } };
  try {
    lock = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null; // no lock on this machine: the pin is advisory, see docs
  }
  const named = lock.engine?.path ?? lock.sourceBuild?.installedPath;
  if (typeof named !== "string" || !isExecutable(named)) return null;
  return named;
}

/** Pin order: env override, machine lock, then the version scan. */
export function resolveEngine(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env.SYD_PATH;
  if (explicit !== undefined && explicit !== "" && isExecutable(explicit)) return explicit;
  const locked = lockedEngine(env);
  if (locked !== null) return locked;

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
  // Fail-safe trace of the fd decision: the wrap shell opens the log fd in
  // append mode; SYD_LOG is documented in-engine as a level variable, and
  // the record sink is the fd named by SYD_LOG_FD (probes 21/22).
  return `exec 3>>${shellQuote(options.logPath)}; SYD_LOG_FD=3 ${plan.command.map(shellQuote).join(" ")}`;
}

/**
 * Records appended since `offset`. Returns the new offset so a later call does
 * not re-report the same denial. Every act in DENIALS counts — a kill or panic
 * is strictly worse news than a deny and must not vanish. Unparseable lines
 * advance the offset without becoming records: the engine may write notices
 * (level/msg) that are not violations, and a parse bug must not re-prompt the
 * user forever. The offset only ever moves past the last complete line: the
 * file is append-mode shared with a running child, and a read can catch a
 * half-written record — skipping its bytes would lose the record once the
 * engine finishes the write.
 */
export function newDenials(logText: string, offset: number): { records: AnyRecord[]; offset: number } {
  let end = -1;
  for (let i = logText.indexOf("\n", offset); i !== -1; i = logText.indexOf("\n", i + 1)) end = i;
  if (end < offset) return { records: [], offset };
  const slice = logText.slice(offset, end + 1);
  const records: AnyRecord[] = [];
  for (const line of slice.split("\n")) {
    if (line.trim() === "") continue;
    let record: AnyRecord | null;
    try {
      record = tryParseAccessLine(line);
    } catch {
      continue;
    }
    if (record !== null && DENIALS.has(record.act)) records.push(record);
  }
  return { records, offset: end + 1 };
}

/** Prompt text: what was denied, and the exact rule the engine suggests. */
export function describeDenial(record: { cap: string; sys: string; path?: string; addr?: string }, rule: string): string {
  const target = record.path ?? record.addr ?? "(unknown target)";
  return `syd denied ${record.cap} on ${target} (${record.sys}).\nGrant: ${rule}`;
}

/**
 * Session log offset: the size the log already has when the session starts.
 * Starting at 0 would re-prompt every historical denial left in a persistent
 * syd.log — the prompt-storm failure the design called out.
 */
export function initialLogOffset(logPath: string): number {
  try {
    return statSync(logPath).size;
  } catch {
    return 0;
  }
}

export interface StateLayout {
  /** Root of all pi-sydbox state, outside every writable workspace. */
  stateRoot: string;
  /** Per-project directory under the root (slug of the project cwd). */
  stateDir: string;
  logPath: string;
  projectGrants: string;
  globalGrants: string;
  /** Cache root used only when the state dir cannot host a private profile. */
  cacheRoot: string;
}

export function stateLayout(cwd: string, env: NodeJS.ProcessEnv = process.env): StateLayout {
  // PI_SYDBOX_DIR stays honored (test and dev override) as the state root.
  const stateRoot =
    env.PI_SYDBOX_STATE ??
    (env.PI_SYDBOX_DIR !== undefined ? join(env.PI_SYDBOX_DIR, ".sydbox") : undefined) ??
    join(env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "pi-sydbox");
  const slug = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
  const stateDir = join(stateRoot, `w-${slug}`);
  return {
    stateRoot,
    stateDir,
    logPath: join(stateDir, LOG_NAME),
    projectGrants: join(stateDir, GRANTS_NAME),
    globalGrants: join(stateRoot, "global", GRANTS_NAME),
    cacheRoot: env.PI_SYDBOX_CACHE ?? join(env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "pi-sydbox"),
  };
}

interface SessionState {
  layout: StateLayout;
  policy: SandboxPolicy;
  fsAllows: string[];
  sessionGrants: Set<string>;
  /** Profile directory that satisfied the trusted-path checks (may be cacheRoot). */
  profileDir: string;
  profilePath: string;
  logPath: string;
  logOffset: number;
  /** Engine gate runs once per session state, not per call. */
  engineGated: boolean;
}

/** Adapts pi's ctx.ui onto the dialog port; pi's select already resolves to a label. */
function uiPort(ctx: unknown): UiPort {
  const ui = (ctx as { ui?: { select?: UiPort["select"]; notify?: (m: string) => void } }).ui;
  return {
    // Presence, not arity: a bound or variadic select reports length 0 and must
    // still be a UI. Absence means no terminal; prompts resolve to reject.
    select: (prompt, labels, opts) =>
      typeof ui?.select === "function" ? ui.select(prompt, labels, opts as never) : Promise.resolve(undefined),
    notify: (message) => {
      if (typeof ui?.notify === "function") ui.notify(message);
    },
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

  /** Grants a compiled profile carries: stored project + global + session ones. */
  const storedRules = (file: string, tier: Tier): string[] => {
    try {
      return rulesFor(readGrants(file), tier);
    } catch {
      // A corrupt store must not stop the sandbox from starting; denies still
      // hold. The dialog layer reports the store when a grant is attempted.
      return [];
    }
  };

  const compileCurrent = (st: SessionState): string => {
    const grants = [
      ...storedRules(st.layout.projectGrants, "project"),
      ...storedRules(st.layout.globalGrants, "global"),
      ...st.sessionGrants,
      ...st.fsAllows,
    ];
    // Standing self-protection denials, appended last so nothing overrides
    // them: the sandboxed tree must not read, write, create or rename anything
    // under the config roots. The engine itself writes there as the sandbox's
    // parent, outside its own confinement.
    const denies = [...toSydGlobs(st.layout.stateRoot), ...toSydGlobs(st.layout.cacheRoot)].map(
      (glob) => `deny/${WRITE_CATS}+${glob}`,
    );
    return compileProfile(st.policy, "A" as NamespaceVariant, grants, denies);
  };

  const rebuildProfile = (st: SessionState): string => {
    const text = compileCurrent(st);
    writeProfile(st.profileDir, text); // same dir, same name: the stable path keeps its modes
    return text;
  };

  /**
   * A shell that could not read pre-0.2 grants (the old agent_dir/.sydbox
   * store) would silently forget them on upgrade. Import once per project:
   * every legacy tier lands in the project store — the legacy session grants
   * were already effectively permanent, and a grant that disappears is worse
   * than one that outlived its promise.
   */
  const importLegacyGrants = (layout: StateLayout, cwd: string): void => {
    const legacy = join(cwd, "agent_dir", ".sydbox", GRANTS_NAME);
    if (!existsSync(legacy) || existsSync(layout.projectGrants)) return;
    try {
      for (const grant of readGrants(legacy)) appendGrant(layout.projectGrants, "project", grant.rule);
    } catch {
      // Unreadable legacy store: leave the file alone, import nothing.
    }
  };

  const ensureState = (ctx: unknown): SessionState => {
    if (state !== null) return state;
    const cwd = (ctx as { cwd?: string }).cwd ?? process.cwd();
    const layout = stateLayout(cwd);
    const policy = loadPolicy(cwd);
    const allowPaths = [...(policy.filesystem?.allowRead ?? []), ...(policy.filesystem?.allowWrite ?? [])];
    const fsAllows = fsAllowFor(allowPaths);
    importLegacyGrants(layout, cwd);
    // The state dir sits on the host's own disk; the cache root only matters
    // for a host whose state dir cannot hold a profile the engine trusts.
    // A minimal valid profile text is placed first so the path and its modes
    // are settled before the first real compile rewrites the same file.
    const placed = placeProfile(
      join(layout.stateDir, PROFILE_DIR),
      join(layout.cacheRoot, "profile-fallback"),
      "include_profile linux\nsandbox/lock:off\n",
    );
    state = {
      layout,
      policy,
      fsAllows,
      sessionGrants: new Set(),
      profileDir: placed.dir,
      profilePath: placed.path,
      logPath: layout.logPath,
      logOffset: initialLogOffset(layout.logPath),
      engineGated: false,
    };
    rebuildProfile(state);
    return state;
  };

  /**
   * Once per session: the engine must pass its own self-check, and when a
   * machine lock names this exact engine, the binary must hash to what the
   * lock recorded. A swapped binary under a known name is the classic way to
   * inherit a validation one never earned.
   */
  const gateEngine = (st: SessionState, engine: string, env: NodeJS.ProcessEnv = process.env): string | null => {
    if (st.engineGated) return null;
    st.engineGated = true;
    const argv = buildSelfCheck(engine);
    const check = spawnSync(argv[0] ?? engine, argv.slice(1), { encoding: "utf8" });
    if (check.status !== 0) return `engine self-check failed (rc=${check.status ?? "signal"})`;
    const locked = lockedEngine(env);
    let want: string | undefined;
    try {
      want = (JSON.parse(readFileSync(lockFile(env), "utf8")) as { sourceBuild?: { installedPath?: string; binary?: { sha256?: string } } })
        .sourceBuild?.binary?.sha256;
      const recorded = (JSON.parse(readFileSync(lockFile(env), "utf8")) as { sourceBuild?: { installedPath?: string } })
        .sourceBuild?.installedPath;
      if (locked === null || recorded !== engine || want === undefined) return null;
    } catch {
      return null; // lock unreadable here: the scan above already found something runnable
    }
    const got = createHash("sha256").update(readFileSync(engine)).digest("hex");
    if (got !== want) return `engine binary hash mismatch: ${engine}`;
    return null;
  };

  pi.on?.("tool_call", async (event, ctx) => {
    const tool = (event as { toolName?: string }).toolName;
    const input = (event as { input?: { command?: unknown } }).input;
    if (tool !== "bash" || typeof input?.command !== "string") return undefined;

    const engine = resolveEngine();
    if (engine === null) {
      return { block: true, reason: "pi-sydbox: no syd engine installed, refusing to run bash unsandboxed" };
    }

    let current: SessionState;
    try {
      current = ensureState(ctx);
      const bad = gateEngine(current, engine);
      if (bad !== null) return { block: true, reason: `pi-sydbox: ${bad}` };
      // Rewritten per spawn: a grant stored seconds ago is in the file this
      // child reads, and no edit between two calls can outlive the rewrite.
      const profile = rebuildProfile(current);
      input.command = wrapCommand(input.command, {
        sydPath: engine,
        profilePath: current.profilePath,
        logPath: current.logPath,
        profile,
      });
      return undefined;
    } catch (err) {
      // A compile or launch failure must not degrade into an unsandboxed run.
      if (process.env.PI_SYDBOX_DEBUG === "1") console.error("pi-sydbox tool_call failure:", err);
      return { block: true, reason: `pi-sydbox: ${(err as Error).message}` };
    }
  });

  const applyGrant = (st: SessionState, tier: Tier, rule: string): void => {
    if (tier === "once" || tier === "session") {
      st.sessionGrants.add(rule); // memory only: neither tier survives pi
    } else if (tier === "project") {
      appendGrant(st.layout.projectGrants, "project", rule);
    } else {
      appendGrant(st.layout.globalGrants, "global", rule);
    }
  };

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
    const ui = uiPort(ctx);

    let prompted = 0;
    let dropped = 0;
    let grantedAny = false;
    const seenRules = new Set<string>([...storedRules(state.layout.projectGrants, "project"), ...storedRules(state.layout.globalGrants, "global"), ...state.sessionGrants]);

    for (const record of records) {
      let grant: ReturnType<typeof recordToGrant>;
      try {
        grant = recordToGrant(record, root);
      } catch {
        continue; // a mapper surprise must not eat the rest of the batch
      }
      if (grant === null) continue;
      // Already granted (or repeated in this batch): no second prompt for the
      // same rule. This is the rerun guard.
      if (seenRules.has(grant.rule)) continue;
      seenRules.add(grant.rule);
      if (prompted >= PROMPT_BUDGET) {
        dropped += 1;
        continue;
      }
      prompted += 1;
      try {
        const choice = await choose(ui, describeDenial(record, grant.rule));
        if (choice.kind === "grant" && choice.tier !== undefined) {
          applyGrant(state, choice.tier as Tier, grant.rule);
          grantedAny = true;
          ui.notify?.(`pi-sydbox: ${choice.tier} grant applied`);
        }
      } catch (err) {
        ui.notify?.(`pi-sydbox: grant failed, the denial stays: ${(err as Error).message}`);
      }
    }
    if (dropped > 0) {
      ui.notify?.(`pi-sydbox: ${dropped} further denial(s) left denied (prompt budget reached; they will be offered again on the next run)`);
    }
    if (grantedAny) rebuildProfile(state);
    return undefined;
  });

  pi.on?.("user_bash", async (event, ctx) => {
    const command = (event as { command?: unknown }).command;
    if (typeof command !== "string") return undefined;

    const engine = resolveEngine();
    if (engine === null) {
      return { result: shellRefusal("no syd engine installed, refusing to run an unsandboxed shell") };
    }

    try {
      const current = ensureState(ctx);
      const bad = gateEngine(current, engine);
      if (bad !== null) return { result: shellRefusal(bad) };
      const specifier = "@earendil-works/pi-coding-agent";
      const mod = (await import(specifier)) as { createLocalBashOperations?: () => BashBackend };
      const local = mod.createLocalBashOperations?.();
      if (local === undefined) throw new Error("createLocalBashOperations is missing in this pi build");
      return {
        operations: {
          exec: (command: string, cwd: string, options: unknown) => {
            const profile = rebuildProfile(current);
            const result = local.exec(
              wrapCommand(command, {
                sydPath: engine,
                profilePath: current.profilePath,
                logPath: current.logPath,
                profile,
              }),
              cwd,
              options,
            );
            // A `!` command has no async result hook, so a dialog cannot be
            // awaited here. Count the new denials without consuming them: the
            // next tool result offers them. Silence would hide them entirely.
            let pending = 0;
            try {
              pending = newDenials(readFileSync(current.logPath, "utf8"), current.logOffset).records.length;
            } catch {
              // no log yet: the command may have been a plain echo
            }
            if (pending > 0) {
              uiPort(ctx).notify?.(
                `pi-sydbox: ${pending} denial(s) from your \`!\` command — they will be offered for approval on the next tool result`,
              );
            }
            return result;
          },
        },
      };
    } catch (err) {
      return { result: shellRefusal((err as Error).message) };
    }
  });

  void pi.registerTool;
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
