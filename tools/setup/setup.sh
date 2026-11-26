#!/usr/bin/env bash
# setup.sh — the one-command machine setup; wrapped by `make setup`.
# Human-run, in a plain terminal, outside any sandbox (agent surfaces
# cannot host the engine at all — docs/environment.md, Limits).
#
#   make setup
#   bash tools/setup/setup.sh [--lock-out ~/.local/opt/syd.lock] [--build-from-source]
#
# Engine acquisition (docs/environment.md, Engine acquisition — P6):
#   Linux >= 7.2 : the 3.60.0 signed upstream release (verify + install).
#   Linux < 7.2, x86_64, default: the pinned third-party 3.59.0 distro binary
#                  (tools/setup/install-distro.sh) plus the locally built
#                  libseccomp 2.6.0 behind a launcher wrapper. No rustup.
#   Linux < 7.2, --build-from-source (or non-x86_64): the 3.59.0 source build
#                  (libseccomp + engine build, rust >= 1.88, ~4 GB RAM).
#
# What it does, in order:
#   1. detect the kernel band (src/setup.ts)
#   2. acquire the engine per the policy above
#   3. provision the machine lock (~/.local/opt/syd.lock) from the repo
#      syd.lock with local paths plus the sha256 of the installed binary
#      (and, on the distro path, the real binary's sha256 beside the wrapper's)
#   4. run tools/setup/03-smoke.sh against the installed engine
#   5. print the pi install next steps
#
# Prerequisites beyond the repo's own tooling (Node 22, python3):
#   sudo apt install build-essential pkg-config curl xz-utils
#   sudo apt install python3-cryptography   # tools/minisign-verify.py imports it
#   Rust toolchain >= 1.88 via rustup (source path only)
# Nothing here is automated on GitHub: this is a human-run script.
#
# Exit: 0 the machine ended with a smoked engine and a machine lock;
# 1 a step failed (fix and re-run — every step is idempotent); 2 usage.
set -uo pipefail

repo_root=""
lock_out="$HOME/.local/opt/syd.lock"
build_from_source=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --lock-out) lock_out="${2:?--lock-out needs a value}"; shift 2 ;;
    --build-from-source) build_from_source=1; shift ;;
    -h|--help)
      sed -n '3,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      printf 'unknown argument: %s\n' "$1" >&2
      exit 2
      ;;
  esac
done
repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
cd "$repo_root" || exit 1

fail() { printf 'setup: %s\n' "$1" >&2; exit 1; }

# --- prerequisites this script itself runs on --------------------------------
command -v node >/dev/null 2>&1 || fail "node (22) is required (npm ci; the dev checks)"
command -v python3 >/dev/null 2>&1 || fail "python3 is required (lock handling, minisign verification)"
if ! python3 -c "import cryptography" >/dev/null 2>&1; then
  fail "python3-cryptography is missing — sudo apt install python3-cryptography (tools/minisign-verify.py imports it; without it a release-path install downgrades to sha512-only verification)"
fi

# --- 1. kernel band ----------------------------------------------------------
release="$(uname -r)"
band="$(node --experimental-strip-types src/setup.ts band --release "$release")" \
  || fail "cannot classify kernel '$release' — decide the band manually (docs/environment.md, Engine acquisition)"
printf '== kernel %s -> %s path ==\n' "$release" "$band"

# --- 2. engine ---------------------------------------------------------------
if [ "$band" = "release" ]; then
  version="$(python3 -c "import json;print(json.load(open('syd.lock'))['version'])")"
  printf '== release path: verifying and installing syd %s ==\n' "$version"
  bash tools/verify-artifact.sh || fail "artifact verification failed (network? run tools/verify-artifact.sh yourself and follow its hints)"
  bash tools/setup/install.sh --src agent_dir/cache --dest "$HOME/.local/opt" \
    || fail "install failed — see the <SYD-INSTALL> block above"
  engine="$HOME/.local/opt/syd-$version/syd"
  distro_binary=""
else
  version="$(python3 -c "import json;print(json.load(open('syd.lock'))['sourceBuild']['version'])")"
  libseccomp_version="$(python3 -c "import json;print(json.load(open('syd.lock'))['sourceBuild']['libseccomp']['version'])")"
  arch="$(uname -m)"
  if [ "$build_from_source" -eq 0 ] && [ "$arch" = "x86_64" ]; then
    printf '== distro path (6.x-band default, no rustup needed): libseccomp %s then the pinned 3.59.0 distro binary ==\n' "$libseccomp_version"
    bash tools/setup/build-libseccomp.sh "$libseccomp_version" || fail "libseccomp build failed"
    bash tools/setup/install-distro.sh || fail "distro engine install failed (see the <SYD-DISTRO-INSTALL> block above)"
    # Launcher decision (P6): the distro binary links libseccomp.so.2
    # dynamically (ldd: libseccomp.so.2, libc.so.6, libgcc_s.so.1) and needs
    # >= 2.6.0, which Ubuntu-class hosts do not ship (apt carries 2.5.5, and
    # 2.5.5 lacks seccomp_export_bpf_mem). A deterministic exec wrapper
    # prepends the locally built 2.6.0 and execs the real binary, uniform
    # across the band; a bare run would only work on hosts that already
    # carry >= 2.6.0, so the wrapper is the decided launcher. The machine
    # lock hashes the real binary either way (distroBuild section).
    engine="$HOME/.local/opt/syd-$version/syd"
    distro_binary="$HOME/.local/opt/syd-$version/syd.bin"
  else
    if [ "$build_from_source" -eq 0 ]; then
      printf '== arch %s: the pinned distro binary is x86_64-only — falling back to the source build ==\n' "$arch"
    else
      printf '== source fallback requested (--build-from-source) ==\n'
    fi
    printf '== source path: libseccomp %s then engine %s ==\n' "$libseccomp_version" "$version"
    printf '    (the engine build needs ~4 GB RAM; a ~1 GiB-capped VM cannot build it at all — docs/environment.md, Limits)\n'
    command -v cargo >/dev/null 2>&1 || command -v "$HOME/.cargo/bin/cargo" >/dev/null 2>&1 \
      || fail "cargo (rustup, >= 1.88) is required for the source build"
    # The distro pair may sit at the same prefix (same version, same syd
    # path): build-engine.sh's idempotence check greps the INSTALLED binary's
    # --version banner, and the distro wrapper would satisfy it, silently
    # keeping the third-party binary under a source-build request. A source
    # build replaces the distro install deterministically.
    if [ -f "$HOME/.local/opt/syd-$version/syd.bin" ]; then
      printf '    (replacing the distro install at the same prefix with the source build)\n'
      rm -f -- "$HOME/.local/opt/syd-$version/syd" "$HOME/.local/opt/syd-$version/syd.bin" \
        || fail "cannot remove the distro install at $HOME/.local/opt/syd-$version"
    fi
    bash tools/setup/build-libseccomp.sh "$libseccomp_version" || fail "libseccomp build failed"
    env PKG_CONFIG_PATH="$HOME/.local/opt/libseccomp-$libseccomp_version/lib/pkgconfig" \
        LIBSECCOMP_LIB_PATH="$HOME/.local/opt/libseccomp-$libseccomp_version/lib" \
        LIBSECCOMP_LINK_TYPE=static \
        bash tools/setup/build-engine.sh "$version" || fail "engine build failed (see the <SYD-BUILD> block above)"
    engine="$HOME/.local/opt/syd-$version/syd"
    distro_binary=""
  fi
fi
[ -x "$engine" ] || fail "expected engine binary $engine is missing or not executable"
printf '== engine: %s ==\n' "$engine"

# --- 3. machine lock ---------------------------------------------------------
if [ -n "$distro_binary" ]; then
  node --experimental-strip-types src/setup.ts write-lock \
    --repo-lock syd.lock --engine "$engine" --distro-binary "$distro_binary" --out "$lock_out" \
    || fail "machine lock generation failed"
else
  node --experimental-strip-types src/setup.ts write-lock \
    --repo-lock syd.lock --engine "$engine" --out "$lock_out" \
    || fail "machine lock generation failed"
fi

# --- 4. smoke ----------------------------------------------------------------
printf '== smoke (plain terminal; agent surfaces cannot host the engine — docs/environment.md, Limits) ==\n'
bash tools/setup/03-smoke.sh "$engine" || fail "smoke script failed to run"

# --- 5. next steps -----------------------------------------------------------
cat <<STEPS

== pi install next steps ==
  npm ci                                     # dev deps incl. the pinned pi package
  pi install ./pi-sydbox                     # pi CLI: load this repo as the extension
  # pi-web: install the local path as a plugin, then start it as usual:
  #   pi-web install ./pi-sydbox && pi-web
Then, in the project you want sandboxed:
  /sydbox adopt        # or: review sandbox.json, then the manual copy the
                       # refusal text prints (adoption is always a human act)
  sydbox CLI:          node --experimental-strip-types src/cli.ts list
Docs: README.md (walkthrough, troubleshooting), docs/support-matrix.md
STEPS

printf '\nsetup: done — machine lock %s, engine %s\n' "$lock_out" "$engine"
