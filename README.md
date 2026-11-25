# pi-sydbox

> **Vibe-coded project.** This repository was written with an LLM agent
> driving the editor (ATDD, agent-run probes and verdicts). Do not blindly
> trust it: the enforcement claims rest on the evidence chain in
> `agent_dir/spike/` and `docs/`, read them before relying on the sandbox —
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
grant. 95 unit tests; the deny corpus and the implemented end-to-end probes
(3 of the planned 14, corpus/d) run green
against a pinned syd 3.59.0 built from source. Known constraint: launching
the engine inside an outer bash sandbox asks one interactive approval per run
(the engine seals itself through a memfd write the outer sandbox denies) — see
`docs/environment.md`.

## Why

landstrip 0.21+ requires a KVM guest per process. On this host (a desktop VM
without nested virtualization) that path fails with
`INTERNAL_ERROR: unsupported guest exit`, and the 0.20.29 landlock+seccomp
build is unmaintained. syd gives kernel-level enforcement
with no hypervisor and no user namespace.

## Hard invariants

1. Kernel-level enforcement only: seccomp / Landlock. No `/dev/kvm`, no user namespaces.
2. `syd.lock` is the single pin: exact version, URL, sha512, signing key, installed path.
3. Namespace policy is an ADR outcome, not an assumption (`docs/decisions/0001-namespace-policy.md`).
4. Policy parsing fails closed; ambiguous records are discarded toward deny and logged.
5. Deny by default on every dimension not explicitly granted.
6. Approval semantics follow landstrip's actual dialog, inventoried before implementing.
7. Missing or broken engine = refuse to start. Never silently unsandboxed.
8. Violation-record parsing validates the schema; lines it does not recognize
   are skipped and logged, never interpreted — and no parse outcome can weaken
   a deny.

## Layout

```
src/            extension modules (compiler, launcher, records, mapper, dialog, store)
test/           unit tests, node --test, TypeScript stripped at runtime
corpus/         probe cases, run.sh harness, engine profiles
expectations/   recorded decisions (golden set)
docs/           design.md, environment.md, decisions/, runbook-rollback.md
tools/          verify-artifact.sh, weekly-check.sh, minisign-verify.py, syd-release.pub,
                setup/ (build-libseccomp.sh, build-engine.sh, 03-smoke.sh, install.sh)
syd.lock        version + checksum + minisign pin (syd 3.59.0)
```

## Quick start

```
make test                  # unit tests
make corpus ENGINE='...'   # run probe cases, see corpus/README.md
cat syd.lock               # the pin: engine version, source tag, minisign key
```

## License

MIT for this repository. syd is GPL-3.0-only and is only ever spawned, never
linked or vendored; see `NOTICE`.
