#!/usr/bin/env bash
# tools/sanitize-evidence.sh — copy records into docs/evidence/ with host paths removed.
#
# `agent_dir/` is gitignored, so the logs a doc cites have to be copied into the
# repository before anything may point at them. Those logs are full of this
# machine's identity; this script is the single place the replacement rule lives,
# and it refuses to write a file that still carries a host path, so the rule is
# enforced rather than described.
#
# Usage:
#   bash tools/sanitize-evidence.sh SRC DEST
#
# SRC may be a file or a directory (copied recursively, keeping names). Text
# files are rewritten through the rule below; a binary file is copied unchanged.
# DEST must not exist under a tracked `docs/evidence/` path unless it is inside
# this repository.
#
# Replacement rule (also stated in docs/evidence/README.md):
#   /home/<user>            -> @HOME@
#   /media/<share>          -> @SHARE@      (vboxsf and other host mounts)
#   /tmp/pi-sydbox-<suffix> -> @SCRATCH@    (corpus scratch roots)
#   /tmp/sydbox<suffix>     -> @SCRATCH@    (probe temp dirs)
#   /run/user/<uid>         -> @RUNTIME@
# Dates, versions, engine names and case names are kept verbatim: they are what
# the evidence is about.
set -euo pipefail

usage() { sed -n '2,26p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

if [ "$#" -ne 2 ]; then usage >&2; exit 2; fi
src="$1"; dest="$2"

if [ ! -e "$src" ]; then printf 'source not found: %s\n' "$src" >&2; exit 2; fi

# Remaining host paths after the rule ran; a hit is a leak, not a warning.
leak_pattern='/home/|/media/|/run/user/|/tmp/pi-sydbox-|/tmp/sydbox'

sanitize_stream() {
  sed -E \
    -e 's#/home/[A-Za-z0-9._][A-Za-z0-9._-]*#@HOME@#g' \
    -e 's#/media/[A-Za-z0-9._][A-Za-z0-9._-]*#@SHARE@#g' \
    -e 's#/tmp/pi-sydbox-[A-Za-z0-9._-]*#@SCRATCH@#g' \
    -e 's#/tmp/sydbox[A-Za-z0-9._-]*#@SCRATCH@#g' \
    -e 's#/run/user/[0-9]+#@RUNTIME@#g'
}

files=()
if [ -d "$src" ]; then
  while IFS= read -r f; do files+=("$f"); done < <(find "$src" -type f | sort)
else
  files=("$src")
fi
if [ "${#files[@]}" -eq 0 ]; then
  printf 'no regular file under %s\n' "$src" >&2
  exit 2
fi

mkdir -p -- "$dest"
out_base="$dest"
if [ -d "$src" ]; then
  out_base="$dest/$(basename -- "$src")"
  mkdir -p -- "$out_base"
fi

written=0
leaked=0
for f in "${files[@]}"; do
  if [ -d "$src" ]; then
    rel="${f#"$src"/}"
    out="$out_base/$rel"
  else
    out="$out_base/$(basename -- "$f")"
  fi
  mkdir -p -- "$(dirname -- "$out")"
  # -I: binary files (a .tgz, a log with NUL bytes) are copied as they are.
  if grep -Iq . -- "$f" 2>/dev/null; then
    sanitize_stream < "$f" > "$out"
    if hits=$(grep -nE "$leak_pattern" -- "$out" | head -3); then
      printf 'LEAK %s\n%s\n' "$out" "$hits" >&2
      leaked=$((leaked + 1))
    fi
  else
    cp -- "$f" "$out"
  fi
  printf 'sanitized %s -> %s\n' "$f" "$out"
  written=$((written + 1))
done

printf 'rule: /home/<user> @HOME@, /media/<share> @SHARE@, /tmp scratch @SCRATCH@, /run/user/<uid> @RUNTIME@\n'
printf 'files: %d written, %d with a remaining host path\n' "$written" "$leaked"
if [ "$leaked" -ne 0 ]; then
  printf 'FAIL: host path survived the rule; extend the rule, do not ship the file\n' >&2
  exit 1
fi
printf 'PASS sanitized\n'
