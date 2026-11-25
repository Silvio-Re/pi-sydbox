#!/usr/bin/env bash
# install.sh — human-run, in a plain terminal, outside the agent sandbox.
#
#   bash tools/setup/install.sh
#   bash tools/setup/install.sh --src agent_dir/dist --dest ~/.local/opt
#
# The shared folder carries no exec bit, so the engine is copied to a Linux path
# before it can run. The source is either the release tarball (extracted here) or
# a plain binary; both are found by the version pinned in syd.lock, so no file
# name has to be guessed. Run this after tools/verify-artifact.sh (or the
# agent_dir 02-verify.sh twin) has checked the signature.
#
# Exit: 0 installed (--version printed), 1 not found / ambiguous / extract or
# copy failed, 2 usage.
set -uo pipefail

src="agent_dir/dist"
dest_root="$HOME/.local/opt"

usage() {
  printf 'usage: bash %s [--src DIR] [--dest DIR]\n' "${BASH_SOURCE[0]}" >&2
  printf '       --src  default agent_dir/dist\n' >&2
  printf '       --dest default ~/.local/opt\n' >&2
  exit 2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --src)
      [ "$#" -ge 2 ] || usage
      src="$2"
      shift 2
      ;;
    --dest)
      [ "$#" -ge 2 ] || usage
      dest_root="$2"
      shift 2
      ;;
    -h|--help) usage ;;
    *)
      printf 'unknown argument: %s\n' "$1" >&2
      usage
      ;;
  esac
done

[ -d "$src" ] || { printf 'not a directory: %s\n' "$src" >&2; exit 1; }

version="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' syd.lock 2>/dev/null | head -1)"
if [ -z "$version" ]; then
  printf 'cannot read the pinned version from syd.lock (run from the repository root)\n' >&2
  exit 2
fi
status="$(sed -n 's/.*"status"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' syd.lock | head -1)"

# Collect the source directory: archives and loose files, sidecars excluded.
shopt -s nullglob
archives=()
loose=()
for f in "$src"/*; do
  [ -f "$f" ] || continue
  base="$(basename -- "$f")"
  case "$base" in
    *.sig|*.asc|*.sha512|*.sha512sum|*.txt|*.md) continue ;;
  esac
  case "$base" in
    *.tar.xz|*.tar.gz|*.tar.zst|*.tgz|*.zip) archives+=("$f") ;;
    *) loose+=("$f") ;;
  esac
done
shopt -u nullglob

# Prefer the loose file carrying the version, then the single archive, then the
# single loose file. Two archives, or two loose files of the same kind, is
# ambiguous and stops the run.
artifact=""
kind=""
loose_versioned=()
for f in "${loose[@]}"; do
  case "$(basename -- "$f")" in
    *"$version"*) loose_versioned+=("$f") ;;
  esac
done
if [ "${#loose_versioned[@]}" -eq 1 ]; then
  artifact="${loose_versioned[0]}"
  kind="file"
elif [ "${#loose[@]}" -eq 1 ]; then
  artifact="${loose[0]}"
  kind="file"
elif [ "${#archives[@]}" -eq 1 ]; then
  artifact="${archives[0]}"
  kind="archive"
fi

echo '<SYD-INSTALL>'
printf 'src=%s\nversion=%s\nlock-status=%s\n' "$src" "$version" "$status"

if [ -z "$artifact" ]; then
  if [ "${#archives[@]}" -eq 0 ] && [ "${#loose[@]}" -eq 0 ]; then
    printf 'no artifact found: no archive and no binary in %s (sidecars ignored)\n' "$src"
  else
    printf 'ambiguous input, pick one:\n'
    printf '  %s\n' "${archives[@]}" "${loose[@]}"
  fi
  printf 'files present:\n'
  ls -l -- "$src"
  printf '</SYD-INSTALL>\n'
  exit 1
fi

work="$artifact"
extract_dir=""
cleanup() {
  if [ -n "$extract_dir" ]; then rm -rf -- "$extract_dir"; fi
}
trap cleanup EXIT

if [ "$kind" = "archive" ]; then
  extract_dir="$(mktemp -d "${TMPDIR:-/tmp}/sydbox-install.XXXXXX")" || exit 1
  printf 'archive=%s\nextract=%s\n' "$artifact" "$extract_dir"
  case "$artifact" in
    *.tar.xz) tar -xJf "$artifact" -C "$extract_dir" ;;
    *.tar.gz|*.tgz) tar -xzf "$artifact" -C "$extract_dir" ;;
    *.tar.zst) tar --zstd -xf "$artifact" -C "$extract_dir" ;;
    *.zip) unzip -q "$artifact" -d "$extract_dir" ;;
  esac || {
    printf 'cannot extract %s\n' "$artifact"
    printf '</SYD-INSTALL>\n'
    exit 1
  }
  # The release tarball carries the binary as `syd`; fall back to the single
  # executable regular file in case the layout changes.
  work="$(find "$extract_dir" -type f -name syd | head -1)"
  if [ -z "$work" ]; then
    work="$(find "$extract_dir" -type f -perm -u+x | head -1)"
  fi
  if [ -z "$work" ]; then
    printf 'no syd binary inside %s; contents:\n' "$artifact"
    find "$extract_dir" -maxdepth 3 | head -20
    printf '</SYD-INSTALL>\n'
    exit 1
  fi
fi

target_dir="$dest_root/syd-$version"
target="$target_dir/syd"

if [ "$status" != "verified" ]; then
  printf 'warning: syd.lock says status=%s; install after 02-verify.sh has passed\n' "$status"
fi

if ! mkdir -p -- "$target_dir"; then
  printf 'cannot create %s\n' "$target_dir"
  printf '</SYD-INSTALL>\n'
  exit 1
fi
if ! cp -- "$work" "$target"; then
  printf 'copy failed: %s -> %s\n' "$work" "$target"
  printf '</SYD-INSTALL>\n'
  exit 1
fi
if ! chmod 0755 -- "$target"; then
  printf 'chmod failed: %s\n' "$target"
  printf '</SYD-INSTALL>\n'
  exit 1
fi

printf 'source=%s\n' "$work"
printf 'installed=%s\n' "$target"
printf 'size=%s bytes\n' "$(wc -c < "$target")"
printf '\n== stdout of the installed binary ==\n'
"$target" --version 2>&1
rc=$?
printf 'rc=%s\n' "$rc"
if [ "$rc" -ne 0 ]; then
  printf 'a non-zero rc here means the flag differs or the copy is not runnable; 03-smoke.sh tries --check next\n'
fi
printf '</SYD-INSTALL>\n'
exit 0
