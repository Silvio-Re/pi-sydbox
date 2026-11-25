# Changelog

## [Unreleased]

- P0 fix the record (roadmap order P0; evidence
  `docs/evidence/p0-auto-deny-20261125/`):
  - The approval dialog now sends pi's actual dialog option, `timeout`
    (pi-coding-agent 1.6.0 `ExtensionUIDialogOptions`). It used to send
    `timeoutMs`, a key every mode ignores, so an unanswered deny prompt
    blocked the session forever and `AUTO_DENY_MS` was dead config.
    Measured headless: pi auto-resolves an unanswered select 120 070 ms
    after the request when 120 000 is sent (harness:
    `tools/rpc-dialog-probe/`). pi-web's browser-layer confirmation is
    roadmap item M3.
  - `KNOWN_FIELDS` covered the committed captures again: `fs`, `mode`,
    `oflags`, `rflags` and `proto` added, and a new strict-mode test parses
    every committed fixture line so the "captured" claim cannot drift.
  - Empty-glob denial paths (`/`, `/*`, `/**`…) can no longer round-trip
    into a blanket `allow/<cats>+/` grant: the mapper refuses them, and
    the grant store refuses empty or root targets independently.
  - The engine gate's self-check runs under a 10 s `spawnSync` timeout; a
    hang is a failed check (blocked, named), never a pass.
  - Record content (workload-chosen paths/addrs) can no longer forge
    prompt or notification lines: it is JSON-quoted, truncated, and framed
    by a constant line; line-break targets are refused outright instead
    of reaching any user-visible surface or the compiled profile.
  - A dual-spelling grant (bare + subtree rule) can now actually be
    stored at the project and global tiers: `applyGrant` stores each
    line, where the single-line store previously rejected the pair.
  - Doc staleness: README test count (119), `design.md` store-schema
    sentence, corpus `-P` engine examples (pinned 3.59.0 path),
    `KNOWN_FIELDS_VERSION` wording, `design.md` opening engine pin.
- Plan of record: `docs/ROADMAP.md` is the executable path from working
  adapter to a v1.0 usable by others from a fresh clone. Work is split
  into environment-bound orders (VM/CI agents vs the end-usage machine),
  each with tasks, a pass/fail gate and evidence requirements, plus a
  dependency ordering and a status ledger. Machine orders mark the
  landstrip golden-set capture (M1) as critical: it must be committed
  before phase 4 decommissions landstrip, and `make gate` cannot enforce
  equal-or-stricter without it. README layout updated.
- H1 (external review 2): the sandbox policy is no longer read from inside
  the confined tree. `loadPolicy` used to pick up `<cwd>/sandbox.json` or
  `<cwd>/agent_dir/sandbox.json`, so a cloned repo could ship a policy that
  disables its own confinement (`enabled:false`, `allowWrite:["/"]`)
  silently — the same attack class S2 closed for the legacy grant store.
  The policy now lives outside the workspace at `<state>/policy.json`
  (state dir already keyed per project); a workspace file is never read.
  When the state policy is missing and one exists in the workspace, the
  tool call is refused with the exact one-line `cp` command that adopts
  it — explicit opt-in, mirroring the S2 stance. `compileProfile` keeps
  honoring `enabled:false` only for the state file.
- H2 (external review 2): the grant pipeline now covers the record
  classes the real engine emits, verified against the committed captured
  fixtures (`test/fixtures/capture/*.jsonl`, previously unused by tests):
  array `cap` (e.g. `["read","write"]`) maps the union of its categories
  instead of drifting as unparseable; `mkdir`/`rmdir` map onto their
  engine-tip rule forms (`allow/mkdir+…`); `ctl`-only ioctl records
  surface as a notice (an ioctl deny offers no path to grant), never a
  silent skip.
- M1: a once-grant approved for a `!` command (user_bash path) lapses with
  that spawn, same as the bash tool path — previously the clear only ran
  on bash tool calls, so one "Allow once" persisted across every later
  `!`. C2's invariant now holds on both launch paths.
- M2: an unreadable or corrupt grant store (`grants.json`) is reported
  ("cannot be read … ARE NOT in effect — restore or delete the file")
  instead of silently continuing with an empty store; the changelog's
  earlier restore-notifies claim (D2… `safeGrants`) describing the same
  behavior was a naming error — the notify is real, the function name in
  the log entry was not.
- M3: the engine integrity gate now covers every engine the session can
  run, not just the source-build path: `gateEngine` resolves against the
  machine lock's recorded paths (`engine.path` *and*
  `sourceBuild.installedPath`) and hash-checks whichever matched. The lock
  now records `engine.binary.sha256` for the release path too — a
  swapped binary under any recorded name is refused; an engine the lock
  never recorded is refused by name ("not one the machine pin records").
- M4: `policyDenied` resolves a relative record `path` against the
  project root before comparing to deny roots — previously a relative
  denial inside a deny root would be offered as a grant, persisting a
  dead grant and re-prompting (the S3 loop, for the relative-path case).
- M5 (reproducibility): the machine-setup drivers are vendored under
  `tools/setup/` (build-libseccomp.sh, build-engine.sh, 03-smoke.sh,
  install.sh) together with the trust anchor `tools/syd-release.pub`, so
  the replay chain in `docs/environment.md` runs from the repository
  alone; the working copies under `agent_dir/spike/` stay as the live
  twins. Fixed the `2026-06-04` verification typo in `syd.lock` (it
  predates the project; the actual verification ran 2026-11-23) and the
  stale `minisign_verify.py` path references (the in-repo verifier is
  `tools/minisign-verify.py`).
- Minor: `initialLogOffset` seeds after the last complete line, so a
  mid-write crash tail completes and parses on the next session instead
  of being marked consumed mid-record. CI: actions pinned to commit
  SHAs, `permissions: contents: read`, `persist-credentials: false`,
  zizmor-clean; the shellcheck job covers `tools/setup/*.sh`.
  `weekly-check.sh` derives the bundled-pi path from the running `pi`
  binary (recorded path as fallback). design.md records three deliberate
  decisions: `allowWrite` grants `exec` on the same tree (TPE still
  guards), the deny-sink log has no rotation (revisit before any
  long-lived deployment), and `AUTO_DENY_MS` stays PROVISIONAL.
- S1 (external review): the record channel is no longer forgeable by the
  contained workload. The wrap shell opens the log append-only
  (`exec 3>>log`, `SYD_LOG_FD=3`) and the fd must stay inheritable across
  the engine's own execve — syd is launched by the same shell — so the
  seal happens one level down: the wrap owns the workload's first
  statement (`exec 3>&-`) and fd 3 is closed before any workload code
  runs; the engine (the parent, which never execs again) keeps writing
  records. Standing denies on the log path block every reopen including
  `/proc/self/fd/3` (syd checks the canonical path). The fd-forge verdict
  step pins the seal: the sealed workload cannot write fd 3, no forged
  bytes reach the sink, and engine records still flow. The control cell
  is diagnostic: syd 3.59.0 closes inherited fds for the workload itself
  (every control cell on host saw EBADF with no closer at all), so the
  closer is defense-in-depth on this engine and load-bearing on any that
  leaks instead. A first attempt that set FD_CLOEXEC in the wrap shell was
  rejected by that same probe: it blinded the engine's channel too
  (verdict 20261125-105950).
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
