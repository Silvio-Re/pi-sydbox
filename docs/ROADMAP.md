# Roadmap to v1.0

Plan of record for taking this repository from a working adapter to a final
product: **a stranger with a supported machine goes from `git clone` to
sandboxed pi following only this repository.** Written 2026-11-25 after a
three-part external assessment (code review, pi-web integration audit,
maintainability analysis). Nothing here replaces existing design: `design.md`
keeps the phased migration plan (its phases 3-5 are orders M4-M7 below);
this file sequences executable work orders on top of it and is the
coordination point between independent agents and the maintainer.

## Operating rules for workers

- The repository is the single source of truth and the common ground. Every
  order starts and ends here: read, work on a branch named after the order
  id, make the gate pass, update the Ledger, merge to main.
- One agent, one order, one commit series. Do not batch unrelated orders.
- Evidence-first: every enforcement or UX claim added to docs must link a
  file or log that is committed. `agent_dir/` is gitignored; nothing may cite
  it as proof.
- Gates are pass/fail. A failed gate stops the order: record the failure in
  the Ledger and stop; do not debug past a gate.
- CI must be green on the branch before merge (`npm run ci` and shellcheck,
  per `.github/workflows/ci.yml`).
- After finishing or failing: update the Ledger (status, evidence link,
  date), add a CHANGELOG `[Unreleased]` entry when the change is
  user-visible, merge.
- Environment constraint (verified, see `environment.md` Limits): the
  engine cannot run inside the landstrip sandbox (memfd write denied,
  rc=124/13). Any step that runs the engine happens in a plain Linux VM, a
  CI runner, or a plain terminal on the end machine, never inside a
  sandboxed pi session.

ENV column: `vm` = any autonomous agent in a Linux VM or CI runner;
`machine` = the end-usage machine only (human runs agent-supplied commands
in a plain terminal).

## v1.0 definition of done

1. Fresh-clone onboarding in at most 30 minutes following only the repo,
   verified on a machine that is not the author's (gate inside P3).
2. Every enforcement claim in the README links committed evidence;
   `make gate` is green and meaningful (equal-or-stricter on the D corpus).
3. pi-web UX verified in the soak: prompts render, auto-deny fires,
   budget holds, grants are auditable via CLI.
4. Contract tests plus the drift cron are live; the maintenance SOP is
   documented (kernel-band engine policy included).
5. This roadmap updated in place with shipped status and tagged v1.0.0.

## Orders

### P0 — fix the record (vm; no precondition)

Things that are silently wrong today. All small; all inputs verified in the
2026-11-25 assessment.

1. **Auto-deny is dead config.** pi's dialog option is `timeout`, not
   `timeoutMs` (pi-coding-agent 1.6.0, `src/core/extensions/types.ts`,
   `ExtensionUIDialogOptions`; RPC: `docs/rpc-extension-ui.md`). `dialog.ts`
   sends `{ timeoutMs }`, which every mode ignores: a denial prompt blocks
   until answered in both TUI and pi-web. Fix `UiPort`/`choose()` to send
   `timeout`, then run the never-executed measurement: drive pi in RPC mode
   with a small JSONL client, leave a `select` unanswered, observe the
   agent-side auto-resolve, and set `AUTO_DENY_MS` from the measurement.
   Replace the PROVISIONAL wording in `dialog.ts` and `design.md` with the
   measured value and where it was measured.
2. **Schema claim is false.** `KNOWN_FIELDS` says "syd 3.59.0 (captured)"
   but lacks `fs`, `mode`, `oflags`, `rflags`, all present in
   `test/fixtures/capture/*.jsonl`. Add the four fields and a test that
   parses every committed fixture in strict mode: strict must be clean on
   the repo's own captures.
3. **Empty-glob guard.** A denial whose path normalizes to only asterisks
   (`/*`, `/**`, `/***`) yields `allow/<cats>+` with an empty target.
   Reject empty targets in `recordToGrant` (return null) and in
   `appendGrant` (GrantStoreError).
4. **`gateEngine` timeout.** `spawnSync` for the engine self-check gets a
   10 s `timeout`; `error.timeout` is treated as a failed check (blocked,
   named reason), never as a pass.
5. **Untrusted record content.** Paths and addrs in `describeDenial` and
   the notify lines are chosen by the sandboxed workload. Escape or
   JSON-quote them, truncate long values, and add one constant framing
   line (record content is chosen by the contained process) so a crafted
   filename cannot forge notification lines or bait a tier choice.
6. **Doc staleness sweep.** README test count (95 is stale; use the live
   count), `design.md` phase-2 store-schema sentence conflicts with
   `store.ts`'s sibling-file decision, `corpus/README.md` shows `-m`
   examples while the verified form is `-P`, and the
   `KNOWN_FIELDS_VERSION` wording.

Gate P0: `npm run ci` green; the RPC harness log shows the select
auto-resolving at the measured `AUTO_DENY_MS`; strictly-clean fixture test
green.

### P1 — make the claims provable (vm; M1 required for the gate)

1. Verify the evidence handover: M1 has already landed the sanitized
   spike material in `docs/evidence/` (verdict logs, build records,
   probe scripts, the capture). After this order, `grep -r agent_dir
   docs src` may only return historical mentions, never citations as
   proof; fix any citation that remains.
2. Complete the D corpus per `design.md`: D7 stat existence leak, D8
   symlink in allowed dir pointing at a denied target, D9
   `/proc/self/root` traversal, D10 mmap MAP_SHARED on denied file, D11
   hardlink inside allowWrite at denied file, D12 rename across the
   allowed/denied boundary, D13 TOCTOU swap, D14 prompt storm. Case
   contract in `corpus/README.md`; each case prints one verdict.
3. Add a P-case read-posture probe: with an empty policy, attempt reads
   outside the allowlist (a home file) and document what the default
   denies; this pins the deny-by-default posture claim.
4. Write `make gate`: compare `results/<label>/summary.tsv` against the
   committed golden expectations (`expectations/*.tsv`, format in
   `expectations/README.md`), rule equal-or-stricter, fail on wider. Two
   case-integrity rules from M1 are part of the gate: (a) a deny verdict
   only counts when its engine record names the case's probed path —
   M1's first capture had two of three D verdicts measuring their own
   `/dev/null` redirect; (b) the D2 golden row is `deny` on both engines,
   not a differential (the 0.20.29 append bug did not reproduce; see ADR
   0002 and `expectations/README.md`): it still rejects a compiled
   profile that guards only truncation, but neither the golden row nor
   the gate may be cited as detecting an append bug.
5. Runner evidence: build the pinned engine on the CI runner with the
   repo's own scripts, run the whole corpus, commit the verdict tables
   labeled with the runner kernel. Runner evidence is per-kernel-band and
   complements, never replaces, the canonical 6.8 witness (M2).

Gate P1: `make gate` green against the golden set; every bypass probe
equal-or-stricter; both case-integrity rules enforced by the gate; no doc
cites gitignored paths as proof.

### P2 — contract the hosts (vm; after P0)

1. pi contract tests in CI: devDependency on the real
   `@earendil-works/pi-coding-agent`; assert `createLocalBashOperations`
   is an exported callable (it powers `user_bash`), assert the dialog
   options accept `timeout`, assert the event names `tool_call`,
   `tool_result`, `user_bash` exist in the API surface. A future
   `timeoutMs`-class break becomes a red build.
2. `docs/support-matrix.md`: kernel band vs engine (below 7.2 means
   3.59.0 source build; 7.2+ opens the release path), pi and pi-web
   versions verified, OS claims limited to what is tested.
3. Weekly drift cron (`.github/workflows/drift.yml`): poll crates.io,
   distfiles and the GitLab tags for syd; poll npm for
   `@earendil-works/pi-coding-agent` and `@agegr/pi-web`; on change, open
   an issue; on a new syd, best-effort download plus corpus run on the
   runner, verdicts posted in the issue. pi moves roughly weekly and syd
   roughly monthly (measured 2026-11-25); the goal is that nobody does this
   by hand.
4. Renovate or Dependabot for the two npm devDependencies and the
   SHA-pinned actions.

Gate P2: a drill on a branch that breaks one contract point turns CI red
before merge.

### P3 — clone-to-usable (vm; after P1 gate and P2.2)

1. `make setup` (wrapping the tools/setup scripts): detect the kernel
   band, run the release path (verify + install) or the source path
   (libseccomp + engine build), provision the machine lock (generate
   `~/.local/opt/syd.lock` from the repo lock with local paths plus the
   sha256 of the actually installed binary; the extension's gate then
   refuses any other engine), run the smoke, print the pi install next
   steps. Adds the currently undocumented `python3-cryptography`
   prerequisite.
2. README rewrite: at most 4 commands to a working sandbox, pi-web
   local-path plugin install, first-run walkthrough (first prompt, tier
   meanings, budget), refusal-message troubleshooting table, security
   caveat linking committed evidence.
3. Grants/policy CLI: `list`, `revoke`, effective-policy view, per project
   and global. No GUI in v1.0.
4. Agent-facing feedback: confirm the pi extension API's tool-result
   transform contract, then annotate a blocked or denial-bearing bash
   result with a one-line explainer; add a system-prompt section telling
   the model that denials need human grants and blind retries are futile.
   If the transform contract does not exist in the verified pi version,
   implement the system-prompt half only and record the limitation.
5. `/sydbox adopt` extension command: performs the policy copy on the
   user's explicit command (H1 preserved: adoption remains a human act);
   the manual `cp` stays in the refusal text.

Gate P3: a clean CI job that clones the repo fresh and follows only the
README reaches sandboxed bash with a working deny+prompt cycle (headless
via the RPC client); the 30-minute human measurement on a real second
machine trails this gate and lands in the Ledger.

### P4/M4-M7 — soak and decommission (machine; after P0 and P3)

M4 flip drills (twice), M5 soak (the design.md phase-3 gate: 5-7 days of
daily-driver work in pi-web with the checklist below), M6 AppArmor restore,
reboot and rollback drill (design.md phase 4, `runbook-rollback.md`), M7
landstrip decommission and weekly-check rewrite validation (design.md
phase 5). Soak checklist: prompts render in the browser, auto-deny fires
unattended, prompt budget holds, once-grants lapse per spawn, drift
notices appear, zero unexplained denials, no prompt storms. The soak
report lands in `docs/` (dates, counts, exceptions).

Gate P4: soak report committed; rollback drill executed once; landstrip
out of the runtime chain.

### P5 — release (vm; after P4)

Freeze the support matrix, write release notes, tag v1.0.0, update this
file's Ledger to shipped. Optional and maintainer's call: announce to the
syd and pi communities.

### M1 — landstrip golden capture + evidence handover (machine; CRITICAL)

**Deadline: before landstrip is decommissioned (M7). This is the only
machine order another order strictly depends on.** It cannot be recreated
later: the golden comparison baseline dies with the landstrip
installation, and `make gate` (P1.4) cannot enforce equal-or-stricter
without it.

Plain terminal, in the checkout:

1. Locate the phase-0 landstrip profile (migration directory, see
   `design.md` phase 0) and commit it as `corpus/profiles/landstrip.json`.
2. Capture the golden set with the corpus harness:
   `bash corpus/run.sh --label landstrip-golden --profile-template corpus/profiles/landstrip.json --engine-cmd "<landstrip binary> -p \$PROFILE_FILE --"`.
3. Convert `results/landstrip-golden/summary.tsv` into
   `expectations/*.tsv` rows per the format in `expectations/README.md`
   and commit.
4. Copy the spike evidence into the repo: verdict logs (including the
   fd-forge verdict `20261125-105950` and probe-19 verdict
   `20261124-221518`), the `<SYD-BUILD>` record, and the probe scripts the
   code comments cite, into `docs/evidence/`, with host paths sanitized
   consistently (record the sanitization rule in `docs/evidence/README.md`).

Gate M1: golden TSV and `docs/evidence/` committed and referenced by
docs; landstrip verdicts recorded for every existing D case.

State (2026-11-25): steps 1 and 4 are done — `corpus/profiles/landstrip.json`
with its reduction rationale in `docs/decisions/0002-corpus-profile.md`, and
`docs/evidence/m1-20261125/` holding the phase-0 policy, the engine identity,
the two cited verdict runs and the probes the tracked code comments cite.
Steps 2-3 are one handover: `bash agent_dir/spike/verdict.sh` runs every step
and captures the golden set last (`step_landstrip_golden`, probe
`agent_dir/spike/25-landstrip-golden.sh`), writing `expectations/landstrip.tsv`
and the sanitized `docs/evidence/m1-*/capture/`. It cannot be automated from an
agent session: `landstrip run` and `landstrip check` clone namespaces, which the
agent's own sandbox refuses. The step fails rather than records when every D
case allowed — such a capture would prove the deny rule inert, not the engine —
and it fails a deny whose engine record does not name the probed path.

The first capture (2026-11-25 14:30) was withdrawn: D1 and D3 were `deny` because
the case scripts' own `/dev/null` redirect was denied, so neither case ran the
operation it names, and the case scripts no longer redirect there. D2 came back
`deny` — the reported 0.20 append bug did not reproduce on 0.20.29 — so the
predicted `allow` in `design.md:95` was corrected against the record. Re-run
`bash agent_dir/spike/verdict.sh` to produce the rows and the capture.

Captured 2026-11-25 14:34 (`agent_dir/spike/logs/verdict-20261125-143439`):
D1, D2 and D3 all `deny`, each with a denial record naming `<scratch>/secret`,
so the rows in `expectations/landstrip.tsv` now measure the rule each case names.
D2 stays `deny` — the earlier "0.20 allowed the append" report did not reproduce.

### M2 — canonical kernel-band witness (machine; FOLDED into M6)

Folded 2026-11-25 to keep machine work to the strict necessary: this is
minutes of scripted plain-terminal work, M6's 4b step already re-runs the D
corpus green on the same 6.8 machine, and nothing on the board depends on
this row. No standalone machine session; the tasks ride the first machine
session that reaches a plain terminal (the soak can take them early, M6 4b
is the deadline): pedigree check via `bash tools/setup/03-smoke.sh
~/.local/opt/syd-3.59.0/syd`, a full corpus run committed labeled canonical
(kernel 6.8, pinned engine), and the `~/.local/opt/syd.lock` vs `syd.lock`
diff (paths and sha256).

### M3 — pi-web auto-deny confirmation (machine; FOLDED into M5)

Launch the daily pi-web, trigger one denial via a bash call, leave the
prompt unanswered, and observe the auto-deny (countdown if rendered).
Record the observed value in `docs/environment.md`; if the browser layer
diverges from the headless measurement, file it as a bug, not a doc
update.

Folded 2026-11-25 to keep machine work to the strict necessary: the soak
(M5) already must verify pi-web auto-deny (definition of done item 3), so
a standalone session duplicates it, and nothing on the board depends on
this row. The task above rides the soak session unchanged.

## Sequencing

Legend: lane-code P0 -> P2 -> P3; lane-evidence M1 -> P1 -> P1 gate ->
P3 README links.

- M1 first of all machine work (hard deadline, blocks P1's gate).
- P0 starts immediately and in parallel with M1; it needs nothing.
- P1 waits only on M1's files; P2 waits on P0 (0.1 feeds 2.1).
- P3 waits on the P1 gate (README links evidence that exists) and P2.2
  (the support matrix it points to).
- M2 and M3 folded into M6 and M5 respectively (no standalone machine
  sessions); M4/M5 after P3 (setup + README);
  M6 after M4; M7 last (destroying the golden source M1 preserved).
- Critical path: M1 and P0 in parallel, then P1, P3, M4-M7 soak, P5.

## Ledger

Update status to `doing`, `blocked (reason)`, `done (evidence link)` or
`failed (reason)`. `folded (into <order>)` closes an order whose tasks were
merged into another order's session. One row per order. Do not reorder rows.

| order | env | depends on | status | evidence |
| --- | --- | --- | --- | --- |
| P0 fix the record | vm | none | done (docs/evidence/p0-auto-deny-20261125/) | |
| M1 golden + evidence handover | machine | none | done (35144ce) | `expectations/landstrip.tsv`, `docs/evidence/m1-20261125/README.md` |
| P1 provable claims | vm | M1 | todo | |
| P2 host contracts and drift automation | vm | P0 | todo | |
| P3 clone-to-usable | vm | P1 gate, P2.2 | todo | |
| M2 kernel-band witness | machine | P0 | folded (into M6) | tasks listed in its order text |
| M3 pi-web auto-deny confirm | machine | P0.1 | folded (into M5) | tasks listed in its order text |
| M4 flip drills | machine | P3 | todo | |
| M5 soak | machine | M4, P0.1 | todo | |
| M6 AppArmor + reboot + rollback | machine | M4 | todo | |
| M7 decommission landstrip | machine | M5, M6 | todo | |
| P5 release v1.0.0 | vm | all above | todo | |

## Non-goals for v1.0

npm distribution, a pi-web grant panel, log rotation, macOS or non-Ubuntu
claims of support, automated grant decisions. Post-1.0 candidates: 7.2+
kernel-band validation on a newer guest, distribution packaging,
announcement.
