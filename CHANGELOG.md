# Changelog

## [Unreleased]

- Review-fix wave (external deep review of this repository): the grant
  pipeline now works end to end. `appendGrant` rebuilds the profile in
  place (`rebuildProfile`, `src/index.ts`), so an approval takes effect on
  the next call in the same session instead of being inert until a new
  session. Tiers are real: `once` and `session` are memory-only (never
  persisted, process lifetime), `project` stays at the workdir store,
  `global` lives at `~/.local/state/pi-sydbox` (`src/store.ts`).
- Tier semantics fixed: "allow for this session" previously persisted forever
  (≡ global) and "allow once" was compiled by nothing (dead choice). Both
  now behave as their names say; the dialog drops no silent no-op option.
- The grant store and config are no longer workspace-writable targets:
  the state root moved to `~/.local/state/pi-sydbox/<workdir-slug>/`
  (`src/launcher.ts` `stateLayout`), and every compiled profile carries
  standing denies for the profile, grants and log paths
  (`compileProfile` self-protection lines), so a sandboxed workload
  cannot edit the config that will confine its next call.
- The engine pin is enforced: `gateEngine` runs `buildSelfCheck` at startup
  (a failing self-check blocks the session), the resolver honors
  `SYD_PATH` the lock points to, and `tools/verify-artifact.sh` speaks
  only the fact-checked minisign instructions (gpg key text removed,
  `NOTICE` corrected).
- Denial records: `type` is now a known field (`records.ts`), and the
  mapper emits BOTH the bare and the `/***` spelling when the denied
  path's kind is unknown (the captured 3.59.0 fixture carries no `type`);
  a single guessed spelling would re-prompt forever on the wrong kind.
  Typed records (`dir`/`reg`) get exactly their own spelling.
- Cross-session prompt storms fixed: `logOffset` is seeded from the log
  size at session start (`index.ts`), so only new lines prompt, and
  denials whose rule is already granted are skipped (dedupe against
  memory + store).
- Only `act === "deny"` used to prompt; `kill`, `abort`, `stop`, `panic`
  and `filter` events were dropped silently. `newDenials` now filters on
  the mapper's `DENIALS` set.
- Batch resilience and budget: per-record try/catch in the result
  handler (one corrupt store entry fails its own prompt, not the batch),
  `safeGrants` corrupt-store corruption now notifies instead of silently
  dropping every stored grant, and the dialog has a prompt budget
  (`PROMPT_BUDGET = 4` per result, rest auto-denied with one notify).
- `user_bash` (`!` commands) now run the same denial/gate path as tool
  calls; previously their denials could never reach a dialog.
- `uiPort` accepts any function-shaped port (typeof check, not arity);
  a wrapped variadic `ui.select` used to auto-reject every prompt
  silently.
- Type checking now exists: `tsconfig.json` (strict,
  `noUncheckedIndexedAccess`), `typecheck` and `ci` scripts
  (`package.json`), `.github/workflows/ci.yml` (unit + typecheck as a
  normal CI user, shellcheck on `corpus/run.sh` and `tools/*.sh`), and
  the strict pass surfaced and fixed real errors (`compiler.ts` unshare
  groups, `launcher.ts` `fsMagicOf` types, index-access guards).
- Net grant rules no longer rewrite the address (`:`→`!` mangling
  corrupted IPv6); the rule passes the engine's own `host!port`
  spelling through unchanged.
- Fixed: sandboxed writes into the shared-folder checkout were denied by
  the engine's filesystem sandbox on sight — syd 3.59.0 has no entry for that
  fstype in its `FS_MAGIC` table, so `statfs` magic `0x786f4256` fell to the default
  deny. `fsAllowFor` (`src/launcher.ts`) now collects the distinct statfs
  magics of the policy's allow targets (climbing to the nearest existing
  ancestor for paths that do not exist yet, dropping ext magics
  `include_profile` already allows) and the compiler receives those
  `allow/fs+0x<magic>` lines through its `extraAllows` slot; deny rules keep
  holding (probe 19: C1 granted, no-cure control C2 denied).
- Probe 19 rewritten to assert the extension's own emission instead of manual
  append-cure profiles (old section 4 retired; facts live in
  `agent_dir/spike/logs/verdict-20261124-221518/`).
- `docs/environment.md`: fs-sandbox item under "Confinement layers" with the
  deny-record evidence and the by-value cure.

## [0.1.0] - 2026-11-23

- Repository skeleton: design doc, invariants, corpus harness contract, ADR 0001
  (namespace policy, proposed), rollback runbook, `syd.lock` placeholder.
- Real code: namespace-invariant check, violation-record schema validator.
- `src/index.ts` is inert on purpose; no tool registration before phase 2.
