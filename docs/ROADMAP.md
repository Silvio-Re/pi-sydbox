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

## Open orders

### P2 — contract the hosts (vm; ready)

1. pi contract checks, local (per the CI policy): devDependency on the
   real `@earendil-works/pi-coding-agent`; assert
   `createLocalBashOperations` is an exported callable (it powers
   `user_bash`), assert the dialog options accept `timeout`, assert the
   event names `tool_call`, `tool_result`, `user_bash` exist in the API
   surface. A future `timeoutMs`-class break fails the local contract
   check before any merge.
2. `docs/support-matrix.md`: kernel band vs engine (below 7.2 means
   3.59.0 source build; 7.2+ opens the release path), pi and pi-web
   versions verified, OS claims limited to what is tested.
3. Weekly drift check, maintainer-run (per the CI policy): extend
   `tools/weekly-check.sh` to poll crates.io, distfiles and the GitLab
   tags for syd; poll npm for `@earendil-works/pi-coding-agent` and
   `@agegr/pi-web`; print a one-line available-vs-pinned report and
   stop. The maintainer runs it weekly or on demand; it opens no issues
   and triggers no runs by itself. pi moves roughly weekly and syd
   roughly monthly (measured 2026-11-25).
4. Renovate or Dependabot for the two npm devDependencies and the
   SHA-pinned actions.

Gate P2: a drill on a branch that breaks one contract point fails the
local contract check before merge.

### P3 — clone-to-usable (vm; after P1 and P2.2)

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
3. Grants/policy CLI: `list`, `revoke`, effective-policy view, per
   project and global. No GUI in v1.0.
4. Agent-facing feedback: confirm the pi extension API's tool-result
   transform contract, then annotate a blocked or denial-bearing bash
   result with a one-line explainer; add a system-prompt section telling
   the model that denials need human grants and blind retries are futile.
   If the transform contract does not exist in the verified pi version,
   implement the system-prompt half only and record the limitation.
5. `/sydbox adopt` extension command: performs the policy copy on the
   user's explicit command (H1 preserved: adoption remains a human act);
   the manual `cp` stays in the refusal text.

Gate P3: a machine that is not the author's clones the repo fresh and
follows only the README to sandboxed bash with a working deny+prompt
cycle (headless via the RPC client); the same machine runs the full
corpus plus `make gate`, and the verdict tables, labeled with its kernel
band, land in `docs/evidence/` (this run completes the P1 engine pass and
provides the second-band evidence); the 30-minute human measurement on a
real second machine trails this gate and lands in the Ledger.

### P4/ M4-M7 — soak and decommission (machine; after P0 and P3)

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

- Done: P0, M1, P1.
- P2 next; it needs nothing further. P3 waits on P1's deliverables and
  P2.2 (the support matrix the README will point to).
- M4-M7 machine sessions after P3 (setup + README done). M2 and M3 tasks
  ride M6 and M5 respectively. M7 last: it destroys the golden source
  M1 preserved.
- Critical path: P2 -> P3 -> M4-M7 soak -> P5.

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
| P2 host contracts and drift automation | vm | P0 | todo | |
| P3 clone-to-usable | vm | P1, P2.2 | todo | |
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
