# pi-sydbox

> **Vibe-coded project.** This repository was written with an LLM agent
> driving the editor (ATDD, agent-run probes and verdicts). Do not blindly
> trust it: the enforcement claims rest on the committed evidence chain
> (`docs/evidence/`, sanitized records, each linked from the claim that
> cites it) — read it before relying on the sandbox —
> and re-verify on your own machine before using it to contain anything
> adversarial.

Replaces the `pi-landstrip` enforcement engine with [syd](https://sydbox.exherbo.org/)
(Landlock + seccomp-bpf + seccomp-notify), keeping the pi-side approval UX and the
existing `sandbox.json` policy artifact.

Status: **working adapter.** `src/` compiles a `sandbox.json` policy into a
syd profile (path ACL with deny-first ordering, fstype allowlist for mounts the
engine's fs guard does not know), places it on private storage (relocating off
mode-inert filesystems), wraps the pi `bash` tool in the engine, parses the
violation log, and turns each denial into an approval dialog with a stored
grant. 135 unit tests; the deny corpus and the implemented end-to-end probes
(3 of the planned 14, corpus/d) run green
against a pinned syd 3.59.0 built from source. Known constraint: launching
the engine inside an outer bash sandbox asks one interactive approval per run
(the engine seals itself through a memfd write the outer sandbox denies) — see
`docs/environment.md`.

## Clone to usable

Four commands, fresh clone to sandboxed bash (`make setup` is human-run, in
a plain terminal — never inside another sandbox):

```bash
sudo apt install build-essential pkg-config curl xz-utils python3-cryptography
git clone https://github.com/Silvio-Re/pi-sydbox && cd pi-sydbox
make setup          # engine per kernel band + machine lock + smoke + next steps
pi install ./pi-sydbox
```

On a kernel older than 7.2 `make setup` takes the source path and needs a
Rust toolchain (>= 1.88, via rustup) and ~4 GB RAM; it says so itself before
it starts. `python3-cryptography` is what `tools/minisign-verify.py` imports
(release path); the kernel-band rule itself is
[docs/environment.md](docs/environment.md) ("Engine, two paths"), and what is
actually verified on which band is [docs/support-matrix.md](docs/support-matrix.md).

**pi-web** (the browser UI) uses the same local configuration and session
files as `pi`, so the local-path install above is what it loads; plugin
packages can also be managed from its Settings panel. Start it with
`npx @agegr/pi-web` (its README documents the CLI). The pi-web-specific
verification (auto-deny countdown rendered in the browser) rides the M5 soak
(roadmap M3, folded) — it is marked pending in the support matrix, not claimed.

## First run, step by step

1. **Install pi's extension**: `pi install ./pi-sydbox` (documented in pi's own
   `docs/packages.md`: local-path packages). Everything below happens inside
   pi; nothing is enforced in a plain terminal.
2. **First prompt**: the first bash call a project's policy does not allow is
   denied by the engine and arrives as a dialog with four choices. The tiers,
   as actually implemented (not aspirational): **Allow once** — exactly the
   next spawn, gone after it; **Allow for this session** — pi's process
   memory, gone at exit; **Allow for this project** — the project's grant
   store (`~/.local/state/pi-sydbox/w-<slug>/grants.json`), survives restarts;
   **Allow always** — the global store. **Deny** or dismissing the dialog
   leaves the denial in place.
3. **Budget**: at most **4 prompts per tool result** (`PROMPT_BUDGET`,
   src/dialog.ts); further denials in the same batch are reported as a count
   and offered again on the next run. A dialog nobody answers auto-resolves
   as deny after **120 s** (`AUTO_DENY_MS`) — measured against pi 1.6.0
   headless: 120 070 ms observed
   ([docs/evidence/p0-auto-deny-20261125/](docs/evidence/p0-auto-deny-20261125/README.md)).
4. **What the model sees**: a denial-bearing bash result carries an appended
   one-line explainer, and the system prompt tells the model that denials
   need human grants and unchanged retries are futile (P3.4; the pi
   tool-result transform contract and `before_agent_start` are asserted
   against the pinned package in `test/pi-contract.test.ts`).
5. **Adopting a workspace policy**: a `sandbox.json` found inside the
   workspace is **never loaded from inside the confined tree** (H1: a fresh
   clone could ship itself the whole disk). The refusal names the fix; the
   human act is either the `/sydbox adopt` command (P3.5) or the manual
   `mkdir -p && cp` it prints. The approved copy lives outside the tree, in
   the per-project state dir.
6. **Inspecting what is in force**:
   ```bash
   node --experimental-strip-types src/cli.ts list            # stored grants
   node --experimental-strip-types src/cli.ts revoke 1        # remove one (by list index)
   node --experimental-strip-types src/cli.ts effective-policy  # the compiled profile
   ```
   `--global` targets the global store; the CLI reads and writes the same
   store, policy file and compiler the extension uses (`src/cli.ts`).

## Troubleshooting refusals

Every refusal names its cause; the recurring ones:

| pi-sydbox says | why | fix |
| --- | --- | --- |
| `no syd engine installed, refusing to run bash unsandboxed` | no usable engine, no machine lock | `make setup` |
| `machine lock <path> names <path>, which is missing or not executable` | the lock's engine is gone | reinstall the pinned engine (`make setup`) or remove the lock |
| `engine <path> is not one the machine pin records` / `engine binary hash mismatch` | a different or swapped binary under a known name | use the engine the lock recorded, or re-run `make setup` to re-pin what you actually installed |
| `engine self-check failed (rc=…)` / `timed out` | the binary fails `syd --check` | run `bash tools/setup/03-smoke.sh <engine>` in a plain terminal and read its output |
| `profile directory is group- or world-writable (…)` | the engine refuses non-private config (measured: umask 002 / shared-folder mounts, `docs/environment.md`) | the extension relocates the profile to `~/.cache/pi-sydbox/` automatically; if you still see it, fix the directory modes |
| `workspace sandbox.json … is never loaded from inside the confined tree (H1)` | policy in the confined tree would grant itself anything (H1) | `/sydbox adopt`, or the `cp` the message prints |
| `policy deny (sandbox.json) on <path>: no grant can lift it` | the path is denied by the adopted policy itself, by design | edit `sandbox.json`, re-adopt |
| bash exits with `Permission denied` inside a *setup or corpus* run | the engine cannot run inside an outer sandbox (memfd write denied, rc=124/13) | run engine steps in a plain terminal (`docs/environment.md`, Limits) |
| `pi-sydbox: <N> log line(s) not recognised (engine drift…)` | the engine's record format changed | do not upgrade silently; see the maintenance section of `docs/design.md` phase 5 |

## Security caveat

Read this before containing anything adversarial. Every claim links committed
evidence; nothing here rests on an unrecorded run:

- Enforcement is kernel-level only (seccomp/Landlock, no namespaces), and
  policy parsing fails closed (`docs/design.md`, invariants 1, 4, 5). The
  rule vocabulary and every engine-contract claim were reproduced on a real
  host and are recorded in
  [docs/environment.md](docs/environment.md) ("Engine contract as verified").
- The dialog layers are measured, not assumed: auto-deny at 120 s headless
  ([docs/evidence/p0-auto-deny-20261125/](docs/evidence/p0-auto-deny-20261125/README.md));
  deny verdicts on the golden corpus
  ([expectations/landstrip.tsv](expectations/landstrip.tsv), captured in
  [docs/evidence/m1-20261125/](docs/evidence/m1-20261125/README.md)).
- The engine-backed corpus + gate run on a machine that is not the author's
  is **pending** (roadmap Gate P3); until it lands, the end-to-end deny+prompt
  evidence is the author's machine only —
  [docs/support-matrix.md](docs/support-matrix.md) says exactly which band is
  verified and which is not.
- Grants never widen standing denies: policy denials compile after grants,
  an empty-glob or root grant is refused twice (mapper and store, P0), and
  once/session grants cannot be persisted at all (`src/store.ts`).
- The state dir, grant stores and profile directory carry standing denies
  against the sandboxed tree, so the workload cannot append itself a grant
  (`src/index.ts`, compile path); the approved policy lives outside the tree
  (H1, `loadPolicy`).

## Why

landstrip 0.21+ requires a KVM guest per process. On this host (a desktop VM
without nested virtualization) that path fails with
`INTERNAL_ERROR: unsupported guest exit`, and the 0.20.29 landlock+seccomp
build is unmaintained. syd gives kernel-level enforcement
with no hypervisor and no user namespace.

## Hard invariants

1. Kernel-level enforcement only: seccomp / Landlock. No `/dev/kvm`, no user namespaces.
2. `syd.lock` is the single pin: exact version, URL, sha512, signing key, installed path.
3. Namespace policy is an ADR outcome, not an assumption (`docs/decisions/0001-namespace-policy.md`); the golden-set corpus profile is likewise an ADR outcome (`docs/decisions/0002-corpus-profile.md`).
4. Policy parsing fails closed; ambiguous records are discarded toward deny and logged.
5. Deny by default on every dimension not explicitly granted.
6. Approval semantics follow landstrip's actual dialog, inventoried before implementing.
7. Missing or broken engine = refuse to start. Never silently unsandboxed.
8. Violation-record parsing validates the schema; lines it does not recognize
   are skipped and logged, never interpreted — and no parse outcome can weaken
   a deny.

## Layout

```
src/            extension modules (compiler, launcher, records, mapper, dialog,
                store, setup, cli) + the extension entry index.ts
test/           unit tests, node --test, TypeScript stripped at runtime
corpus/         probe cases, run.sh harness, engine profiles
expectations/   recorded decisions (golden set)
docs/           design.md, environment.md, support-matrix.md, decisions/,
                runbook-rollback.md, ROADMAP.md (plan of record to v1.0)
tools/          verify-artifact.sh, weekly-check.sh + drift-report.py,
                minisign-verify.py, syd-release.pub, rpc-dialog-probe/,
                setup/ (setup.sh, build-libseccomp.sh, build-engine.sh,
                03-smoke.sh, install.sh)
syd.lock        version + checksum + minisign pin (syd 3.59.0) + host-tool pins
```

## Quick start (development checks)

```
npm ci                      # once: dev deps incl. the pinned pi package
npm run ci                  # typecheck + node --test (the ci.yml commands)
make corpus ENGINE='...'    # run probe cases, see corpus/README.md
bash tools/weekly-check.sh  # maintainer drift check (WARN/OK lines)
cat syd.lock                # the pin: engine version, source tag, minisign key
```

## License

MIT for this repository. syd is GPL-3.0-only and is only ever spawned, never
linked or vendored; see `NOTICE`.
