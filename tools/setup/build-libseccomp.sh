#!/usr/bin/env bash
# Builds libseccomp from source into a local prefix.
#
# Why not the distro package: syd 3.59.0 links seccomp_export_bpf_mem, which
# libseccomp gained after the 2.5.5 shipped by Ubuntu 24.04. The link fails with
# "undefined symbol: seccomp_export_bpf_mem" against the package, so the engine
# build needs a newer libseccomp behind it.
#
# Usage: build-libseccomp.sh [version] [workdir]
# Env:   PREFIX=/some/prefix   (default ~/.local/opt/libseccomp-<version>)
#
# gperf is needed by configure to generate the syscall tables. It is a
# build-time tool with no dependencies, so it is built into <workdir>/tools when
# absent instead of being pulled from apt.
set -euo pipefail

gperf_version=3.1

version="${1:-2.6.0}"
workdir="${2:-/tmp/pi-sydbox-build}"
url="https://github.com/seccomp/libseccomp/releases/download/v$version/libseccomp-$version.tar.gz"

prefix="${PREFIX:-$HOME/.local/opt/libseccomp-$version}"
if ! mkdir -p "$prefix" 2>/dev/null; then
  prefix="$workdir/libseccomp-$version"
  mkdir -p "$prefix"
  printf 'note: %s not writable, using %s\n' "$(dirname "$prefix")" "$prefix" >&2
fi

# created up front: the gperf section writes into $workdir long before the
# libseccomp fetch below did, and curl cannot open its output in a missing
# directory (run 45710973356, all three mirrors, write error after first bytes)
mkdir -p "$workdir"
tools="$workdir/tools"
if ! command -v gperf >/dev/null 2>&1 && [ ! -x "$tools/bin/gperf" ]; then
  printf '== gperf %s (build-time tool) ==\n' "$gperf_version"
  gtar="$workdir/gperf-$gperf_version.tar.gz"
  if [ ! -f "$gtar" ]; then
    # Ordered mirror list with connect timeouts: ftpmirror.gnu.org's redirect
    # can land on a host CI runners cannot reach (2026-11-25, GitHub runner
    # stuck 133 s on mirrors.kernel.org then exiting 1; evidence
    # docs/evidence/p1-runner-45710211881/). ftp.gnu.org first, the
    # redirector last, and the pinned sha256 is checked regardless of source.
    gperf_sha256="588546b945bba4b70b6a3a616e80b4ab466e3f33024a352fc2198112cdbb3ae2"
    ok=""
    for gurl in \
      "https://ftp.gnu.org/gnu/gperf/gperf-$gperf_version.tar.gz" \
      "https://mirrors.kernel.org/gnu/gperf/gperf-$gperf_version.tar.gz" \
      "https://ftpmirror.gnu.org/gperf/gperf-$gperf_version.tar.gz"; do
      printf 'fetch %s\n' "$gurl"
      rm -f "$gtar.part"
      if curl --connect-timeout 20 --retry 1 -fsSL -o "$gtar.part" "$gurl"; then ok=1; break; fi
    done
    if [ -z "$ok" ]; then
      echo 'gperf fetch failed on every mirror' >&2; exit 1
    fi
    sha="$(sha256sum "$gtar.part" | awk '{print $1}')"
    if [ "$sha" != "$gperf_sha256" ]; then
      echo "gperf sha256 mismatch: $sha (expected $gperf_sha256)" >&2; exit 1
    fi
    mv "$gtar.part" "$gtar"
  fi
  rm -rf "$workdir/gperf-$gperf_version"
  tar -xzf "$gtar" -C "$workdir"
  if ! ( cd "$workdir/gperf-$gperf_version" \
      && ./configure --prefix="$tools" >"$workdir/gperf-configure.log" 2>&1 \
      && make -j"$(nproc)" >"$workdir/gperf-build.log" 2>&1 \
      && make install >"$workdir/gperf-install.log" 2>&1 ); then
    tail -15 "$workdir/gperf-build.log" 2>/dev/null
    echo 'gperf build failed' >&2; exit 1
  fi
  printf 'gperf: %s\n' "$tools/bin/gperf"
fi
export PATH="$tools/bin:$PATH"

mkdir -p "$workdir"
tarball="$workdir/$(basename "$url")"
if [ ! -f "$tarball" ]; then
  printf '== fetch ==\n%s\n' "$url"
  curl -fsSL -o "$tarball.part" "$url"
  mv "$tarball.part" "$tarball"
fi
sha="$(sha256sum "$tarball" | awk '{print $1}')"
printf 'sha256: %s\n' "$sha"

src="$workdir/libseccomp-$version"
if [ ! -x "$src/configure" ]; then
  rm -rf "$src"
  tar -xzf "$tarball" -C "$workdir"
fi

printf '\n== configure (prefix=%s) ==\n' "$prefix"
cd "$src"
./configure --prefix="$prefix" --enable-static >"$workdir/libseccomp-configure.log" 2>&1 || {
  tail -20 "$workdir/libseccomp-configure.log"; exit 1
}
grep -E '^(static|python)' config.log >/dev/null 2>&1 || true

printf '\n== make ==\n'
if ! make -j"$(nproc)" >"$workdir/libseccomp-build.log" 2>&1; then
  tail -25 "$workdir/libseccomp-build.log"; exit 1
fi
make install >"$workdir/libseccomp-install.log" 2>&1

printf '\n== symbol check ==\n'
for lib in "$prefix"/lib/libseccomp.so*; do
  [ -f "$lib" ] || continue
  printf '%s: %s hits\n' "$(basename "$lib")" \
    "$(nm -D --defined-only "$lib" 2>/dev/null | grep -c seccomp_export_bpf_mem || true)"
done
[ -f "$prefix/lib/libseccomp.a" ] && printf 'libseccomp.a: %s hits\n' \
  "$(nm "$prefix/lib/libseccomp.a" 2>/dev/null | grep -c ' T seccomp_export_bpf_mem' || true)"

printf 'gperf: %s\npkg-config modversion: %s\n' \
  "$(command -v gperf)" \
  "$(PKG_CONFIG_PATH="$prefix/lib/pkgconfig" pkg-config --modversion libseccomp 2>/dev/null || echo '(not found)')"

printf '\n== <LIBSECCOMP> ==\nversion=%s\nprefix=%s\nsha256=%s\n' "$version" "$prefix" "$sha"
printf 'rebuild the engine with:\n'
printf '  PKG_CONFIG_PATH=%s/lib/pkgconfig LIBSECCOMP_LIB_PATH=%s/lib \\\n' "$prefix" "$prefix"
printf '  LIBSECCOMP_LINK_TYPE=static bash tools/setup/build-engine.sh %s --workdir %s\n' 3.59.0 "$workdir"

