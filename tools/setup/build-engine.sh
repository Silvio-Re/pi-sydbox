#!/usr/bin/env bash
# build-engine.sh — build the syd engine from source at a pinned tag.
#
# Why this exists: the signed release binaries only ship the current version
# (distfiles keeps no older tarballs), and 3.60.0 refuses to start below Linux
# 7.2 because of the landlock ABI 10 rules. On a kernel 6.x guest the only way
# to a working engine is building an older tag, so the recipe has to be a
# checked-in script that a reinstalled VM can replay.
#
# Assumed prerequisites (apt, recorded in the project's environment doc):
#   sudo apt install build-essential pkg-config libseccomp-dev
#   rustup toolchain >= 1.88 (the workspace's rust-version)
# Everything else is fetched: source from the pinned tag, crates from crates.io
# under Cargo.lock, so dependency versions are the ones upstream shipped.
#
#   bash build-engine.sh 3.59.0
#   bash build-engine.sh 3.59.0 --prefix "$HOME/.local/opt/syd-3.59.0" --workdir /tmp/b
#
# Idempotent: a built tree is reused, and an installed binary of the same
# version is left alone unless --force is given.
set -euo pipefail

version="${1:-3.59.0}"
[ "$#" -ge 1 ] && shift
prefix="$HOME/.local/opt/syd-$version"
workdir="${TMPDIR:-/tmp}/pi-sydbox-build"
expected_commit=""
force=0

usage() { printf 'usage: bash %s <version> [--prefix DIR] [--workdir DIR] [--commit SHA] [--force]\n' "${BASH_SOURCE[0]}"; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --prefix)  prefix="${2:?--prefix needs a value}"; shift 2 ;;
    --workdir) workdir="${2:?--workdir needs a value}"; shift 2 ;;
    --commit)  expected_commit="${2:?--commit needs a value}"; shift 2 ;;
    --force)   force=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'unknown option: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

die() { printf 'error: %s\n' "$*" >&2; exit 1; }

# ---- preflight: every missing package names the apt command that fixes it ----
missing=0
need() {
  command -v "$1" >/dev/null 2>&1 || { printf 'missing tool: %s (sudo apt install %s)\n' "$1" "${2:-$1}" >&2; missing=1; }
}
need git git
need cc build-essential
need make build-essential
need pkg-config pkg-config
need rustc rustc
need cargo cargo

if ! pkg-config --exists libseccomp 2>/dev/null; then
  printf 'missing libseccomp headers: sudo apt install libseccomp-dev\n' >&2; missing=1
fi
[ "$missing" -eq 0 ] || die "prerequisites missing, see the apt commands above"

rustc_version="$(rustc --version | awk '{print $2}')"
[ "$(printf '%s\n1.88.0\n' "$rustc_version" | sort -V | head -1)" = "1.88.0" ] \
  || die "rustc $rustc_version is older than the workspace's rust-version 1.88"
seccomp_version="$(pkg-config --modversion libseccomp)"

# ---- source: pinned tag, commit recorded for the lock ----
src="$workdir/syd-$version"
mkdir -p "$workdir"

# cargo writes a package cache and a registry index into CARGO_HOME, which may be
# read-only (agent sandbox) or shared between unrelated builds. Keep it inside the
# workdir unless the caller already pointed it somewhere writable, so the build is
# self-contained and does not depend on the state of ~/.cargo.
if [ -z "${CARGO_HOME:-}" ] || ! [ -w "${CARGO_HOME}" ]; then
  export CARGO_HOME="$workdir/cargo-home"
  mkdir -p "$CARGO_HOME"
fi
if [ -d "$src/.git" ]; then
  git -C "$src" fetch -q --depth 1 origin "+refs/tags/v$version:refs/tags/v$version" || die "cannot fetch tag v$version"
  git -C "$src" checkout -q "v$version" || die "cannot check out v$version"
else
  git clone -q --depth 1 --branch "v$version" https://gitlab.exherbo.org/sydbox/sydbox.git "$src" \
    || die "cannot clone tag v$version"
fi
commit="$(git -C "$src" rev-parse HEAD)"
if [ -n "$expected_commit" ] && [ "$expected_commit" != "$commit" ]; then
  die "commit mismatch: tag v$version is $commit, expected $expected_commit"
fi

# ---- build: --locked keeps the dependency graph at upstream's Cargo.lock ----
binary="$src/target/release/syd"
if [ ! -x "$binary" ] || [ "$force" -eq 1 ]; then
  printf 'building syd %s at %s (this takes a few minutes)\n' "$version" "$commit"
  if ! cargo build --release --locked --manifest-path "$src/Cargo.toml" > "$workdir/build.log" 2>&1; then
    printf 'build failed, last 25 lines of %s:\n' "$workdir/build.log" >&2
    tail -25 "$workdir/build.log" >&2
    exit 1
  fi
fi
[ -x "$binary" ] || die "build produced no executable at $binary"

# The whole output is captured first, the first line taken afterwards: an
# early `| head -1` closes the pipe on syd's stdout while it is still
# writing (its --version prints several lines), syd exits 141 on the EPIPE,
# and `set -o pipefail` turns that into a build failure (P3 gate machine,
# 2026-11-26). Consumers that read the whole stream (awk, sed without -n
# limits, grep without -q) never trigger it.
version_all="$("$binary" --version 2>&1)" || die "built binary fails --version"
banner="${version_all%%$'\n'*}"
case "$banner" in
  "syd $version"*) : ;;
  *) die "built binary reports '$banner', expected version $version" ;;
esac
features="$(sed -n 's/^default = \[\(.*\)\]/\1/p' "$src/Cargo.toml" | sed -n '1p')"
checksum="$(sha256sum "$binary" | awk '{print $1}')"
sha512="$(sha512sum "$binary" | awk '{print $1}')"

# ---- install ----
status=installed
if [ -x "$prefix/syd" ] && [ "$force" -eq 0 ] && "$prefix/syd" --version 2>/dev/null | grep "^syd $version" >/dev/null; then
  status="already present"
else
  mkdir -p "$prefix" 2>/dev/null || true
  if install -m 0755 "$binary" "$prefix/syd" 2>/dev/null; then
    :
  else
    status="not installed (run: sudo install -m 0755 $binary $prefix/syd)"
  fi
fi

cat <<EOF
<SYD-BUILD>
version=p$version
versions=$version
tag=v$version
commit=$commit
source=https://gitlab.exherbo.org/sydbox/sydbox.git
workdir=$src
features=${features:-default}
rustc=$rustc_version
cargo=$(cargo --version | awk '{print $2}')
libseccomp=$seccomp_version
cargo_home=$CARGO_HOME
banner=$banner
binary=$binary
bytes=$(stat -c %s "$binary")
sha256=$checksum
sha512=$sha512
prefix=$prefix
install_status=$status
</SYD-BUILD>
EOF
