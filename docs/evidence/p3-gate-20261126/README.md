# P3 gate attempt (2026-11-26) — Stage A green, gate execution blocked

Machine: a fresh clone VM, not the author's. Kernel **6.18.35** (source band:
below 7.2, so `make setup` correctly took the 3.59.0 source path), 6.2 GB RAM,
Debian 13, rustc 1.100.0. Everything here was produced by following the
README's "Clone to usable" commands on that machine.

## What ran, and what it proves

| step | result | record |
| --- | --- | --- |
| `make setup` — band detection | classified 6.18.35 as the **source** band | `make-setup-run.txt` |
| libseccomp 2.6.0 build | sha256 matches `syd.lock` | `make-setup-run.txt`, `engine-build.txt` |
| engine 3.59.0 source build | **built from the pinned tag `v3.59.0`, commit `7e602aaf…` (the syd.lock commit), `--locked`, installed to `~/.local/opt/syd-3.59.0/syd`** | `engine-build.txt` (the `<SYD-BUILD>` block) |
| machine lock provisioning | `~/.local/opt/syd.lock` generated from the repo `syd.lock` with local paths + the built binary's sha256; the diff printed is exactly engine.path, engine.binary.sha256, sourceBuild.installedPath, sourceBuild.binary.sha256, +1 note | `machine-lock.txt` |
| `syd --check` | rc=0 (the engine binary starts and self-reports healthy) | `smoke.txt` |
| `syd -P <deny profile> -- cat <denied>` and the allow probe | **FAILED: `syd: exec error: Function not implemented`, rc=38, empty log fd** | `smoke.txt` |

## Why the gate is blocked on this machine

Every sandboxed exec — and the `-p off` unconfined control as well — exits
`ENOSYS` (38) on this host, while `syd --check` passes and the binary otherwise
runs. This is the documented class of failure `docs/environment.md` (Limits)
anticipates for engine runs inside a supervised host: the engine's child
setup (seccomp-unotify filter + emulated exec) does not survive an outer
sandbox layer. The shell of this VM runs inside the agent harness
(`NoNewPrivs: 1`, `CapEff: 0` on every process, `host.txt`), i.e. there is a
sandbox layer around the shell — exactly the precondition Gate P3 excludes.
It is not an engine-build condition (the build is complete and verified) and
not a policy condition (the failure is policy-independent: `-p off` fails
identically).

Recorded status: **Stage A delivered on this branch; Gate P3 blocked — gate
execution needs a machine with no sandbox layer around the shell** (a
plain-terminal host with >= 4 GB RAM). The corpus run, `make gate` and the
headless deny+prompt RPC round-trip were NOT executed and are NOT claimed;
this directory is the record of what did run.

## What the second machine still owes the roadmap

- The full corpus + `make gate` verdict tables labeled with the kernel band
  (this attempt adds a *second source-band machine* for the build path, not
  the >= 7.2 release band, which stays pending as before).
- The headless RPC deny+prompt+grant round-trip with a live engine.
- The 30-minute human measurement (trails the gate per the roadmap; not part
  of order P3).
