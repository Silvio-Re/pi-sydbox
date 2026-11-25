# Changelog

## [Unreleased]

- S1 (external review): the record channel is no longer forgeable by the
  contained workload. `wrapCommand` opens the log with `exec 3>>log`, marks
  it close-on-exec, and passes `SYD_LOG_FD=3`; the child inherits no fd it
  can write records through (`fdappend` verdict step probes every shape).
  A denial record can now only come from the engine.
- S2: the legacy grant import from `<workdir>/agent_dir/.sydbox/grants.json`
  (pre-0.2 migration) no longer runs implicitly — a fresh clone of a repo
  that happens to ship that path could preload itself with permanent grants
  before the first prompt. Import is now opt-in via
  `PI_SYDBOX_IMPORT_LEGACY=1`, reads leniently (pre-0.2 stores have no `at`
  timestamp), and skips memory-tier entries instead of widening them to
  project.
- S3: a denial caused by an explicit `denyRead*`/`denyWrite*` line in
  `sandbox.json` can never be lifted by a stored grant (denies are compiled
  after grants, by design). Such records are reported as policy denials and
  never prompt — previously answering a prompt persisted a dead grant and
  the dedupe then suppressed every future prompt for that rule.
- D3: drift is no longer silent. `newDenials` counts lines it cannot parse
  and the result hook reports them once per batch; `parseLog`'s skipped
  counter is kept for the corpus tooling.
- C5: the machine lock is no longer advisory — `syd.lock` naming a missing
  or unusable engine now refuses to start (`LockedEngineError`, blocked
  bash) instead of silently upgrading to the newest unvalidated binary the
  version scan finds. An absent lock keeps the scan.
- D1: `tools/minisign-verify.py` is vendored in-repo (a fresh clone can run
  the full verification chain; `agent_dir/` is gitignored), and
  `tools/verify-artifact.sh` reports a missing verifier as a check gap,
  not as a failed signature (false tamper alarm).
- C1: the log-offset seed now counts in the same units `newDenials` stores
  them (UTF-16 code units of the decoded text, not `statSync().size`
  bytes); any non-ASCII record previously shifted the seed mid-line and
  silently skipped records for the whole session.
- C3: one `netRule` table (compiler and mapper previously drifted);
  bare-IPv6 policy entries no longer compile to corrupted rules, and
  mapper and compiler agree on `host!port`.
- C4: `readdir` and `fattr` in the compiler's read/write categories and the
  mapper's `CAP_CATS` (policy-allowed directories stay listable; a listing
  denial maps to an offerable grant instead of a dead end).
- C2: "allow once" is truly once — the once-grant leaves the profile at the
  next recompile, not at process exit.
- Legacy-driven fixes from the review wave:
  - The grant pipeline now works end to end: `appendGrant` rebuilds the
    profile in place (`rebuildProfile`, `src/index.ts`), so an approval
    takes effect on the next call in the same session instead of being
    inert until a new session. Tiers are real: `once` and `session` are
    memory-only (never persisted, process lifetime), `project` stays at
    the workdir store, `global` lives at `~/.local/state/pi-sydbox`
    (`src/store.ts`).
  - Tier semantics fixed: "allow for this session" previously persisted
    forever (≡ global) and "allow once" was compiled by nothing (dead
    choice). Both now behave as their names say; the dialog drops no
    silent no-op option.
  - The grant store and config are no longer workspace-writable targets:
    the state root moved to `~/.local/state/pi-sydbox/<workdir-slug>/`
    (`src/launcher.ts` `stateLayout`), and every compiled profile carries
    standing denies for the profile, grants and log paths
    (`compileProfile` self-protection lines), so a sandboxed workload
    cannot edit the config that will confine its next call.
  - The engine pin is enforced: `gateEngine` runs `buildSelfCheck` at
    startup (a failing self-check blocks the session), the resolver
    honors `SYD_PATH` the lock points to, and `tools/verify-artifact.sh`
    speaks only the fact-checked minisign instructions (gpg key text
    removed, `NOTICE` corrected).
  - Denial records: `type` is now a known field (`records.ts`), and the
    mapper emits BOTH the bare and the `/***` spelling when the denied
    path's kind is unknown (the captured 3.59.0 fixture carries no
    `type`); a single guessed spelling would re-prompt forever on the
    wrong kind. Typed records (`dir`/`reg`) get exactly their own
    spelling.
  - Cross-session prompt storms fixed: `logOffset` is seeded from the log
    size at session start (`index.ts`), so only new lines prompt, and
    denials whose rule is already granted are skipped (dedupe against
    memory + store).
  - Only `act === "deny"` used to prompt; `kill`, `abort`, `stop`, `panic`
    and `filter` events were dropped silently. `newDenials` now filters on
    the mapper's `DENIALS` set.
  - Batch resilience and budget: per-record try/catch in the result
    handler (one corrupt store entry fails its own prompt, not the
    batch), `safeGrants` corrupt-store corruption now notifies instead of
    silently dropping every stored grant, and the dialog has a prompt
    budget (`PROMPT_BUDGET = 4` per result, rest auto-denied with one
    notify).
  - `user_bash` (`!` commands) now run the same denial/gate path as tool
    calls; previously their denials could never reach a dialog.
  - `uiPort` accepts any function-shaped port (typeof check, not arity);
    a wrapped variadic `ui.select` used to auto-reject every prompt
    silently.
  - Type checking now exists: `tsconfig.json` (strict,
    `noUncheckedIndexedAccess`), `typecheck` and `ci` scripts
    (`package.json`), `.github/workflows/ci.yml` (unit + typecheck as a
    normal CI user, shellcheck on `corpus/run.sh` and `tools/*.sh`), and
    the strict pass surfaced and fixed real errors (`compiler.ts`
    unshare groups, `launcher.ts` `fsMagicOf` types, index-access
    guards).
  - Net grant rules no longer rewrite the address (`:`→`!` mangling
    corrupted IPv6); the rule passes the engine's own `host!port`
    spelling through unchanged.
  - Fixed: sandboxed writes into the shared-folder checkout were denied
    by the engine's filesystem sandbox on sight — syd 3.59.0 has no entry
    for that fstype in its `FS_MAGIC` table, so `statfs` magic
    `0x786f4256` fell to the default deny. `fsAllowFor` (`src/launcher.ts`)
    now collects the distinct statfs magics of the policy's allow targets
    (climbing to the nearest existing ancestor for paths that do not exist
    yet, dropping ext magics `include_profile` already allows) and the
    compiler receives those `allow/fs+0x<magic>` lines through its
    `extraAllows` slot; deny rules keep holding (probe 19: C1 granted,
    no-cure control C2 denied).
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
