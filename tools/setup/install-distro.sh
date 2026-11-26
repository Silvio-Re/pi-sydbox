#!/usr/bin/env bash
# install-distro.sh — install the pinned third-party 3.59.0 engine binary
# (roadmap P6: the 6.x-band default; the source build becomes the fallback).
#
#   bash tools/setup/install-distro.sh
#   bash tools/setup/install-distro.sh --dest ~/.local/opt --cache agent_dir/cache
#
# The pin is syd.lock's distroBuild section: package url + sha256, extracted
# usr/bin/syd sha256. Both are verified and a mismatch FAILS CLOSED (exit 1,
# nothing written into the prefix). Trust is pinned bytes — the Arch packager's
# PGP .sig is optional and NOT part of the enforced chain (see syd.lock notes).
#
# The binary links libseccomp.so.2 dynamically and needs >= 2.6.0, which
# Ubuntu-class hosts do not ship, so the real binary installs as syd.bin and a
# three-line exec wrapper at syd prepends the locally built libseccomp to
# LD_LIBRARY_PATH (docs/environment.md, Engine acquisition). The wrapper is the
# path the machine lock names; both hashes are recorded.
#
# Idempotent, like install.sh: a correct syd.bin + wrapper pair is left alone
# unless --force is given. Running the binary for the banner is best-effort:
# agent surfaces cannot execute the engine (docs/environment.md, Limits), and no
# output of this script is engine-execution evidence.
#
# Exit: 0 installed (or already present), 1 verification/extract failure, 2 usage.
set -uo pipefail

dest="$HOME/.local/opt"
cache="agent_dir/cache"
force=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --dest)  dest="${2:?--dest needs a value}"; shift 2 ;;
    --cache) cache="${2:?--cache needs a value}"; shift 2 ;;
    --force) force=1; shift ;;
    -h|--help) sed -n '2,22p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) printf 'unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
done

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
cd "$repo_root" || exit 2
lock="syd.lock"

read_distro() { python3 -c "import json;print(json.load(open('$lock'))['distroBuild']$1)"; }
url="$(read_distro "['url']")"
want_pkg="$(read_distro "['package']['sha256']")"
want_bin="$(read_distro "['binary']['sha256']")"
version="$(read_distro "['version']")"
if [ -z "$url" ] || [ -z "$want_pkg" ] || [ -z "$want_bin" ] || [ -z "$version" ]; then
  printf 'syd.lock has no usable distroBuild pin (run from the repository root)\n' >&2
  exit 2
fi

command -v curl >/dev/null 2>&1 || { printf 'missing tool: curl (sudo apt install curl)\n' >&2; exit 1; }
command -v tar >/dev/null 2>&1 || { printf 'missing tool: tar\n' >&2; exit 1; }
tar --zstd -cf /dev/null /dev/null 2>/dev/null || { printf 'missing zstd (sudo apt install zstd — the package is .pkg.tar.zst)\n' >&2; exit 1; }

sha256_of() { sha256sum -- "$1" | cut -d' ' -f1; }

mkdir -p -- "$cache" "$dest" || exit 1
name="$(basename -- "$url")"
pkg="$cache/$name"
prefix="$dest/syd-$version"
bin="$prefix/syd.bin"
wrapper="$prefix/syd"

# --- download (cache-first, like verify-artifact.sh) ------------------------
if [ -f "$pkg" ] && [ "$(sha256_of "$pkg")" = "$want_pkg" ]; then
  printf 'cache hit: %s (sha256 ok)\n' "$pkg"
elif [ -f "$pkg" ]; then
  printf 'cached copy fails the pinned sha256 — discarding it and re-downloading\n'
  rm -f -- "$pkg"
fi
if [ ! -f "$pkg" ]; then
  tmp="$(mktemp -d)"
  trap 'rm -rf -- "$tmp"' EXIT
  if ! curl -fsSL --max-time 120 "$url" -o "$tmp/$name"; then
    printf 'download failed (network unavailable?) and no verified cache copy of %s\n' "$name" >&2
    exit 1
  fi
  got="$(sha256_of "$tmp/$name")"
  if [ "$got" != "$want_pkg" ]; then
    # Fail closed: a mismatch is a tamper alarm, never a warning.
    printf 'package sha256 mismatch: got %s want %s — refusing to install\n' "$got" "$want_pkg" >&2
    exit 1
  fi
  mv -- "$tmp/$name" "$pkg"
  printf 'downloaded + verified: %s\n' "$pkg"
fi

# --- already present? (idempotence) -----------------------------------------
if [ "$force" -eq 0 ] && [ -x "$bin" ] && [ -f "$wrapper" ] && [ "$(sha256_of "$bin")" = "$want_bin" ]; then
  printf '<SYD-DISTRO-INSTALL>\nstatus=already present\nbinary=%s\nwrapper=%s\nsha256=%s\n</SYD-DISTRO-INSTALL>\n' \
    "$bin" "$wrapper" "$want_bin"
  exit 0
fi

# --- extract ONLY usr/bin/syd, verify the binary, then install ---------------
tmp="$(mktemp -d)"
trap 'rm -rf -- "$tmp"' EXIT
if ! tar -x --zstd -f "$pkg" -C "$tmp"; then
  printf 'extraction failed: %s\n' "$pkg" >&2
  exit 1
fi
extracted="$tmp/usr/bin/syd"
if [ ! -f "$extracted" ]; then
  printf 'package does not contain usr/bin/syd\n' >&2
  exit 1
fi
got_bin="$(sha256_of "$extracted")"
if [ "$got_bin" != "$want_bin" ]; then
  printf 'extracted binary sha256 mismatch: got %s want %s — refusing to install\n' "$got_bin" "$want_bin" >&2
  exit 1
fi

mkdir -p -- "$prefix" || exit 1
install -m 0755 -- "$extracted" "$bin" || exit 1

# The launcher wrapper: deterministic content, so its own sha256 is a pin too.
cat >"$wrapper" <<WRAPPER
#!/bin/sh
# pi-sydbox distro launcher (P6): the engine beside this script links
# libseccomp.so.2 dynamically and needs >= 2.6.0; prepend the locally built
# one (setup builds 2.6.0 via build-libseccomp.sh) and exec the real binary.
LD_LIBRARY_PATH="\$HOME/.local/opt/libseccomp-2.6.0/lib\${LD_LIBRARY_PATH:+:\$LD_LIBRARY_PATH}" exec "\$(dirname -- "\$0")/syd.bin" "\$@"
WRAPPER
chmod 0755 -- "$wrapper" || exit 1

printf '<SYD-DISTRO-INSTALL>\n'
printf 'status=installed\n'
printf 'url=%s\n' "$url"
printf 'package_sha256=%s\n' "$want_pkg"
printf 'binary=%s\n' "$bin"
printf 'binary_sha256=%s\n' "$want_bin"
printf 'wrapper=%s\n' "$wrapper"
printf 'wrapper_sha256=%s\n' "$(sha256_of "$wrapper")"
printf 'packager=%s\n' "$(read_distro "['packager']")"
printf '</SYD-DISTRO-INSTALL>\n'

# Best-effort banner; not evidence of engine execution, and a host that cannot
# run the engine must still get a byte-verified install.
# The whole output is captured, then sliced (an early `| head -1` SIGPIPEs
# the engine under pipefail, the build-engine.sh lesson).
banner_all="$("$wrapper" --version 2>&1)" || true
banner="${banner_all%%$'\n'*}"
if [ -n "$banner" ]; then
  printf 'banner: %s\n' "$banner"
else
  printf 'banner: not printed (this host cannot execute the engine — expected inside agent surfaces)\n'
fi
exit 0
