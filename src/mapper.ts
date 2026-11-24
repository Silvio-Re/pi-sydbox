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

import { EXEC_CATS, READ_CATS, WRITE_CATS, normalizePath } from "./compiler.ts";
import type { AnyRecord } from "./records.ts";

export interface Grant {
  tier: "once" | "session" | "project" | "global";
  rule: string;
}

/** Engine caps (the `cap` field) mapped onto the category lists. */
const CAP_CATS: Readonly<Record<string, string>> = Object.freeze({
  read: READ_CATS,
  stat: READ_CATS,
  open: READ_CATS,
  write: WRITE_CATS,
  create: WRITE_CATS,
  truncate: WRITE_CATS,
  append: WRITE_CATS,
  exec: EXEC_CATS,
});

/** Actions that mean "the engine refused"; anything else needs no grant. */
const DENIALS: ReadonlySet<string> = new Set(["deny", "abort", "kill", "stop", "panic", "filter"]);

function netRule(addr: string): string {
  const at = addr.lastIndexOf(":");
  if (at <= 0) return `allow/net/connect+${addr}`;
  return `allow/net/connect+${addr.slice(0, at)}!${addr.slice(at + 1)}`;
}

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
    if (!target) return null;
    const rule = record.addr ? netRule(record.addr) : `allow/net/connect+${target}`;
    return { tier: "once", rule };
  }

  const path = record.path;
  if (path === undefined || path.length === 0) return null;
  const cats = CAP_CATS[record.cap];
  if (cats === undefined) return null;

  // Relative paths are logged against the process cwd; resolving against the
  // project root keeps the grant inside the tree the run belongs to.
  const absolute = normalizePath(path.startsWith("/") ? path : `${root.replace(/\/+$/, "")}/${path}`);
  // The denial record names what was denied and its kind, so unlike a policy
  // prefix there is no ambiguity here: a bare file path matches the file, a
  // directory needs the subtree spelling or its children stay denied.
  const base = absolute.replace(/\/\*+$/, "");
  // A record path that is itself a glob asks for the tree, and `type` names the
  // kind for plain paths. A bare file path must stay bare: `<file>/***` matches
  // nothing, which would turn every approval into a re-prompt loop.
  const target = record.type === "dir" || base !== absolute ? `${base}/***` : base;
  return { tier: "once", rule: `allow/${cats}+${target}` };
}
