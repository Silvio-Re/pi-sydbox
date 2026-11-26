/**
 * Grants/policy CLI (roadmap P3, item 3). No GUI: list, revoke and an
 * effective-policy view, per project and global.
 *
 *   node --experimental-strip-types src/cli.ts list [--project DIR] [--global]
 *   node --experimental-strip-types src/cli.ts revoke <index> [--project DIR] [--global]
 *   node --experimental-strip-types src/cli.ts effective-policy [--project DIR]
 *
 * It reads and writes THE SAME grant store, policy file and compiler the
 * extension uses (src/store.ts, stateLayout, compileProfile): a second
 * source of truth would be a defect, so every command goes through the
 * extension's own code paths. Revoking needs a store write, which
 * src/store.ts did not have — `removeGrant` lives there, next to appendGrant,
 * so the extension and the CLI share one store implementation.
 *
 * Defaults: `--project` targets the current directory's store,
 * `--global` the global one. Memory tiers (once, session) never reach a
 * store and are therefore not listable here.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { compileProfile, toSydGlobs, WRITE_CATS, type NamespaceVariant, type SandboxPolicy } from "./compiler.ts";
import { readGrants, removeGrant, type StoredGrant } from "./store.ts";
import { stateLayout, POLICY_NAME, type StateLayout } from "./index.ts";

export interface CliEnv {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Sink for normal output; the tests capture it. */
  write: (line: string) => void;
}

export interface CliOutcome {
  status: number;
  lines: string[];
}

function storeFor(scope: "project" | "global", projectDir: string, env: NodeJS.ProcessEnv): string {
  const layout: StateLayout = stateLayout(projectDir, env);
  return scope === "global" ? layout.globalGrants : layout.projectGrants;
}

/** Grants of one scope, printed oldest first (the store's own order). */
export function listGrants(scope: "project" | "global", projectDir: string, env: NodeJS.ProcessEnv): StoredGrant[] {
  return readGrants(storeFor(scope, projectDir, env));
}

/**
 * Revokes one grant by its 1-based index in that scope's listing. Returns
 * null when the index is out of range — the caller reports, nothing is
 * written.
 */
export function revokeByIndex(scope: "project" | "global", projectDir: string, env: NodeJS.ProcessEnv, index: number): StoredGrant | null {
  const file = storeFor(scope, projectDir, env);
  const grants = readGrants(file);
  const at = grants[index - 1];
  if (at === undefined) return null;
  removeGrant(file, (grant) => grant.tier === at.tier && grant.rule === at.rule && grant.at === at.at);
  return at;
}

/**
 * The profile a sandboxed bash call would run under RIGHT NOW for this
 * project: the approved policy (state dir first, else the empty policy —
 * the same H1 rule loadPolicy enforces; a workspace sandbox.json is never
 * read from here) plus the persisted project and global grants plus the
 * standing self-protection denies. Session and once grants are memory of a
 * running pi session and are not part of a static view.
 */
export function effectiveProfile(projectDir: string, env: NodeJS.ProcessEnv): { header: string[]; profile: string } {
  const layout = stateLayout(projectDir, env);
  let policy: SandboxPolicy = {};
  const approved = join(layout.stateDir, POLICY_NAME);
  if (existsSync(approved)) {
    policy = JSON.parse(readFileSync(approved, "utf8")) as SandboxPolicy;
  }
  const projectRules = readGrants(layout.projectGrants).filter((g) => g.tier === "project").map((g) => g.rule);
  const globalRules = readGrants(layout.globalGrants).filter((g) => g.tier === "global").map((g) => g.rule);
  const denies = [...toSydGlobs(layout.stateRoot), ...toSydGlobs(layout.cacheRoot)].map(
    (glob) => `deny/${WRITE_CATS}+${glob}`,
  );
  const profile = compileProfile(policy, "A" as NamespaceVariant, [...projectRules, ...globalRules], denies);
  const header = [
    `project: ${projectDir} (store ${layout.projectGrants})`,
    `policy: ${existsSync(approved) ? approved : "(none adopted — empty policy: everything outside the built-in denies is denied)"}`,
    `grants: ${projectRules.length} project, ${globalRules.length} global`,
    `memory tiers (once, session) of a running pi session are not part of this static view`,
  ];
  return { header, profile };
}

/** Parses and runs one CLI invocation. Pure of process state except through env/cwd. */
export function runCli(args: readonly string[], cliEnv: CliEnv): CliOutcome {
  const lines: string[] = [];
  const write = (line: string): void => {
    lines.push(line);
    cliEnv.write(line);
  };
  const fail = (message: string): CliOutcome => {
    write(`error: ${message}`);
    return { status: 2, lines };
  };
  const command = args[0];
  const rest = args.slice(1);
  const flag = (name: string): string | undefined => {
    const at = rest.indexOf(name);
    return at !== -1 && at + 1 < rest.length ? rest[at + 1] : undefined;
  };
  const scope: "project" | "global" = rest.includes("--global") ? "global" : "project";
  const projectDir = flag("--project") ?? cliEnv.cwd;

  if (command === "list") {
    const grants = listGrants(scope, projectDir, cliEnv.env);
    const label = scope === "global" ? "global" : `project ${projectDir}`;
    if (grants.length === 0) {
      write(`no stored grants (${label}; once and session grants are memory-only)`);
      return { status: 0, lines };
    }
    grants.forEach((grant, i) => {
      write(`${String(i + 1).padStart(3)}  ${grant.tier.padEnd(7)}  ${grant.rule}  (${grant.at})`);
    });
    return { status: 0, lines };
  }

  if (command === "revoke") {
    const numeric = rest.find((arg) => /^\d+$/.test(arg));
    const index = numeric === undefined ? Number.NaN : Number(numeric);
    if (!Number.isInteger(index) || index < 1) {
      return fail("revoke needs the 1-based index from `list`, e.g.: sydbox revoke 2");
    }
    const revoked = revokeByIndex(scope, projectDir, cliEnv.env, index);
    if (revoked === null) return fail(`no grant at index ${index} in the ${scope} store — run list first`);
    write(`revoked (${revoked.tier}) ${revoked.rule}`);
    return { status: 0, lines };
  }

  if (command === "effective-policy") {
    const { header, profile } = effectiveProfile(projectDir, cliEnv.env);
    header.forEach(write);
    write("");
    write(profile);
    return { status: 0, lines };
  }

  write("usage: sydbox list [--project DIR] [--global]");
  write("       sydbox revoke <index> [--project DIR] [--global]");
  write("       sydbox effective-policy [--project DIR]");
  return { status: command === undefined || command === "help" || command === "--help" ? 0 : 2, lines };
}

if (process.argv[1] !== undefined && process.argv[1].endsWith("cli.ts")) {
  const outcome = runCli(process.argv.slice(2), {
    cwd: process.cwd(),
    env: process.env,
    write: (line) => console.log(line),
  });
  process.exit(outcome.status);
}
