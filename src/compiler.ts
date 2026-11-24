/**
 * sandbox.json -> syd profile compiler.
 *
 * The emitted shape follows the contract verified on this host (see
 * docs/environment.md, "Engine contract as verified"):
 *
 *   include_profile linux     engine allowlist for /usr,/bin,/lib*,/opt,/tmp/**,/dev
 *   sandbox/lock:off         Landlock is on by default with an empty allowlist and
 *                            can only express allowlists, so a per-path blacklist
 *                            is seccomp-only; without this line every exec dies
 *                            with rc=13 and an empty log
 *   allow/...                policy grants
 *   deny/...                 policy denials, LAST, because a later rule wins
 *
 * Categories are the engine's: lpath traverse, npath lookup, rpath read, wpath
 * write, cpath create, tpath truncate, plus exec. The namespace invariant is real
 * today and must never regress.
 */

export type NamespaceVariant = "A" | "B";

export interface SandboxPolicy {
  enabled?: boolean;
  shell?: { readAccess?: "host" | "policy" };
  network?: { enabled?: boolean; allow?: string[] };
  filesystem?: {
    allowRead?: string[];
    denyRead?: string[];
    denyReadAlways?: string[];
    allowWrite?: string[];
    denyWrite?: string[];
    denyWriteAlways?: string[];
  };
  windows?: unknown;
}

export class PolicyError extends Error {}

const UNSHARE = /(?:^|[\s;])unshare\/([A-Za-z,]+)\s*:\s*([01])/g;
const BIND = /(?:^|[\s;])bind(?:\+[^\s:]*)?\s*:/;

/** Category lists, named after the engine's own vocabulary. */
export const READ_CATS = "lpath,npath,rpath";
export const WRITE_CATS = "lpath,npath,rpath,wpath,cpath,tpath";
export const EXEC_CATS = "lpath,npath,rpath,exec";

/**
 * A policy path names a subtree, a file, or a path that does not exist yet, and
 * nothing in the policy says which. syd's spellings differ: `<path>` matches the
 * object itself, `<path>/***` the object plus everything beneath (its `**` is two
 * levels). Emitting both is the only stat-free way to be right for both kinds —
 * a bare directory rule leaves its contents denied, and `<file>/***` matches
 * nothing at all.
 */
export function toSydGlobs(path: string): string[] {
  const p = normalizePath(path);
  if (p === "/") return ["/***"];
  const base = p.endsWith("/***") ? p.slice(0, -4) : p.endsWith("/**") ? p.slice(0, -3) : p;
  return [base, `${base}/***`];
}

/** Absolute, no trailing slashes; `/` stays `/`. */
export function normalizePath(path: string): string {
  if (!path.startsWith("/")) throw new PolicyError(`policy path must be absolute: ${path}`);
  const p = path.replace(/\/+$/, "");
  return p === "" ? "/" : p;
}

function rule(action: "allow" | "deny", cats: string, path: string): string[] {
  return toSydGlobs(path).map((glob) => `${action}/${cats}+${glob}`);
}

function pushRules(lines: string[], action: "allow" | "deny", cats: string, paths: string[] | undefined): void {
  for (const path of paths ?? []) for (const line of rule(action, cats, path)) lines.push(line);
}

/** `host:port` in the policy, `host!port` in syd's network rules. */
function netRule(entry: string): string {
  const at = entry.lastIndexOf(":");
  if (at <= 0) return `allow/net/connect+${entry}`;
  return `allow/net/connect+${entry.slice(0, at)}!${entry.slice(at + 1)}`;
}

/** Returns human-readable violations of the ADR 0001 variant. Empty = clean. */
export function namespaceViolations(profile: string, variant: NamespaceVariant): string[] {
  const found: string[] = [];
  for (const m of profile.matchAll(UNSHARE)) {
    const kinds = (m[1] ?? "").split(",").filter((k) => k.length > 0);
    const rule = `unshare/${kinds.join(",")}:${m[2] ?? ""}`;
    if (variant === "A") found.push(rule);
    else if (kinds.includes("user")) found.push(rule);
  }
  if (variant === "A" && BIND.test(profile)) {
    found.push("bind rule (requires a mount namespace)");
  }
  return found;
}

export function assertNamespaceInvariant(profile: string, variant: NamespaceVariant): void {
  const violations = namespaceViolations(profile, variant);
  if (violations.length > 0) {
    throw new PolicyError(`namespace invariant violated (variant ${variant}): ${violations.join("; ")}`);
  }
}

export function compileProfile(
  policy: SandboxPolicy,
  _variant: NamespaceVariant,
  extraAllows: readonly string[] = [],
  /** Standing denies appended last, so nothing can override them. */
  extraDenies: readonly string[] = [],
): string {
  // A disabled sandbox is not an empty profile: an empty one still means the
  // engine's built-in default. `include_profile off` is how the engine spells
  // "nothing on" (PROFILE_LIB in src/config.rs of 3.59.0 starts with it).
  if (policy.enabled === false) return "include_profile off\n";

  const fs = policy.filesystem ?? {};
  const lines: string[] = ["include_profile linux", "sandbox/lock:off"];

  // `host` lets the wrapped shell read outside the policy paths; the denies below
  // still win because they come last.
  if (policy.shell?.readAccess === "host") lines.push(`allow/${READ_CATS}+/***`);

  for (const path of fs.allowRead ?? []) lines.push(...rule("allow", READ_CATS, path));
  for (const path of fs.allowWrite ?? []) {
    lines.push(...rule("allow", WRITE_CATS, path));
    // Tools launched from a writable workspace must be executable there:
    // PROFILE_LINUX allows /tmp/** but never exec, and a build tree needs both.
    lines.push(...rule("allow", EXEC_CATS, path));
  }

  if (policy.network?.enabled !== false) {
    for (const entry of policy.network?.allow ?? []) lines.push(netRule(entry));
  }

  // Stored grants (store.ts) arrive as ready-made rules. They go here, before the
  // denies: a rule added after a deny would silently override an explicit denial.
  // A grant may carry several lines (mapper.ts emits both a bare and a `/***`
  // spelling when the denied path's kind is unknown), so every line is checked.
  for (const extra of extraAllows) {
    const lines2 = extra.split("\n");
    if (lines2.some((l) => !l.startsWith("allow/"))) throw new PolicyError(`stored grant must be allow rules: ${extra}`);
    if (lines2.some((l) => l.trim() !== l || l.length === 0)) throw new PolicyError(`stored grant must have no blank or padded lines: ${extra}`);
    lines.push(...lines2);
  }

  // Denials last. landstrip's `*Always` variants differ from the promptable ones
  // only in that they cannot be approved; syd has no ask channel at all, so both
  // become a hard deny here and the prompt budget lives in the dialog layer.
  pushRules(lines, "deny", READ_CATS, fs.denyReadAlways);
  pushRules(lines, "deny", READ_CATS, fs.denyRead);
  pushRules(lines, "deny", WRITE_CATS, fs.denyWriteAlways);
  pushRules(lines, "deny", WRITE_CATS, fs.denyWrite);

  for (const extra of extraDenies) {
    if (!extra.startsWith("deny/")) throw new PolicyError(`standing deny must be a deny rule: ${extra}`);
    if (extra.includes("\n")) throw new PolicyError("standing deny must be a single line");
    lines.push(extra);
  }

  return `${lines.join("\n")}\n`;
}
