/**
 * Approval persistence.
 *
 * Deliberately NOT written into landstrip's sandbox.json: that file is a
 * validated schema of landstrip's own (allowRead/allowWrite path arrays), it has
 * no place for a syd rule such as `allow/lpath,npath,rpath,exec+/usr/bin/true`,
 * and an unrecognised key could make pi-landstrip reject a file it must keep
 * reading. Grants live in a sibling file the engine owns, so the two sandboxes
 * can share a directory without either one rewriting the other's schema.
 *
 * Format: a JSON array, oldest first, deduplicated on (tier, rule).
 */

import { readFileSync, renameSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const TIERS = ["once", "session", "project", "global"] as const;
export type Tier = (typeof TIERS)[number];

export interface StoredGrant {
  tier: Tier;
  rule: string;
  /** ISO timestamp, so a stale grant can be found and revoked later. */
  at: string;
}

export class GrantStoreError extends Error {}

/** Tiers that live in the process memory of the session that granted them. */
export const MEMORY_TIERS: ReadonlySet<Tier> = new Set(["once", "session"]);

/**
 * Appends one persisted grant (project or global). Re-appending the same
 * (tier, rule) is a no-op rather than a duplicate: a violation can be retried
 * many times in one session. `once` and `session` are refused here: they live
 * in memory for the session that chose them and must not survive it.
 */
export function appendGrant(file: string, tier: Tier, rule: string): void {
  if (!TIERS.includes(tier)) throw new GrantStoreError(`unknown tier: ${tier}`);
  if (MEMORY_TIERS.has(tier)) {
    throw new GrantStoreError(`tier ${tier} is memory-only and must not be persisted`);
  }
  if (typeof rule !== "string" || rule.trim() === "") throw new GrantStoreError("empty rule");
  if (rule.includes("\n")) throw new GrantStoreError("rule must be a single line");
  // A rule whose target collapsed to nothing (or to the filesystem root) would
  // persist a blanket grant behind a local-looking denial: refuse it outright
  // (P0, empty-glob guard; recordToGrant refuses to emit these, the store
  // refuses them again so no other writer can smuggle one in).
  const target = rule.slice(rule.lastIndexOf("+") + 1).trim();
  if (target === "" || target === "/") {
    throw new GrantStoreError(`grant target is empty or the filesystem root: ${rule}`);
  }

  const grants = readGrants(file);
  if (grants.some((g) => g.tier === tier && g.rule === rule)) return;

  grants.push({ tier, rule, at: new Date().toISOString() });
  writeGrants(file, grants);
}

/** Reads every stored grant. A missing file is an empty store, not an error. */
export function readGrants(file: string): StoredGrant[] {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  if (raw.trim() === "") return [];

  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new GrantStoreError(`${file}: expected a JSON array`);
  for (const [i, entry] of parsed.entries()) {
    if (typeof entry !== "object" || entry === null) throw new GrantStoreError(`${file}[${i}]: not an object`);
    const { tier, rule, at } = entry as Record<string, unknown>;
    if (typeof tier !== "string" || !TIERS.includes(tier as Tier)) {
      throw new GrantStoreError(`${file}[${i}]: unknown tier ${String(tier)}`);
    }
    if (typeof rule !== "string" || rule === "") throw new GrantStoreError(`${file}[${i}]: missing rule`);
    if (typeof at !== "string") throw new GrantStoreError(`${file}[${i}]: missing timestamp`);
  }
  return parsed as StoredGrant[];
}

/** The rules a compiled profile should carry for one tier. */
export function rulesFor(grants: readonly StoredGrant[], tier: Tier): string[] {
  return grants.filter((g) => g.tier === tier).map((g) => g.rule);
}

/**
 * Writes through a temporary file: an interrupted write must never leave the
 * store unparseable, because the launcher reads it on every run.
 */
function writeGrants(file: string, grants: readonly StoredGrant[]): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(grants, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}
