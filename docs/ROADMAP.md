# Roadmap to v1.0

Plan of record for taking this repository from a working adapter to a final
product: **a stranger with a supported machine goes from `git clone` to
sandboxed pi following only this repository.** Nothing here replaces
existing design: `design.md` keeps the phased migration plan (its phases
3-5 are orders M4-M7 below); this file sequences executable work orders on
top of it and is the coordination point between independent agents and
the maintainer.

## How this repo is worked

Three layers are kept apart on purpose:

1. **Product environment requirements** (kernel bands, engine provenance,
   toolchain, build limits): canonical in `docs/environment.md`. This file
   restates them only as far as sequencing needs.
2. **System design and code claims**: `docs/design.md`, the ADRs under
   `docs/decisions/`, and the code and tests. Enforcement claims link
   committed evidence.
3. **Agent coordination facts** (how autonomous agents work on this repo):
   only the subsections below, and never mixed into the product docs.

### Repository rules

- The repository is the single source of truth and the common ground.
  Every order starts and ends here: read, work on a branch named after
  the order id, make the gate pass, update the Ledger, merge to main.
- One agent, one order, one commit series. Do not batch unrelated orders.
- Evidence-first: every enforcement or UX claim added to docs must link a
  file or log that is committed. `agent_dir/` and `results/` are
  gitignored; durable evidence lives under `docs/evidence/`, and nothing
  may cite a gitignored path as proof.
- Gates are pass/fail. A failed gate stops the order: record the failure
  in the Ledger and stop; do not debug past a gate, and never tune a case
  or an expectation to make a gate pass.
- After finishing or failing: update the Ledger (status, evidence link,
  date), add a CHANGELOG `[Unreleased]` entry when the change is
  user-visible, merge.

### Checks and automation (maintainer decision 2026-11-26: git stays simple)

- GitHub Actions are disabled on this repository; GitHub runs nothing.
- `.github/workflows/ci.yml` stays in the repo only as the definition of
  the check commands (`npm run ci`, shellcheck on the workflow's file
  set). They must pass locally before merge; the worker records the
  counts in the PR.
- Recurring checks live as maintainer-run scripts under `tools/`.
  Re-enabling or adding any automation requires an explicit maintainer
  decision.

### Agent surface notes (coordination constraints, not product facts)

- Repository write access is the GitHub API surface (file push, PR,
  merge). There is no ref deletion on it: branches are deleted by the
  maintainer in the UI or from a git-capable client. Close finished
  orders with a squash merge so debugging history never lands on main.
- File edits through that surface are full-file writes. While an order is
  open on its branch, nobody else edits the files it touches: a
  full-content push from elsewhere can silently revert the branch's
  work. Wait for the merge or coordinate through the maintainer.
- ENV column: `vm` = any autonomous agent in a Linux VM; `machine` = the
  end-usage machine only (a human runs agent-supplied commands in a
  plain terminal).

## v1.0 definition of done

1. Fresh-clone onboarding in at most 30 minutes following only the repo,
   verified on a machine that is not the author's (gate inside P3).
2. Every enforcement claim in the README links committed evidence;
   `make gate` is green and meaningful (equal-or-stricter on the D corpus).
3. pi-web UX verified in the soak: prompts render, auto-deny fires,
   budget holds, grants are auditable via CLI.
4. The local pi contract checks and the maintainer-run drift check pass;
   the maintenance SOP is documented (kernel-band engine policy included).
5. This roadmap updated in place with shipped status and tagged v1.0.0.

## Completed orders (records)

### P0 — fix the record: DONE (PR #1, merge commit e051b4b)

The dialog option is pi's real `timeout`, not `timeoutMs`, with the
measured auto-deny: 120 070 ms observed at 120 000 requested (headless
RPC harness `tools/rpc-dialog-probe/`). `KNOWN_FIELDS` covers all five
fields present in the committed captures (`fs`, `mode`, `oflags`,
`rflags`, `proto`), with a strict-mode fixture test that keeps the
"captured" claim honest. Empty-glob denial targets are refused by both
the mapper and the grant store. The engine self-check runs under a 10 s
timeout; record content is JSON-quoted, truncated and framed. A stale-doc
sweep fixed the README count and conflicting wording. Evidence:
`docs/evidence/p0-auto-deny-20261125/`.

### M1 — landstrip golden capture: DONE (35144ce; ledger 2026-11-25)

`expectations/landstrip.tsv` records the landstrip 0.20.29 verdicts for
D1-D3 (all `deny`, each with an engine record naming the probed path).
Sanitized capture, probe scripts and both cited verdict runs live under
`docs/evidence/m1-20261125/`; the corpus profile reduction rationale is
ADR 0002. The first capture was withdrawn: the cases' own `/dev/null`
redirects were what got denied. That defect is why
`expectations/README.md` carries the two case-shape rules (no redirects
in the command under test; a deny needs a record on the probed path) and
why the capture step enforces them. Regeneration procedure:
`expectations/README.md`.

### P1 — provable claims: DONE (PR #2, squash-merged d899865)

The D corpus is complete: d04-d14 join d01-d03 per the design table,
plus the p01 read-posture probe. `make gate` (`tools/gate.sh`) compares
run summaries against `expectations/*.tsv` with equal-or-stricter
semantics and enforces the two case-integrity rules
(`tools/case-integrity.sh`, shared with the capture step). The
agent_dir citation sweep repointed every proof at committed paths. The
d06 netrc case and the harness TLS git server were fixed (pkt-line
lengths, Content-Length) and the allow path validated end to end. The
deferral (P1.5): the engine-backed corpus + gate run happens on the P3
gate machine (Gate P3), because VMs under a ~1 GiB RAM cap cannot build
the engine at all (`docs/environment.md`, Limits). Local checks at
merge: 119 tests / 0 fail, shellcheck clean on the ci.yml file set.

### P2 — contract the hosts: DONE (2026-11-26)

The real `@earendil-works/pi-coding-agent` 1.6.0 is an exactly-pinned
devDependency, and `test/pi-contract.test.ts` asserts the three
host-contract points against the shipped package (import-only; pi is
never launched from the test): `createLocalBashOperations` is an exported
callable (runtime), the dialog options accept `timeout` and reject the
historical `timeoutMs` (type-level), and the `tool_call`, `tool_result`,
`user_bash` events exist in the API surface (type-level) — a type-level
break fails `npm run typecheck`, the first half of `npm run ci`.
`docs/support-matrix.md` records the supported surface row by row with
evidence links; the >= 7.2 kernel band is explicitly pending Gate P3.
`tools/weekly-check.sh` gained a read-only network drift section
(`tools/drift-report.py`): one available-vs-pinned line per source
(syd on crates.io, the GitLab tags, distfiles; the npm packages and the
repo devDependencies), baselines from `syd.lock` and `package.json`
only; an unreachable network is one WARN line, not a crash. Installing
the real package flipped one existing `user_bash` test onto its intended
real-package path (pi's backend destructures its options argument),
fixed by passing the object pi always supplies. Gate P2 passed: the
drill under `docs/evidence/p2-contract-drill-20261126/` breaks each
contract point against the pinned package one at a time and captures
`npm run ci` failing each time, plus the final green run (122 tests /
0 fail, shellcheck clean on the ci.yml file set). A real drift run is
committed as `docs/evidence/p2-drift-report-20261126.txt`.

### P3 — clone-to-usable: STAGE A DONE, GATE BLOCKED (2026-11-26)

Stage A is delivered in full. `make setup` (tools/setup/setup.sh) wraps the
existing setup scripts and adds what the order asked: kernel-band detection
(src/setup.ts, unit-tested), the release or source path per band, machine-lock
provisioning (~/.local/opt/syd.lock from the repo syd.lock plus the installed
binary's sha256, so the extension's gate refuses any other engine), the
03-smoke, the pi install next steps, and the python3-cryptography
prerequisite. The README was rewritten clone-to-usable: four commands, a
first-run walkthrough (prompt, the four tiers' actual persistence, the
4-prompt budget, the measured 120 s auto-deny), a refusal troubleshooting
table and an evidence-linked security caveat; docs/support-matrix.md is the
sibling doc. The grants/policy CLI (src/cli.ts: list, revoke,
effective-policy; project and global) shares the extension's store, policy
and compiler — one implementation, no second source of truth; `removeGrant`
lives in src/store.ts. pi 1.6.0's tool_result transform contract EXISTS, so
denial-bearing bash results carry a one-line explainer (append-only,
structuredContent preserved) plus the before_agent_start prompt guidelines;
`/sydbox adopt` (registerCommand, which exists in 1.6.0) performs the H1
policy copy on the explicit command, with /sydbox status beside it and the
manual cp still in the refusal text. No pi-API limitation had to be
recorded — the three surfaces are asserted in test/pi-contract.test.ts.

The gate run surfaced and fixed one portability defect: build-engine.sh
died rc=141 (SIGPIPE under pipefail) cutting `syd --version | head -1`.

Gate P3: BLOCKED, not failed in content — a second machine (kernel 6.18,
source band, Debian 13, 6.2 GB RAM, not the author's) followed the README:
band detection, libseccomp 2.6.0 and the engine at the pinned tag and commit
built, machine lock provisioned, `syd --check` green. But every sandboxed
exec on that VM exits ENOSYS rc=38 — including the `-p off` control — because
its agent-harness shell is itself a supervised sandbox layer, the exact
precondition the gate excludes (docs/environment.md, Limits; the same class
as the landstrip rc=124/13 blocker). The corpus run, `make gate` and the
headless RPC deny+prompt+grant round-trip were NOT executed and are NOT
claimed. Evidence: docs/evidence/p3-gate-20261126/. The supervisor arranges
the gate on an unsandboxed machine; the second-band (>= 7.2) evidence and
the P1 engine pass still land with that run.

MAINTAINER DECISION 2026-11-26: the gate folds into the M6 canonical
session on the author's 6.8 machine — the not-the-author clause of Gate P3
is WAIVED (an agent surface cannot host the engine at all, measured twice
and recorded in docs/environment.md, Limits, so waiting for a second
unsandboxed machine adds nothing the M6 run cannot deliver). The gate tasks
(deny+prompt RPC cycle, full corpus + make gate, verdict tables labeled
with the kernel band) are executed there as part of the M6 session, and
the 30-minute human measurement still trails it.

### P6 — distro engine path: DONE (PR #6, squash-merged as 509f7ac, 2026-11-26)

The 6.x-band default is now the pinned third-party binary (Arch
`syd-3.59.0-1-x86_64`): `syd.lock` `distroBuild` records the URL, package
sha256 `6d33c68f…`, extracted-binary sha256 `700585cd…`, packager and the
feature difference vs the maintainer build (`+oci`, no `+systemd`).
`tools/setup/install-distro.sh` fails closed on either sha mismatch and
installs the binary behind a deterministic exec wrapper (the binary links
libseccomp.so.2 dynamically and needs >= 2.6.0, which Ubuntu-class hosts do
not ship; setup builds 2.6.0 locally as before). The source build is the
documented fallback (`--build-from-source`, automatic on non-x86_64), with
the same-prefix distro pair replaced deterministically first, fixing the
build-engine.sh idempotence interaction found while testing. The machine
lock records the real binary beside the wrapper (`src/setup.ts
--distro-binary`). Supervisor verification is in the merge commit:
typecheck clean, 138 tests / 0 fail, shellcheck clean on the ci.yml set,
distroBuild hashes cross-checked against independent measurements of the
real artifact, installer functionally verified including a tamper negative
test (exit 1, nothing written). No engine execution claimed or performed
(agent surfaces cannot host the engine — environment.md, Limits).

## Open orders

### P4/ M4-M7 — soak and decommission (machine; after P0 and P3)

M4 flip drills (twice), M5 soak (the design.md phase-3 gate, 1 day of
daily-driver work in pi-web with the full checklist below — maintainer
decision 2026-11-26, compressed from 5-7 days), M6 AppArmor restore,
reboot and rollback drill (design.md phase 4, `runbook-rollback.md`), M7
landstrip decommission and weekly-check rewrite validation (design.md
phase 5). Soak checklist: prompts render in the browser, auto-deny fires
unattended, prompt budget holds, once-grants lapse per spawn, drift
notices appear, zero unexplained denials, no prompt storms. The soak
report lands in `docs/` (dates, counts, exceptions).

Gate P4: soak report committed; rollback drill executed once; landstrip
out of the runtime chain.

The scripted part of the machine session is `tools/gate-session.sh`
(maintainer decision 2026-11-26: do not offload mechanical work to the
human). From a fresh clone: `bash tools/gate-session.sh` runs preflight,
the maintainer-engine backup, `make setup` (elapsed time recorded as the
onboarding metric, method "scripted drill"), `npm ci`, the headless RPC
probe, corpus + gate with the installed distro engine (label
`p3-gate-distro`), the M2 canonical smoke + corpus + gate with the
backed-up maintainer binary (label `m6-canonical`), the machine-lock diff
and the AppArmor/sysctl snapshot, then packs an evidence tarball. After
the reboot, `bash tools/gate-session.sh --phase-4b` verifies the sysctl
and reruns corpus + gate. The human tail stays human: phase 4a/4b sudo +
reboot (design.md phase 4, `runbook-rollback.md`), the M4 flip drill
sessions, and the 1-day M5 soak.

#### M2 — canonical kernel-band witness: FOLDED into M6

No standalone machine session. The tasks ride the first machine session
reaching a plain terminal (the soak can take them early, M6 4b is the
deadline): pedigree check via `bash tools/setup/03-smoke.sh
~/.local/opt/syd-3.59.0/syd`, a full corpus run committed labeled
canonical (kernel 6.8, pinned engine), and the `~/.local/opt/syd.lock`
vs `syd.lock` diff (paths and sha256).

#### M3 — pi-web auto-deny confirmation: FOLDED into M5

No standalone machine session; the tasks ride the soak. During the soak,
launch the daily pi-web, trigger one denial via a bash call, leave the
prompt unanswered, observe the auto-deny (countdown if rendered), and
record the observed value in `docs/environment.md`; if the browser layer
diverges from the headless measurement, file it as a bug, not a doc
update.

### P5 — release (vm; after P4)

Freeze the support matrix, write release notes, tag v1.0.0, update this
file's Ledger to shipped. Optional and maintainer's call: announce to the
syd and pi communities.

## Sequencing

- Done: P0, M1, P1, P2. P3: Stage A done and merged; its gate folds into
  the M6 canonical session on the author's 6.8 machine (maintainer decision
  2026-11-26, not-the-author clause waived — agent surfaces cannot host
  the engine, docs/environment.md Limits).
- P6 lands BEFORE the M6 session: the canonical witness and the gate runs
  must exercise the 6.x-band default (distro path), not a path M6 would
  then replace. The P4 soak is independent of P6 and may run before or
  after it.
- M4-M7 machine sessions after the M6-folded P3 gate lands. M2 and M3
  tasks ride M6 and M5 respectively. M7 last: it destroys the golden source
  M1 preserved.
- Critical path: P6 -> M6 canonical session (carries the P3 gate) -> M5 soak
  -> P5.

## Ledger

Update status to `doing`, `blocked (reason)`, `done (evidence link)` or
`failed (reason)`. `folded (into <order>)` closes an order whose tasks
were merged into another order's session. One row per order. Do not
reorder rows.

| order | env | depends on | status | evidence |
| --- | --- | --- | --- | --- |
| P0 fix the record | vm | none | done (docs/evidence/p0-auto-deny-20261125/) | |
| M1 golden + evidence handover | machine | none | done (35144ce) | `expectations/landstrip.tsv`, `docs/evidence/m1-20261125/README.md` |
| P1 provable claims | vm | M1 | done (PR #2, squash-merged d899865) | `corpus/d/` + `corpus/p/`, `tools/gate.sh` + `tools/golden-tsv.sh` + `tools/case-integrity.sh`, `expectations/`; engine-backed corpus + gate run lands at Gate P3 |
| P2 host contracts and drift automation | vm | P0 | done (docs/evidence/p2-contract-drill-20261126/, docs/evidence/p2-drift-report-20261126.txt) | `test/pi-contract.test.ts`, `docs/support-matrix.md`, `tools/weekly-check.sh` + `tools/drift-report.py`, `syd.lock` (`hosts`) |
| P3 clone-to-usable | vm | P1, P2.2 | stage A done and merged; gate folded into the M6 canonical session (maintainer decision 2026-11-26, not-the-author clause waived) — execution pending that session; the blocked-gate evidence stays at docs/evidence/p3-gate-20261126/ | `tools/setup/setup.sh` + `src/setup.ts` + `test/setup.test.ts`, `src/cli.ts` + `test/cli.test.ts`, README, `test/pi-contract.test.ts` (transform + prompt + command surfaces), `docs/evidence/p3-gate-20261126/` |
| M2 kernel-band witness | machine | P0 | folded (into M6) | tasks listed in its order text |
| M3 pi-web auto-deny confirm | machine | P0.1 | folded (into M5) | tasks listed in its order text |
| P6 distro engine path | vm | P3 (Stage A) | done (PR #6 squash-merged as 509f7ac; supervisor verification in the merge commit) | `syd.lock` (`distroBuild`), `tools/setup/install-distro.sh`, `tools/setup/setup.sh` (`--build-from-source`), `src/setup.ts` + `test/setup.test.ts` |
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
