# pi-sydbox — transition design

Replaces `pi-landstrip` 0.20.29 with the pinned syd 3.59.0 behind a local pi
extension (3.59.0, not the newer releases: syd 3.60.0 refuses startup below
Linux 7.2, and the environment kernel is frozen older; see `syd.lock` and
`docs/environment.md`).
Written 2026-11-23. Every phase below has a gate; no phase starts before the
previous gate passes. All probes run in a plain terminal, never inside an
existing sandbox.

## Target state

The landstrip enforcement binary is replaced by syd. pi-landstrip 0.20.29 stays
installed as a scripted fallback until phase 5. AppArmor returns to its stock
hardened state, which syd does not need.

## Invariants

1. Kernel-level enforcement only: seccomp / Landlock. No `/dev/kvm`, no user
   namespaces, no hypervisor. ptrace only if phase 0.5 proves it necessary.
2. `syd.lock` pins version, URL, sha512, signing key, installed path. Upgrades are
   staged through the corpus, never implicit.
3. Namespace policy decided by ADR 0001: variant A (no namespace option in the
   compiled profile) or variant B (mount namespace permitted, user namespace not).
4. Policy parsing fails closed: ambiguous records go to deny and to a discard log.
5. Deny by default on every dimension not explicitly granted.
6. Approval semantics replicate landstrip's dialog as inventoried from
   `~/.pi/agent/npm/node_modules/pi-landstrip/dist/index.ts`, not from memory.
7. Engine absent, unreadable or failing its self-check => bash and worker tools
   refuse to start. Never silently unsandboxed.
8. Violation records are schema-validated; unknown or missing fields are
   skipped toward deny and reported, never interpreted — and no parse
   outcome can weaken a deny. (A probe run treats the same drift as an
   abort — see "Abort conditions".)

Policied-surface decisions, made deliberately (external review 2):

- `allowWrite` on a tree also grants `exec` on that tree (compiler.ts): a
  build workspace must be able to run what it builds, and `PROFILE_LINUX`
  execs nothing under the tree on its own. TPE still refuses group-writable
  files, so the widening is bounded by what the agent itself wrote.
- The deny-sink log (`syd.log` in the state dir) has no rotation: it is
  re-read from the session offset on every tool_result and grows without
  bound. Acceptable for a per-project session log while sessions are
  short; revisit before any long-lived always-on deployment.
- `AUTO_DENY_MS = 120_000` is MEASURED (P0, 2026-11-25): pi-coding-agent 1.6.0
  honors the dialog `timeout` option; an unanswered deny prompt auto-resolves
  120 070 ms after the request in a headless RPC probe
  (docs/evidence/p0-auto-deny-20261125/). The pi-web browser-layer confirmation is the
  roadmap M3 item.

## Environment (verified 2026-11-23)

- Ubuntu 24.04.5, kernel 6.8.0-151-generic, Linux VM guest. Inert for syd: no
  KVM, no user namespace, ptrace of own children unaffected by Yama.
- Bundled pi-coding-agent 1.6.0. `ctx.ui.custom` and the "Custom UI / Dialogs"
  section exist in its `docs/extensions.md`; the dialog auto-resolve timeout is
  measured against it (P0, 2026-11-25, docs/evidence/p0-auto-deny-20261125/), and the
  extension sends the `timeout` option pi documents for dialogs.
- Current engine: `npm:pi-landstrip@0.20.29` (api 0.20.29 + binary 0.20.29). A
  hoisted `@landstrip/landstrip-linux-x64@0.22.0` is present and never executed.
- `~/.pi/agent/sandbox.json` is valid JSON and is an approved policy artifact, not
  corruption. Re-baselining is hygiene: strict parse, discard log, user-reviewed
  diff.
- landstrip-only relaxations, load-bearing until phase 5:
  - `~/.pi/agent_dir/landstrip-patch/fix-landstrip-artifact.sh`; any npm install
    under `~/.pi/agent/npm` undoes it.
  - `/etc/apparmor.d/unprivileged_userns`, whose `.orig` backup location is
    unverified (earlier notes cite `/root/`). Locate it in phase 0.
  - `kernel.apparmor_restrict_unprivileged_userns=0`, runtime only.
  - `/etc/apparmor.d/landstrip-userns` targets the wrong (hoisted) path; obsolete.
- Local landstrip clone `~/.pi/agent_dir/landstrip` at tag 0.20.12 for schema and
  glob conformance cases.

## syd facts

- Maintained (Ali Polatel, Morgane Glidic), GPL-3.0-only, ~293 crate releases,
  Landlock up to ABI 7, seccomp-bpf/notify, ptrace optional, user namespaces
  optional and off by default.
- 3.60.0 exists as distro packaging (Arch `extra/syd 3.60.0-1`, built 2026-11-21).
  crates.io latest is 3.59.0, so `cargo install --version 3.60.0` is not a valid
  fallback.
- Artifact URL unverified: `https://distfiles.exherbo.org/sydbox/` returns 404
  unauthenticated; upstream README points at `distfiles.exherbo.org/#sydbox/`.
  Phase 0.5 pins the real URL and sidecar name.
- A sha512 sidecar on the same host proves transport only. GPG verification
  against `distfiles.exherbo.org/sydbox/syd.asc` is required, not optional.
- Install to `~/.local/opt/syd-<version>/`, never symlinked into PATH.
- Log contract to confirm against `syd(5)`: record format (claimed JSON with
  ctx/cap/act/sys/path/tip) and the fd-diversion variable (claimed `SYD_LOG_FD`).

## Corpus

D = differential, identical policy on both engines; comparison rule "equal or
strictly stricter" against the landstrip golden decision.
P = deliberate policy changes, each with a rationale and a "wider by design"
marker; never compared to the golden set.

| id | probe | landstrip 0.20.29 |
|---|---|---|
| D1 | read a deny-globbed file | deny |
| D2 | append to a deny-globbed file | deny (0.20.29, captured; the older "allowed" report did not reproduce) |
| D3 | `rm` and `mv` of a deny-globbed path | deny |
| D4 | `ln` denied source to allowed target | deny |
| D5 | write `/proc/self/oom_score_adj` | deny + prompt shape |
| D6 | git HTTPS using `~/.netrc` | deny (`denyReadAlways`) |
| D7 | stat a denied path (existence leak) | to measure |
| D8 | symlink in allowed dir pointing at denied target | to measure |
| D9 | `/proc/self/root/<denied>` traversal | to measure |
| D10 | `mmap(MAP_SHARED)` write on denied file | to measure |
| D11 | hardlink inside allowWrite pointing at denied file | to measure |
| D12 | rename across the allowed/denied boundary | to measure |
| D13 | TOCTOU path swap after check | to measure |
| D14 | 30-path prompt storm | budget behaviour |

Pr7 (chromium headless) is a scheduled smoke test, not a gate.

Performance: median of 3 runs of `npm ls` in `~/.pi/agent/npm` and one docx build,
both engines. Threshold recorded before phase 3; exceeding it aborts the phase.

## Phases

### Phase 0 — inventory and snapshot

Host-specific material goes to `~/.pi/agent_dir/migration-landstrip-syd/`, outside
this repository.

1. Copy settings.json, npm package.json/lock, every sandbox.json, touched AppArmor
   profiles plus their real `.orig` locations, sysctl output, patch script, npm tree.
2. Document the executed-binary chain (`readlink -f /proc/1/exe` of a pi bash call,
   wrapper script, AppDirs) and the exact pin line.
3. Inventory landstrip's approval UX from `dist/index.ts`: option labels, persistence
   paths, hard-denial messages, worker pre-start prompt.
4. Strict-parse re-baseline of sandbox.json with discard log; user approves the diff.
5. Measure pi-web's dialog RPC timeout.

Gate: `.orig` located, approval UX documented, re-baseline diff approved, timeout measured.

### Phase 0.5 — feasibility spike (decides the design)

1. Pin and fetch the artifact; sha512 + GPG; unpack; `syd --check`.
2. Produce one real violation; dump the record; read `syd(5)` for log destination
   and schema.
3. Run `deny/read+<root>/secret` with every `unshare` disabled and no `bind` rule.
   It must deny. Repeat with a mount namespace and a `bind` rule to see whether
   variant B is even needed.
4. Bypass spot-check on the chosen variant: D7, D8, D9.

Gate: ADR 0001 accepted (variant A or B, observed denial, record sample attached),
or the design is reworked. No module is written before this gate.

### Phase 1 — standalone corpus

Run D1–D14 and the perf baseline against syd in a plain terminal. Record decisions
next to the golden set in `expectations/`.

Gate: `--check` green, every D probe equal-or-stricter, perf within threshold,
namespace invariant self-check passes.

### Phase 2 — build the extension

`compiler.ts` (sandbox.json to profile, fixed translation table, glob-class
coverage tests, namespace self-test), `launcher.ts` (pipe, dup2 to fd >= 3, log fd),
`records.ts` (schema-validated parser), `mapper.ts` (record to grant), `dialog.ts`
(state machine over `ctx.ui.custom`, timeout derived from the measured RPC budget,
budget and rerun limits flagged as deliberate additions), `store.ts` (approvals in
landstrip schema so the fallback reads them unchanged → superseded: grants live
in a sibling JSON file the engine owns, by design, so the two sandboxes share a
directory without schema interference — see the committed comment header of
`src/store.ts`), `index.ts` (tool gating,
invariant 7).

Gate: unit tests green, D-corpus differential green headless against pi 1.6.0.

### Phase 3 — staged cutover

1. Flip drill: `pi install ./pi-sydbox` <-> `pi install npm:pi-landstrip@0.20.29`,
   both sessions green, twice.
2. Scratch project through pi-web: all D probes via the real `bash` tool, every
   dialog choice, timeout, budget, rerun guard, perf threshold.
3. Daily-driver projects one at a time.

Gate: 1 day of real work (maintainer decision 2026-11-26, compressed from
5-7 days; the full roadmap soak checklist still applies), zero unexplained
denials, zero prompt storms.

### Phase 4a / 4b — restore AppArmor, reboot, prove rollback

Rollback decay: after 4b the landstrip fallback needs
`sysctl -w kernel.apparmor_restrict_unprivileged_userns=0` as root. That is the
documented rollback, not a single settings flip; `docs/runbook-rollback.md` sets the
sysctl first.

4a: restore the conffile from the verified `.orig`, reload, keep the sysctl at 0
until reboot, same-day green session. 4b: reboot, sysctl back to 1, session green,
D corpus green, re-run the flip drill, remove `/etc/apparmor.d/landstrip-userns`,
archive patch and rehearsal log.

### Phase 5 — decommission and maintenance

Uninstall the hoisted 0.22.0 and the npm pin; keep the landstrip clone as reference.
Maintenance contract: owner, three upgrade triggers (pi extension API, syd log
schema, syd CLI), upgrade procedure (new versioned dir, corpus + schema + perf in a
plain terminal, then move the path constant in `syd.lock`), weekly check script.

## Effort (agent time)

Measured in agent work, not human working days:

- Phases 0 + 0.5: ~1 session, ~15-25 tool calls, mostly verification commands.
- Phase 2 build: ~1,200-1,800 lines of TS; ~150-250 tool calls, ~4-6 hours of agent
  wall-clock, delivered as 2-3 sessions.
- Phase 1 and 3 gates: mostly waiting on real work and reboots; agent time per gate
  ~20-40 calls.
- Total agent wall-clock to phase 3 sign-off: ~6-10 hours, spread over 4-6 sessions.
  Human calendar time is dominated by the phase 3 soak (1 day since the
  2026-11-26 maintainer decision), not by agent work.
- Ongoing: ~30-60 agent calls per syd upgrade, ~5 per pi upgrade check.

## Abort conditions

Any D probe wider than golden; any record parse failure or unknown-field drift; any
prompt storm or budget misfire; missing checksum sidecar or failed signature; any
namespace option violating the ADR variant; perf beyond threshold; engine absent at
startup. Stop the phase, flip back if past phase 3, fix, replay the gate. Never
debug past a gate with production sessions.
