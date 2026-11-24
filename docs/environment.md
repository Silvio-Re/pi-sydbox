# Environment — machine prerequisites and engine build

A reinstated VM must reach the same engine from this repository alone. This file
lists what is installed on the machine, how the engine is obtained, and what is
pinned versus floating. Machine setup that is not specific to this project (guest
utilities, shared-folder mount, conda, fonts) stays in the owner's `Poste.md`.

## Prerequisites

```bash
sudo apt install build-essential pkg-config curl xz-utils
```

- `gperf` is required by the libseccomp `configure` step and is not installed
  here; `build-libseccomp.sh` builds it into the workdir, so no apt step is
  needed for it.
- `libseccomp-dev` (the apt package, 2.5.5 on this guest) is not enough to build
  engine 3.59.0: the link fails with `undefined symbol: seccomp_export_bpf_mem`,
  which upstream added after 2.5.5. The engine build therefore runs against a
  local libseccomp 2.6.0 (`agent_dir/spike/build-libseccomp.sh`). The apt package
  stays installed for `pkg-config` and for anything else wanting the system
  library.
- Rust toolchain through rustup (`~/.cargo/bin/cargo`), floor 1.88 as declared
  by the engine workspace's `rust-version`. Built here with `rustc 1.98.1`,
  `cargo 1.98.1`, rustup 1.29.1. A rebuilt machine installs stable and records
  whatever version it used in `syd.lock`.
- crates come from crates.io; `Cargo.lock` is in the engine tag, and the build
  passes `--locked`, so dependency versions are upstream's.
- `scdoc` is not needed: man pages are only built by `make`, not by
  `cargo build --release`.

## Engine, two paths

The signed release tarball and a source build are not interchangeable, because
the newest release refuses to start on older kernels.

| Host kernel | Engine | Where it comes from | Provenance |
| --- | --- | --- | --- |
| ≥ 7.2 | 3.60.0 release tarball | `https://distfiles.exherbo.org/sydbox/` | minisign signature, recorded in `syd.lock` |
| < 7.2 | 3.59.0 built from tag | `agent_dir/spike/build-engine.sh` | tag + commit + toolchain, recorded in `syd.lock` |

Why: engine 3.60.0 introduced `quiet/lock` and `log/lock` rules that require
landlock ABI 10, new in Linux 7.2, and the engine "fails at startup on older
kernels regardless" of the `default`/`lock` settings (upstream `ChangeLog.md`,
3.60.0 entry). On a kernel 6.x guest every `syd -P <profile> -- cmd` therefore
exits `EPERM` with an empty log fd, including commands the profile allows, while
`syd --check` still exits 0 because it only inspects the host. distfiles keeps no
older tarballs, so the older engine can only come from source.

### Release path (kernel ≥ 7.2)

```bash
# 1. put the tarball and its .sig in agent_dir/dist/
bash agent_dir/spike/02-verify.sh agent_dir/dist   # sha512 + minisign
bash agent_dir/spike/install.sh                    # -> ~/.local/opt/syd-<version>/syd
```

The signature is minisign, not OpenPGP: `gpg --verify` cannot succeed on it
whatever key is imported. `agent_dir/spike/minisign_verify.py` performs the
check (key id `b1e47bc29cc65132`, algorithm `Ed`).

### Source path (kernel < 7.2)

```bash
bash agent_dir/spike/build-libseccomp.sh 2.6.0   # ~15 s
env PKG_CONFIG_PATH=~/.local/opt/libseccomp-2.6.0/lib/pkgconfig \
    LIBSECCOMP_LIB_PATH=~/.local/opt/libseccomp-2.6.0/lib \
    LIBSECCOMP_LINK_TYPE=static \
    bash agent_dir/spike/build-engine.sh 3.59.0  # ~1m30 relink
```

The script checks the prerequisites above, clones the pinned tag, builds with
`--locked`, verifies the binary reports the requested version, installs it to
`~/.local/opt/syd-<version>/syd`, and prints a `<SYD-BUILD>` block holding the
commit, toolchain, feature set and checksums. Those values belong in `syd.lock`;
the block is the record, not a summary of one.

Re-running is cheap: a built tree and a matching installed binary are reused.
`--force` rebuilds, `--prefix` and `--workdir` relocate the output.

`cargo` writes its package cache and registry index into `CARGO_HOME`; the script
points that at `<workdir>/cargo-home` unless a writable `CARGO_HOME` is already
set, so the build never depends on the state of `~/.cargo`. The first run
downloads ~180 MB of registry index.

Measured on this guest: libseccomp 2.6.0 builds in 14 s, the relink against it in
1 min 30 s. The resulting binary reports `syd 3.59.0 (Take It Back)` with
features `-debug, +force, -kcov, +log, -oci, -trusted` and builds with the
workspace's `force`, `log`, `systemd`.

## What is pinned, what floats

| Item | State |
| --- | --- |
| engine source | pinned tag `v3.59.0`, commit recorded in `syd.lock` |
| engine dependencies | pinned by the engine's `Cargo.lock` (`--locked`) |
| engine features | default set recorded from `Cargo.toml` |
| rustc / cargo | floats; the version used is recorded, not enforced |
| `libseccomp` | built from source 2.6.0, sha256 recorded in `syd.lock` |

To reproduce a build bit-for-bit, force the recorded toolchain:
`RUSTUP_TOOLCHAIN=1.98.1 bash agent_dir/spike/build-engine.sh 3.59.0 --force`.

## Replay checklist

1. `sudo apt install build-essential pkg-config curl xz-utils`
2. confirm the toolchain: `rustc --version` ≥ 1.88
3. `bash agent_dir/spike/build-libseccomp.sh 2.6.0`
4. build the engine with the environment from *Source path* above
5. compare its `<SYD-BUILD>` sha256 with the one in `syd.lock`
6. `bash agent_dir/spike/03-smoke.sh ~/.local/opt/syd-3.59.0/syd`, in a plain
   terminal (see *Limits*)

## Engine contract as verified

Every item below was reproduced on this host against the engine built here. The
script or corpus log in parentheses is the evidence.

Profile files:

- **The name must end in `.syd-3`.** `syd -P /tmp/deny.profile` exits 95
  (`EOPNOTSUPP`) and logs nothing to fd 3 except one record with
  `ctx=parse_config_file` and the tip "use file extension `syd-3`". The rename is
  the fix; nothing else about the file was wrong.
- **A group-writable file is refused.** Under umask 002 a `cp`-created file is
  0664 and `syd -P` exits 1 with `Error: LinuxError: EPERM` before reading a rule.
  0600 and 0644 load. Every profile written by the adapter or the corpus is
  `chmod 600` (`09-perm-order.sh`).
- **`-P /dev/null` exits 77**, a third refusal class, so a bare exit code
  distinguishes "untrusted file" (1) from "not a regular file" (77) from "wrong
  extension" (95).
- **The parent directory must be trusted as well.** `sandbox.rs:10699` refuses a
  profile whose directory carries group or world write bits: `../profiles` at
  `0775` yields the same `Error: LinuxError: EPERM`, rc=1, and an empty log even
  though the file itself is `0600`. The message names neither the file nor the
  directory, so the symptom is indistinguishable from a rejected rule. `mkdir`'s
  mode applies only on creation, which is how an existing `0775` directory stayed
  invisible until `strace` showed `statx` on the parent followed by the refusal;
  under umask 002 `mkdir -p` gives `0775` while `mktemp -d` gives `0700`, which is
  why the corpus never hit it. `writeProfile` now sets `0700`, verifies, and
  throws naming the path. On a host shared-folder mount the check can never
  pass at all: the mount forces modes from its options (`dmode=0770`,
  `fmode=0660`) and `chmod` is a no-op, so the directory stays `0770`, the
  file `0660`, and
  failing closed blocks every bash call with `profile directory is group- or
  world-writable (770)`. The extension therefore keeps only the **profile** on
  guest disk — `placeProfile` probes the work directory and, when it cannot be
  made private, writes under `~/.cache/pi-sydbox/<hash of the work dir>/profiles`
  — while the log and the grant store stay in `agent_dir/.sydbox/`, where the
  engine imposes no mode rule.

Rule vocabulary (`src/config.rs:2385`, `PROFILE_LINUX`):

- Categories are `lpath` (traverse), `npath` (lookup), `rpath` (read), `wpath`
  (write), `cpath` (create), `tpath` (truncate), `exec`, `readdir`, `mktemp`,
  `fattr`. An earlier template used `read,stat,write`; those names never appeared
  in a working rule, and the denials that made them look effective were Landlock
  denials, which happen regardless of the rule's spelling.
- Globs: `**` is two levels, `***` is the root plus everything beneath at any
  depth (`/tmp/**` for files, `/tmp/***` for recursive). `PROFILE_LINUX` relies
  on this distinction.
- A later rule overrides an earlier one. The engine's own profile denies
  `/lib*/modules/***` directly after allowing `/lib*/***`, which is the pattern a
  blacklist profile copies: base allowlist first, denies last.
- **A path needs both spellings; neither covers both kinds.** `**` is two levels,
  so a bare `<dir>` grants the entry and leaves every child denied (looks like
  "the allow was ignored"), while `<file>/***` matches nothing at all (a deny
  silently does not apply: the denied file reads fine, rc=0). A policy path does
  not say which kind it is, and the adapter must not `stat` targets, so
  `toSydGlobs` emits `<path>` and `<path>/***` for every policy entry. The mapper
  is not guessing: the denial record carries `type` (`reg`/`dir`), so a rebuilt
  grant uses the bare path for a file and the subtree for a directory — a wrong
  choice there would re-prompt forever.

Confinement layers:

- **Landlock is on by default** (`src/config.rs:1969`, "default unless
  feature(trusted)"). `PROFILE_LINUX` ships no `lock/` rules, so its Landlock
  layer is an empty allowlist that denies every path. The symptom is
  `syd: exec error: Permission denied`, rc=13, and an **empty** log — Landlock
  denials are not logged, seccomp ones are. `sandbox/lock:off` placed **after**
  the include fixes it.
- **A per-path blacklist is therefore seccomp-only by construction.** Landlock
  only expresses allowlists, so "everything except X" cannot be built from it.
  Landlock stays off in both corpus templates for that reason, not for speed.
- **The filesystem sandbox denies every access on an unknown fstype.** syd
  3.59.0's `FsType::from_name` table (`src/compat.rs`) has no entry for the
  mount's fstype, so `statfs` there reports `0x786f4256`, a magic the engine
  does not know: every create/write on the share is denied even when a
  path rule allows it, and the deny record (`"fs":2020557398`) even suggests a
  path rule in its `tip`, which is inert. `from_name` parses integers first
  (`str2u64` accepts `0x`), so the magic can be allow-listed by value:
  `allow/fs+0x786f4256` restores the compiled path policy on the share without
  weakening any deny (probe 19: C1 granted vs the no-cure control C2 denied;
  verdict 20261124-221518). `fsAllowFor` (`src/launcher.ts`) collects the
  distinct statfs magics of the policy's allow targets — climbing to the
  nearest existing ancestor for paths that do not exist yet and dropping the
  ext family `include_profile` already allows — and `src/index.ts` feeds those
  lines to the compiler's `extraAllows` slot, before the denies.
- **Trusted path execution is on** and blocks exec of a group-writable file:
  `ctx=trusted_path_execution`, "exec from untrusted path blocked: user in
  untrusted group and file group-writable", tip to use `sandbox/tpe:off`. Under
  umask 002 `chmod +x` yields 0775 and trips it; `chmod 0755` does not. The corpus
  keeps TPE on and sets the mode instead (`corpus/run.sh`).
- **Exec from the scratch root needs an explicit rule.** `PROFILE_LINUX` allows
  `/tmp/**` for read/write/create/truncate but not for `exec`, so case scripts
  die as `syd: exec error` until the profile adds
  `allow/lpath,npath,rpath,wpath,cpath,tpath,exec,readdir+@ROOT@/***`.

Working shape (`corpus/profiles/syd-a.profile`, verified by `03-smoke.sh` and
the corpus):

```text
include_profile linux
sandbox/lock:off
allow/lpath,npath,rpath,wpath,cpath,tpath,exec,readdir+@ROOT@/***
deny/lpath,npath,rpath,wpath,cpath,tpath+@ROOT@/secret
```

Results on this host: allow probe prints `plain` with rc=0 and an empty log; deny
probe prints `Permission denied` with rc=1 and one seccomp record carrying
`cap=read, act=deny, sys=openat` and a `tip` naming the allow rule that would
permit it. The corpus reports `deny` for all three cases with no errors. Case
`d03` denies on the **read** that its copy/move performs, not on an `unlink` of
the secret, so path-level `unlink` blocking is still unproven.

A profile produced by `src/compiler.ts` is verified end to end
(`14-compiled-profile.sh`): the write inside `allowWrite` lands and
`denyReadAlways` refuses with rc=1, both from one compiled file. `15-bisect`
separates the profile shapes: a bare directory rule does not grant its contents,
`dir/***` does, and a deny on a file is enforced.

Other:

- **`load` and `include_profile` exist in 3.59.0** (syd.5 line 87 and 89): rules
  can be loaded from a descriptor at runtime, so the approval path does not wait
  for 3.60.
- **Expected EPERMs, not symptoms:** `prctl(PR_SET_SECUREBITS)` and
  `ptrace(PTRACE_SEIZE)` fail unprivileged. Enforcement works anyway; they only
  limit the force/trace paths.
- `-p off` runs unconfined (rc=0) and is the control that separates "engine cannot
  start" from "policy denied the command". `-p linux` on this host is denied
  everywhere, because of the default-Landlock item above.

## Limits

- The build workdir defaults to `${TMPDIR:-/tmp}/pi-sydbox-build`, which does not
  survive a reboot. That is deliberate: the installed binary in
  `~/.local/opt/` is the durable artifact, and the script rebuilds the rest.
- Building on the shared-folder checkout is avoided on purpose (thousands of
  small writes); keep the workdir on a local filesystem.
- The engine cannot be smoke-tested from inside a landstrip session: the child
  engine writes its in-memory exec image to `/memfd:syd`, the host sandbox
  denies that write, and cases then time out (`rc=124`) or fail with `EACCES`
  (`rc=13`). `--version` and `--check` work because they start no child. Engine
  runs are a plain-terminal step, as `syd.lock` already notes for 3.60.0.
