/**
 * Violation record -> policy grant (phase 2).
 * Contract: a record is only ever widened into a tier the dialog offers
 * (once / session / project / global); anything unrecognised stays denied.
 *
 * The captured engine log carries the answer itself — for a denied exec of
 * /usr/bin/true, 3.59.0 writes `"tip":"configure `allow/exec+/usr/bin/true'"`.
 * The rule built here is the category form of that tip, so a grant is always a
 * path the engine has already named and never a guess.
 */

import { EXEC_CATS, READ_CATS, WRITE_CATS, netRule, normalizePath } from "./compiler.ts";
import type { AnyRecord } from "./records.ts";

export interface Grant {
  tier: "once" | "session" | "project" | "global";
  rule: string;
}

/** Engine caps (the `cap` field) mapped onto the category lists. readdir and
 * fattr are engine caps with their own rule cats; without these rows a denial
 * raised through them produced a null grant — unpromptable, unfixable at
 * runtime (external-review C4). `mkdir` and `rmdir` are mapped to themselves,
 * NOT to WRITE_CATS: the engine's own tip prints `allow/mkdir+…` / `allow/rmdir+…`
 * (fixtures/capture), and the table's rule is tip-faithful — mapping them onto
 * a broader category union would be a guess the tip never named. */
const CAP_CATS: Readonly<Record<string, string>> = Object.freeze({
  read: READ_CATS,
  stat: READ_CATS,
  open: READ_CATS,
  readdir: READ_CATS,
  write: WRITE_CATS,
  create: WRITE_CATS,
  truncate: WRITE_CATS,
  append: WRITE_CATS,
  fattr: WRITE_CATS,
  exec: EXEC_CATS,
  mkdir: "mkdir",
  rmdir: "rmdir",
});

/** Actions that mean "the engine refused"; anything else needs no grant. */
export const DENIALS: ReadonlySet<string> = new Set([
  "deny",
  "abort",
  "kill",
  "stop",
  "panic",
  "filter",
]);

/**
 * The net truth table lives in compiler.ts `netRule` (one rule for policy
 * entries and captured addrs alike): a `host:port` shape converts to the
 * engine's bang form, everything else — an engine-logged `host!port`, a bare
 * IPv6 literal, a unix socket path — passes through verbatim; a blanket
 * `:`→`!` rewrite would corrupt IPv6.
 */

/** Path (and net target) records must never smuggle a line break: the record
 * content is chosen by the sandboxed workload, and a target carrying \n or \r
 * would inject a line into the compiled profile — every allow line is checked
 * to start with `allow/`, but a forged line that does still passes that check.
 * No real filesystem path or network address contains either, so refusing the
 * record (null, stays denied) loses nothing. (P0, untrusted record content.) */
const LINEBREAK = /[\n\r]/;

/**
 * Returns the narrowest grant that would have let the record through, or null
 * when the record is not a denial, carries a cap this build does not recognise,
 * or names no target. Null means the violation stays denied — it is the safe
 * answer, not an error, because a new engine release may deny something with a
 * cap that did not exist when this table was written.
 *
 * The suggested tier is always `once`: widening to session/project/global is the
 * dialog's decision and is never inferred from the record.
 */
export function recordToGrant(record: AnyRecord, root: string): Grant | null {
  if (!DENIALS.has(record.act)) return null;

  if (record.kind === "net") {
    const target = record.addr ?? record.unix;
    if (!target || LINEBREAK.test(target)) return null;
    const rule = record.addr ? netRule(record.addr) : `allow/net/connect+${target}`;
    return { tier: "once", rule };
  }

  if (record.kind === "ctl") {
    // Tip-faithful: the engine itself prints `allow/ioctl+TCGETS` for these
    // (fixtures/capture); TCGETS is a tty ioctl group, not a path.
    if (record.ctl.some((name) => LINEBREAK.test(name))) return null;
    return { tier: "once", rule: `allow/ioctl+${record.ctl.join(",")}` };
  }

  const path = record.path;
  if (path === undefined || path.length === 0 || LINEBREAK.test(path)) return null;
  // A compound cap ("read,write" — the engine joins an array cap with commas)
  // maps to the deduplicated union of its components' categories; an unknown
  // component means the record stays denied (null), as for a single unknown cap.
  let cats: string | undefined;
  for (const cap of record.cap.split(",")) {
    const current = CAP_CATS[cap];
    if (current === undefined) {
      cats = undefined;
      break;
    }
    if (cats === undefined) {
      cats = current;
      continue;
    }
    const seen = cats.split(",");
    for (const cat of current.split(",")) {
      if (!seen.includes(cat)) seen.push(cat);
    }
    cats = seen.join(",");
  }
  if (cats === undefined) return null;

  // Relative paths are logged against the process cwd; resolving against the
  // project root keeps the grant inside the tree the run belongs to.
  const absolute = normalizePath(path.startsWith("/") ? path : `${root.replace(/\/+$/, "")}/${path}`);
  const base = absolute.replace(/\/\*+$/, "");
  // An all-glob denial path (`/`, `/*`, `/**`…) collapses to an empty or root
  // target: what looks like a local denial must not round-trip into a blanket
  // `allow/<cats>+/` grant. The record stays denied — if a tree is truly meant
  // to be writable, the policy says so, not a collapsed glob (P0).
  if (base === "" || base === "/") return null;
  const ruleFor = (target: string) => `allow/${cats}+${target}`;
  // mkdir/rmdir carry no `type` in captures and their tips print the singular
  // path form only (`allow/mkdir+…`, `allow/rmdir+…`): the dual-spelling
  // branch below would invent a subtree variant the tip never named.
  if (record.cap === "mkdir" || record.cap === "rmdir") {
    return { tier: "once", rule: ruleFor(base) };
  }
  // A path needs both spellings; neither covers both kinds (environment.md,
  // profile-files section). The record's `type` names the kind when present,
  // and a record path that is itself a glob names the subtree. When the kind
  // is unknown — the captured 3.59.0 fixture carries no `type`, so the field
  // is not proven — BOTH spellings are emitted: the bare rule alone would
  // leave a directory's children denied and re-prompt forever, while the
  // extra subtree spelling is simply inert when the target is a file.
  if (record.type === "reg") return { tier: "once", rule: ruleFor(base) };
  const subtree = `${base}/***`;
  if (record.type === "dir" || base !== absolute) return { tier: "once", rule: ruleFor(subtree) };
  return { tier: "once", rule: `${ruleFor(base)}\n${ruleFor(subtree)}` };
}
