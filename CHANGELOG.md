# Changelog

## [Unreleased]

- tools/gate-session.sh: one-command runner for the scripted part of the
  gate machine session (P4 section of docs/ROADMAP.md). From a fresh
  clone it captures everything mechanical: preflight, maintainer-engine
  backup, the make setup drill (elapsed time = the onboarding metric,
  method recorded), npm ci, the headless RPC probe, corpus + gate with
  the installed distro engine (p3-gate-distro) and with the backed-up
  maintainer binary (m6-canonical, the M2 witness), the machine-lock
  diff, the AppArmor/sysctl snapshot, and a packed evidence tarball.
  `--phase-4b` reruns the post-reboot verification; `--skip-setup`
  reuses a provisioned engine. The sudo/reboot (design.md phase 4), the
  flip drill sessions and the soak remain human steps by design. The RPC
  probe README's invocation now uses absolute paths (the harness runs
  pi with cwd inside --work; relative paths fail, verified 2026-11-26).
- P6 distro engine path (roadmap order P6; the 6.x-band default becomes a
  pinned third-party binary, the source build becomes the fallback).
  Engine execution is NOT claimed anywhere in this change: agent surfaces
  cannot host the engine (docs/environment.md, Limits, two measurements
  dated 2026-11-26); the real drill runs on the maintainer's 6.8 machine.
  - syd.lock gains a `distroBuild` section: the pinned Arch
    `syd-3.59.0-1-x86_64` package (package sha256 + extracted usr/bin/syd
    sha256, packager, fetchedAt) with notes recording exactly what it is —
    a third-party build, NOT the maintainer build (`db994415…`), trusted by
    pinned bytes (the Arch PGP .sig optional and documented, not enforced),
    x86_64 only, and the feature difference recorded, not hidden
    (`+oci`, no `+systemd`).
  - tools/setup/install-distro.sh: cache-first download, package sha256 AND
    extracted-binary sha256 verified, fail closed on either mismatch
    (nothing written into the prefix), only usr/bin/syd installed, a
    deterministic launcher wrapper beside it, idempotent re-runs; the
    --version banner is best-effort because agent surfaces cannot execute
    the engine.
  - tools/setup/setup.sh: on the 6.x band the default is libseccomp 2.6.0 +
    the distro install (no rustup needed); the launcher decision is the
    exec wrapper — the distro binary links libseccomp.so.2 dynamically
    (ldd: libseccomp.so.2, libc.so.6, libgcc_s.so.1) and needs >= 2.6.0,
    which Ubuntu-class hosts do not ship (apt 2.5.5 lacks
    seccomp_export_bpf_mem), so the wrapper prepends the locally built one
    uniformly instead of probing each host for a bare run. The source build
    moves behind --build-from-source (make setup SETUP_ARGS=--build-
    from-source); non-x86_64 hosts fall back to source with a note; the
    >= 7.2 release path is unchanged. The machine lock pins the wrapper in
    `engine` and the REAL binary in `distroBuild`.
  - src/setup.ts + test/setup.test.ts: buildMachineLock/machineLockDiff
    extended for the distroBuild section (with a guard so the distro path
    cannot overwrite the sourceBuild record — the wrapper path shares the
    `syd-<version>/syd` suffix); write-lock gained --distro-binary.
  - docs: environment.md's "Engine, two paths" became "Engine acquisition"
    (>= 7.2 upstream release / < 7.2 distro default / source fallback)
    and gained the Limits row "no agent surface can execute the engine";
    support-matrix.md carries the engine provenance rows; README's 6.x
    story says the default needs no rustup (zstd joined the apt line); the
    roadmap records P6 as an open order, the P3 gate fold into M6
    (maintainer decision 2026-11-26, not-the-author clause waived) and the
    P6 ledger row.

- P3 clone-to-usable (roadmap order P3; Stage A delivered, Gate P3 blocked on
  the gate machine's sandboxed shell — exact condition and evidence below):
  - `make setup` (tools/setup/setup.sh wrapping the existing setup scripts):
    kernel-band detection (src/setup.ts, the docs/environment.md rule), the
    release path or the libseccomp+engine source path, machine-lock
    provisioning (~/.local/opt/syd.lock from the repo syd.lock with local
    paths + the installed binary's sha256), the 03-smoke, and the pi install
    next steps; the python3-cryptography prerequisite is named up front. The
    band parser, lock generator and lock differ are unit-tested against the
    committed syd.lock. A real second machine (kernel 6.18, source band)
    ran it end to end: engine built at the pinned tag and commit,
    `docs/evidence/p3-gate-20261126/`.
  - README rewritten for clone-to-usable: four commands to sandboxed bash, a
    first-run walkthrough (prompt, the four tiers with their actual
    persistence, the 4-prompt budget, the measured 120 s auto-deny), a
    refusal-message troubleshooting table, and a security caveat whose every
    claim links committed evidence. docs/support-matrix.md is linked as the
    sibling doc, not duplicated.
  - Grants/policy CLI (src/cli.ts: `list`, `revoke`, `effective-policy`,
    per project and global) reading and writing the same grant store, policy
    file and compiler the extension uses; `removeGrant` lives in src/store.ts
    next to appendGrant so there is one store implementation. No GUI.
  - Agent-facing feedback: pi 1.6.0's tool_result transform contract EXISTS
    (ToolResultEventResult, "can modify result"), so a denial-bearing bash
    result is annotated with a one-line explainer (content appended, never
    replaced, keeping structuredContent valid); before_agent_start's
    systemPromptOptions.promptGuidelines carries the sandbox guidance (denials
    need human grants, unchanged retries are futile). No limitation to record —
    all three pi surfaces are asserted in test/pi-contract.test.ts.
  - `/sydbox adopt` extension command (registerCommand, which exists in pi
    1.6.0): performs the sandbox.json -> state-dir policy copy on the explicit
    command only; re-adopt is refused, `/sydbox status` reports the adopted
    policy. The manual cp stays in the H1 refusal text.
  - Engine-build portability fix found by the gate run: tools/setup/build-engine.sh
    died with rc=141 (SIGPIPE under `set -o pipefail`) because `syd --version
    | head -1` cuts the pipe while syd still writes; the whole output is now
    captured and the first line taken afterwards.
  - Gate P3 is BLOCKED, not failed-and-hidden: the gate machine built the
    engine but every sandboxed exec there exits ENOSYS rc=38 (also with -p
    off) because its agent-harness shell is itself supervised — the exact
    "no sandbox layer around the shell" precondition the gate names. The
    corpus run, make gate and the headless RPC round-trip were NOT executed
    and are not claimed. Evidence: docs/evidence/p3-gate-20261126/; recorded
    in docs/environment.md (Limits) and the roadmap Ledger.

- P2 contract the hosts (roadmap order P2; evidence: the Gate P2 drill under
  `docs/evidence/p2-contract-drill-20261126/` and the drift run
  `docs/evidence/p2-drift-report-20261126.txt`):
  - The real `@earendil-works/pi-coding-agent` is an exactly-pinned
    devDependency (1.6.0, no range: pi releases roughly weekly), and
    `test/pi-contract.test.ts` asserts the extension's three host-contract
    points against that shipped package: `createLocalBashOperations` is an
    exported callable (runtime), the dialog options accept `timeout` and
    reject `timeoutMs` (type-level, fails `npm run typecheck`), and the
    `tool_call`, `tool_result` and `user_bash` events exist in the API
    surface (type-level). A future pi upgrade that breaks any point fails
    `npm run ci` before merge; the committed drill shows each break failing
    and the untouched branch green (122 tests / 0 fail).
  - `docs/support-matrix.md` records what is supported with per-row evidence
    links (kernel band vs engine, pi 1.6.0, pi-web 0.18.0, the tested OS); the
    >= 7.2 kernel band is explicitly pending until Gate P3. Host-tool pins
    (pi 1.6.0, pi-web 0.18.0) are recorded in `syd.lock` (`hosts`).
  - `tools/weekly-check.sh` gained a network drift section
    (`tools/drift-report.py`): one available-vs-pinned line per source — syd
    on crates.io, the GitLab tags and distfiles, `@agegr/pi-web` and the npm
    devDependencies — baselines from `syd.lock` and `package.json` only. It
    is read-only (opens no issues, triggers nothing), and an unreachable
    network is one WARN line, not a crash.

- P1 provable claims (roadmap order P1; evidence: the committed corpus,
  gate and case-integrity tooling; the engine-backed corpus + gate run
  lands at the P3 gate machine, roadmap P1.5):
  - The D corpus is complete: d04-d14 join d01-d03, covering the design.md
    rows D4-D14 (hardlink of a denied source, `/proc/self/oom_score_adj`
    write, git HTTPS with `~/.netrc`, stat existence leak, symlink toward
    a denied target, `/proc/self/root` traversal, `mmap` MAP_SHARED,
    hardlink inside the writable tree with a write-through, rename across
    the boundary, TOCTOU swap, and a 30-operation engine storm). Each D
    case declares its probe paths with `# probe:` lines, and a deny
    without an engine record naming one of them fails the gate — the M1
    `/dev/null` lesson is now enforced by tooling instead of discipline.
  - `make gate` replaces the Makefile stub: it compares a run's
    `summary.tsv` against the committed golden rows with the
    equal-or-stricter rule (golden rows exist only where a capture
    produced them; D cases without a row still have to classify —
    timeout, engine-error and error never pass). corpus/p cases are never
    compared. The D2 row is compared like any other golden row and the
    tool's output says nothing about append behavior: the row is a
    regression baseline, and the d02 case itself is what rejects a
    truncation-only profile.
  - `make capture` runs the corpus and emits a candidate golden TSV
    through `tools/golden-tsv.sh` (`--run` adds the same probe-record
    check to captures), so a regeneration is two tracked make targets and
    nothing cites a gitignored spike for it any more.
  - corpus/run.sh builds out-of-grant fixtures (a private `$HOME`
    directory holding the d06 netrc and the p01 probe file) and starts a
    loopback HTTPS git server for d06; it records the run's actual
    `CASE_ROOT`/`CASE_OUT_HOME`/`CASE_NETRC_PORT` in
    `results/<label>/case-env`, from which the gate re-derives probe
    paths.
  - p01 read-posture probe (corpus/p): a policy that grants only the
    scratch root denies a read outside it — the deny-by-default claim is
    now pinned to a measured verdict.
  - Citations cleaned: every instruction or proof citation in docs now
    points at a committed file (README before-you-trust pointer,
    environment.md release-path commands, the corpus profile-permission
    comment, the expectations regeneration section); agent_dir paths
    remain only as functional paths and marked history.
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
- M1 (landstrip golden capture) prepared, minus the capture itself, which
  needs the real engine in a plain terminal. Committed: the corpus profile
  `corpus/profiles/landstrip.json` and its reduction rationale (ADR
  `docs/decisions/0002-corpus-profile.md`), `tools/golden-tsv.sh` (summary.tsv
  to golden rows, refusing rows the harness could not classify),
  `tools/sanitize-evidence.sh` (host-path sanitizing for committed evidence),
  the `docs/evidence/m1-20261125/` record (phase-0 policy, engine identity,
  the two cited verdict runs, the probes tracked code comments reference), and
  a `landstrip-golden` step in `agent_dir/spike/verdict.sh` that runs the
  capture, writes `expectations/landstrip.tsv` and copies the sanitized
  capture into the evidence directory. The step fails a capture in which every
  D case allowed: that means the deny rule is inert, and committing those rows
  would freeze "landstrip denies nothing" into the baseline.
- The first golden capture (2026-11-25 14:30) was withdrawn rather than
  committed. D1 and D3 reported `deny` because the case scripts' own
  `>/dev/null` redirect was denied by a profile that grants nothing outside the
  scratch root, so neither case ran the operation it names; the three cases in
  `corpus/d/` no longer redirect to `/dev/null`, and the capture step now fails a
  deny whose
  engine record does not name the probed path. D2 came back `deny` — the
  reported landstrip 0.20 append bug did not reproduce on 0.20.29 — so the D2
  row in `docs/design.md` and the text in `expectations/README.md` record the
  measurement instead of the prediction. The re-run at 14:34 produced the three
  rows now in `expectations/landstrip.tsv`, each with a denial record on the path
  its case names — the check the capture step now enforces.
- `tools/golden-tsv.sh` writes the note column from the case script's header
  summary line only: the D cases carry the full explanation of what each one
  once measured wrongly, and a golden file with those paragraphs inline stopped
  being readable as a table.
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
