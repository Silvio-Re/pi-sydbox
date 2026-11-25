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
import { compileProfile, normalizePath, toSydGlobs, WRITE_CATS, type NamespaceVariant, type SandboxPolicy } from "./compiler.ts";
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
/** The per-project approved policy, under the state dir — never inside the tree. */
export const POLICY_NAME = "policy.json";

/** Ceiling on the engine self-check in `gateEngine` (P0: see there). */
const GATE_TIMEOUT_MS = 10_000;

/** Where a machine pin lives: a copy of the repo's syd.lock (machine-setup step). */
export function lockFile(env: NodeJS.ProcessEnv = process.env): string {
  return env.PI_SYDBOX_LOCK ?? join(homedir(), ".local", "opt", "syd.lock");
}

/** The machine named a lock but its engine is unusable: never fall back to the scan. */
export class LockedEngineError extends Error {
  readonly lockPath: string;

  constructor(lockPath: string, message: string) {
    super(message);
    this.name = "LockedEngineError";
    this.lockPath = lockPath;
  }
}

/** Pin order: env override, machine lock, then the version scan. */
export function resolveEngine(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env.SYD_PATH;
  if (explicit !== undefined && explicit !== "" && isExecutable(explicit)) return explicit;

  const file = lockFile(env);
  let lock: { engine?: { path?: string }; sourceBuild?: { installedPath?: string } } | undefined;
  try {
    lock = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    lock = undefined; // unreadable or absent: this machine has no pin, scan
  }
  if (lock !== undefined) {
    const named = lock.engine?.path ?? lock.sourceBuild?.installedPath;
    if (typeof named === "string" && isExecutable(named)) return named;
    // C5 (external review): the lock exists precisely because it records which
    // engine was validated on this machine; an unvalidated newer binary from
    // the scan is what it guards against (3.60.0 here --checks while EPERMing
    // every spawn). Refuse — block bash — instead of newest-wins.
    const what = typeof named === "string" ? `names ${named}, which is missing or not executable` : "names no usable engine";
    throw new LockedEngineError(
      file,
      `machine lock ${file} ${what}; reinstall the pinned engine or remove the lock — refusing to run bash with an unvalidated engine`,
    );
  }

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
  // S1 seal, corrected after the fd-forge probe: the fd CANNOT be marked
  // close-on-exec in the wrap shell — syd is exec'd by that same shell, so
  // CLOEXEC there blinds the engine's own record channel (verdict run
  // 20261125-105950: "engine records no longer reach the sink"). The fd must
  // cross the engine's execve and be closed one level down, in the workload
  // shell itself: the wrap owns the first statement the child runs, so the
  // command is prefixed with `exec 3>&-` — after it, fd 3 is EBADF for the
  // workload and everything it spawns, while the engine (the parent, which
  // never execs again) keeps writing. The reopen paths stay blocked: the
  // log path carries standing allows-turned-denies in the compiled profile
  // (denies win regardless of the fd used to get there — syd checks the
  // canonical path, so /proc/self/fd/3 resolves to the denied log path too).
  // A prefix, not a wrapper: `exec 3>&-; <command>` leaves shell syntax
  // (heredocs, comments, pipelines) exactly as the author wrote it.
  const sealed = `exec 3>&-; ${command}`;
  const plan = buildLaunch(["/bin/bash", "-c", sealed], {
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
export function newDenials(logText: string, offset: number): { records: AnyRecord[]; offset: number; skipped: number } {
  let end = -1;
  for (let i = logText.indexOf("\n", offset); i !== -1; i = logText.indexOf("\n", i + 1)) end = i;
  if (end < offset) return { records: [], offset, skipped: 0 };
  const slice = logText.slice(offset, end + 1);
  const records: AnyRecord[] = [];
  let skipped = 0;
  for (const line of slice.split("\n")) {
    if (line.trim() === "") continue;
    let record: AnyRecord | null;
    try {
      record = tryParseAccessLine(line);
    } catch {
      skipped += 1; // drift: counted, never lost silently (design D3)
      continue;
    }
    if (record === null) {
      skipped += 1;
      continue;
    }
    if (DENIALS.has(record.act)) records.push(record);
  }
  return { records, offset: end + 1, skipped };
}

/**
 * Everything interpolated below came off the engine log, and the log's path and
 * addr values are chosen by the contained process: a crafted filename must not
 * be able to forge notification lines or bait a tier choice (P0, prompt
 * injection). The defense is shape, not filtering: one constant framing line
 * first, then every record-derived value JSON-quoted (so no newline, quote or
 * label-like text inside it can ever read as a line of its own) and truncated
 * before quoting (so a crafted name cannot flood the prompt either).
 */
export const RECORD_FRAMING = "The record below comes from the sandbox engine; its content is chosen by the contained process." as const;

/** Display cap for record-derived values; generous for real paths, fatal to floods. */
const MAX_UNTRUSTED_DISPLAY = 200;

function showUntrusted(value: string): string {
  const body = value.length > MAX_UNTRUSTED_DISPLAY ? `${value.slice(0, MAX_UNTRUSTED_DISPLAY)}…` : value;
  return JSON.stringify(body);
}

/** Prompt text: what was denied, and the exact rule the engine suggests. */
export function describeDenial(record: { cap: string; sys: string; path?: string; addr?: string }, rule: string): string {
  const target = record.path ?? record.addr ?? "(unknown target)";
  return `${RECORD_FRAMING}\nsyd denied ${showUntrusted(record.cap)} on ${showUntrusted(target)} (${showUntrusted(record.sys)}).\nGrant: ${rule}`;
}

/**
 * Session log offset: the size the log already has when the session starts.
 * Starting at 0 would re-prompt every historical denial left in a persistent
 * syd.log — the prompt-storm failure the design called out.
 *
 * The seed counts the decoded text's UTF-16 units, not `statSync().size`
 * bytes: `newDenials` consumes this as a JS string index, and non-ASCII
 * content (a UTF-8 filename inside a record) makes byte and index disagree —
 * the first slice would start mid-record, lose that record forever, and
 * skew every later slice (external-review C1).
 *
 * The seed stops at the last COMPLETE line, not the file end: a session that
 * crashed mid-write leaves a partial record at the tail, and seeding past its
 * start would mark those bytes as consumed — the record would be completed by
 * the engine later and never parsed (external review 2). Seeding after the
 * last newline puts the tail in the unread zone: once completed, it parses.
 */
export function initialLogOffset(logPath: string): number {
  try {
    const text = readFileSync(logPath, "utf8");
    return text.lastIndexOf("\n") + 1;
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
  /** Grants for exactly the next spawn; cleared once that child is launched. */
  onceGrants: Set<string>;
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
      // A corrupt store must not stop the sandbox from starting: readGrants
      // fails below in ensureState, which notifies the operator once per
      // session — this is only the compile-time fallback, not the place to
      // nag on every spawn (external-review M2).
      return [];
    }
  };

  const compileCurrent = (st: SessionState): string => {
    const grants = [
      ...storedRules(st.layout.projectGrants, "project"),
      ...storedRules(st.layout.globalGrants, "global"),
      ...st.sessionGrants,
      ...st.onceGrants,
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
   * Import of pre-0.2 grants is explicit and user-run, never automatic:
   * the path `<cwd>/agent_dir/.sydbox/grants.json` lives INSIDE the confined
   * tree, so a fresh clone of any repo that happens to ship it would preload
   * permanent project grants before the first prompt is ever shown
   * (external-review S2). Opt in per workspace:
   *   PI_SYDBOX_IMPORT_LEGACY=1 pi --cwd <repo>
   */
  const importLegacyGrants = (layout: StateLayout, cwd: string): void => {
    if (process.env.PI_SYDBOX_IMPORT_LEGACY !== "1") return;
    const legacy = join(cwd, "agent_dir", ".sydbox", GRANTS_NAME);
    if (!existsSync(legacy) || existsSync(layout.projectGrants)) return;
    try {
      // Lenient by design: a pre-0.2 store predates the `at` timestamp the
      // current `readGrants` validates, so a strict read rejects the whole
      // migration source and the catch below imports nothing (`missing
      // timestamp`). Memory tiers from the legacy file are SKIPPED, not
      // widened to project: a promise that expired with its session must not
      // become a permanent one during migration.
      const parsed: unknown = JSON.parse(readFileSync(legacy, "utf8"));
      if (!Array.isArray(parsed)) return;
      const rules = new Set<string>();
      for (const entry of parsed) {
        const { tier, rule } = (entry ?? {}) as Record<string, unknown>;
        if (typeof tier !== "string" || typeof rule !== "string" || rule === "") continue;
        if (tier === "once" || tier === "session") continue; // expired with their session
        if (tier !== "project" && tier !== "global") continue;
        rules.add(rule);
      }
      for (const rule of rules) appendGrant(layout.projectGrants, "project", rule);
    } catch {
      // Unreadable legacy store: leave the file alone, import nothing.
    }
  };

  const ensureState = (ctx: unknown): SessionState => {
    if (state !== null) return state;
    const cwd = (ctx as { cwd?: string }).cwd ?? process.cwd();
    const layout = stateLayout(cwd);
    const policy = loadPolicy(cwd, layout);
    // Corrupt grant stores were previously swallowed here (empty rule list,
    // no message): the operator saw grants vanish with no trace. Read once
    // per session and report the failure — the fail-closed behavior stays,
    // the silence goes (external-review M2).
    const ui = uiPort(ctx);
    for (const store of [layout.projectGrants, layout.globalGrants]) {
      if (!existsSync(store)) continue;
      try {
        readGrants(store);
      } catch (err) {
        ui.notify?.(`pi-sydbox: grant store ${store} cannot be read (${(err as Error).message}); its grants ARE NOT in effect — restore or delete the file`);
      }
    }
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
      onceGrants: new Set(),
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
   * machine lock records an engine, the binary that runs here must be one the
   * lock named and hash to what the lock recorded. A swapped binary under a
   * known name is the classic way to inherit a validation one never earned.
   * The lock's two recorded paths (source-build and release) are the only
   * engines this session may run: an env override to some other binary —
   * exactly like the scan in resolveEngine — is refused rather than trusted
   * (external-review M3, same stance as C5).
   */
  const gateEngine = (st: SessionState, engine: string, env: NodeJS.ProcessEnv = process.env): string | null => {
    if (st.engineGated) return null;
    st.engineGated = true;
    const argv = buildSelfCheck(engine);
    // The self-check is a spawn like any other and can hang (P0: this call had
    // no timeout, so a wedged engine --check blocked the first bash call
    // forever). The limit is a fixed 10 s; PI_SYDBOX_GATE_TIMEOUT_MS is a
    // test-only knob for keeping the suite fast. Either way a failure to run
    // is a FAILED check — blocked, named — never a pass.
    const envLimit = env.PI_SYDBOX_GATE_TIMEOUT_MS;
    const limit = typeof envLimit === "string" && Number.isFinite(Number(envLimit)) && Number(envLimit) > 0 ? Number(envLimit) : GATE_TIMEOUT_MS;
    const check = spawnSync(argv[0] ?? engine, argv.slice(1), { encoding: "utf8", timeout: limit });
    if (check.error) {
      const timedOut = /ETIMEDOUT/.test((check.error as Error).message);
      return timedOut
        ? `engine self-check timed out after ${limit} ms, refusing to judge it healthy (blocked)`
        : `engine self-check failed to run (${(check.error as Error).message})`;
    }
    if (check.status !== 0) return `engine self-check failed (rc=${check.status ?? "signal"})`;
    let lock: {
      engine?: { path?: string; binary?: { sha256?: string } };
      sourceBuild?: { installedPath?: string; binary?: { sha256?: string } };
    };
    try {
      lock = JSON.parse(readFileSync(lockFile(env), "utf8"));
    } catch {
      return null; // no machine pin on this host: the self-check above is the gate
    }
    const pinned: Array<{ path?: string; sha256?: string }> = [
      { path: lock.sourceBuild?.installedPath, sha256: lock.sourceBuild?.binary?.sha256 },
      { path: lock.engine?.path, sha256: lock.engine?.binary?.sha256 },
    ];
    const named = pinned.filter((entry): entry is { path: string; sha256?: string } => typeof entry.path === "string");
    const match = named.find((entry) => entry.path === engine);
    if (match === undefined) {
      const names = named.map((entry) => entry.path);
      return `engine ${engine} is not one the machine pin records (${names.join(", ") || "none"}) — refusing an unvalidated engine`;
    }
    if (typeof match.sha256 !== "string") return null; // pinned by path only: the path IS the pin
    const got = createHash("sha256").update(readFileSync(engine)).digest("hex");
    if (got !== match.sha256) return `engine binary hash mismatch: ${engine}`;
    return null;
  };

  pi.on?.("tool_call", async (event, ctx) => {
    const tool = (event as { toolName?: string }).toolName;
    const input = (event as { input?: { command?: unknown } }).input;
    if (tool !== "bash" || typeof input?.command !== "string") return undefined;

    let engine: string | null;
    try {
      engine = resolveEngine();
    } catch (err) {
      if (err instanceof LockedEngineError) return { block: true, reason: `pi-sydbox: ${err.message}` };
      throw err;
    }
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
      // The once-grants are already compiled into the profile file this child
      // reads; their mandate ends with this spawn, so they are cleared now.
      // The next call recompiles the file without them.
      current.onceGrants.clear();
      return undefined;
    } catch (err) {
      // A compile or launch failure must not degrade into an unsandboxed run.
      if (process.env.PI_SYDBOX_DEBUG === "1") console.error("pi-sydbox tool_call failure:", err);
      return { block: true, reason: `pi-sydbox: ${(err as Error).message}` };
    }
  });

  const applyGrant = (st: SessionState, tier: Tier, rule: string): void => {
    // `once` feeds exactly the next spawn (cleared after its launch, in the
    // call sites) — it must not outlive its label. The old code put both
    // tiers into `sessionGrants`, making "allow once" a session grant in
    // fact (external-review C2).
    if (tier === "once") {
      st.onceGrants.add(rule); // one spawn wide, then gone
    } else if (tier === "session") {
      st.sessionGrants.add(rule); // memory only: neither tier survives pi
    } else {
      // The mapper's dual-spelling grant arrives as one string with two lines
      // (bare rule + subtree rule); the store is single-line by design, so
      // each spelling is stored as its own grant. The line check in
      // compileProfile stays the guard for once/session (memory) rules.
      const file = tier === "project" ? st.layout.projectGrants : st.layout.globalGrants;
      for (const line of rule.split("\n")) appendGrant(file, tier, line);
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
    const { records, offset, skipped } = newDenials(text, state.logOffset);
    state.logOffset = offset;
    const root = (ctx as { cwd?: string }).cwd ?? process.cwd();
    const ui = uiPort(ctx);

    // D3: drift is counted where it happens and reported once per batch —
    // an engine notice or a record shape this build cannot parse is a fact
    // the operator must see, not a silent swallow.
    if (skipped > 0) {
      ui.notify?.(`pi-sydbox: ${skipped} log line(s) not recognised (engine drift or notices); they stay unprocessed`);
    }

    // S3: a denial raised by an explicit deny line in sandbox.json cannot be
    // lifted by any grant — the denies are compiled AFTER the grants, by
    // design. Prompting would persist a dead grant and the dedupe would then
    // suppress every future prompt for that rule: a fail-forever loop with no
    // diagnostics. Such records are reported as policy denials instead.
    const denyRoots = [
      ...(state.policy.filesystem?.denyReadAlways ?? []),
      ...(state.policy.filesystem?.denyRead ?? []),
      ...(state.policy.filesystem?.denyWriteAlways ?? []),
      ...(state.policy.filesystem?.denyWrite ?? []),
    ].map((path) => normalizePath(path).replace(/\/\*+$/, ""));
    const policyDenied = (target: string): boolean =>
      denyRoots.some((rootPath) => target === rootPath || target.startsWith(`${rootPath}/`));

    let prompted = 0;
    let dropped = 0;
    let grantedAny = false;
    const seenRules = new Set<string>([...storedRules(state.layout.projectGrants, "project"), ...storedRules(state.layout.globalGrants, "global"), ...state.sessionGrants]);
    // `once` grants from a previous spawn do not seed the dedupe: they have
    // lapsed by definition, and their rule must be able to prompt again.

    for (const record of records) {
      let grant: ReturnType<typeof recordToGrant>;
      try {
        grant = recordToGrant(record, root);
      } catch {
        continue; // a mapper surprise must not eat the rest of the batch
      }
      if (grant === null) continue;
      const target = "path" in record ? record.path : "addr" in record ? record.addr : "";
      // Relative record paths are logged against the process cwd; the grant
      // mapper resolves them against the project root, and this guard must do
      // the same — a relative path inside a deny root would otherwise slip the
      // policy-deny check and be offered as a liftable grant (external-review M4).
      const resolvedTarget =
        target === undefined || target === "" || target.startsWith("/")
          ? target
          : normalizePath(`${root.replace(/\/+$/, "")}/${target}`);
      if (resolvedTarget !== undefined && resolvedTarget !== "" && policyDenied(resolvedTarget)) {
        // resolvedTarget is record-derived (workload-chosen path): quoted and
        // truncated, never raw in a notification line (P0, task 5).
        ui.notify?.(`pi-sydbox: policy deny (sandbox.json) on ${showUntrusted(resolvedTarget)}: no grant can lift it — edit sandbox.json`);
        continue; // do not prompt, do not seed the dedupe with a dead rule
      }
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

    let engine: string | null;
    try {
      engine = resolveEngine();
    } catch (err) {
      if (err instanceof LockedEngineError) return { result: shellRefusal(err.message) };
      throw err;
    }
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
            const wrapped = wrapCommand(command, {
              sydPath: engine,
              profilePath: current.profilePath,
              logPath: current.logPath,
              profile,
            });
            // The once-grants are compiled into the profile file this child
            // reads, so their mandate ends with the launch — same invariant as
            // the tool_call handler. Without this clear, a single "allow
            // once" survived into every later `!` command and spawn until a
            // bash tool call happened to clear it (external-review M1).
            current.onceGrants.clear();
            const result = local.exec(wrapped, cwd, options);
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

function loadPolicy(cwd: string, layout: StateLayout): SandboxPolicy {
  // H1 (external review 2): a policy read from inside the confined tree
  // disables or widens the sandbox it is supposed to constrain — a fresh
  // clone of any repo could ship `{"enabled": false}` or grant itself the
  // whole disk, silently, before the first prompt is ever shown. The approved
  // policy lives OUTSIDE the workspace, under the per-project state dir; the
  // explicit copy is the operator's approval act, same stance as the legacy
  // grant import (S2). PI_SYDBOX_POLICY is the test/dev override.
  const explicit = process.env.PI_SYDBOX_POLICY;
  if (explicit !== undefined && explicit !== "") {
    try {
      return JSON.parse(readFileSync(explicit, "utf8")) as SandboxPolicy;
    } catch (err) {
      throw new LaunchError(`${explicit}: ${(err as Error).message}`);
    }
  }
  const approved = join(layout.stateDir, POLICY_NAME);
  if (existsSync(approved)) {
    try {
      return JSON.parse(readFileSync(approved, "utf8")) as SandboxPolicy;
    } catch (err) {
      throw new LaunchError(`${approved}: ${(err as Error).message}`);
    }
  }
  const present = [join(cwd, "sandbox.json"), join(cwd, "agent_dir", "sandbox.json")]
    .filter((candidate) => existsSync(candidate));
  if (present.length > 0) {
    throw new LaunchError(
      `workspace ${present.map((file) => file.slice(cwd.length + 1)).join(" or ")} is never loaded from inside the confined tree (H1) — review it, then adopt it once: mkdir -p ${layout.stateDir} && cp ${present[0]} ${approved}`,
    );
  }
  return {};
}
