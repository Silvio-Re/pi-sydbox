#!/usr/bin/env bash
# Verify the syd artifact against syd.lock, then optionally unpack it.
# Refuses to proceed while the lock is unverified: a placeholder pin is a bug.
#
# The verified tarball is cached under agent_dir/cache/ and re-checked against
# the pinned sha512 on every run, so verdict.sh keeps its guarantee while
# offline: the cache IS the artifact, byte-identical by hash.
#
# Exit: 0 verified (fresh download or cache hit), 3 network unavailable and no
# usable cache (verdict.sh reports this as SKIP), 1 verification failed.
set -euo pipefail
cd "$(dirname "$0")/.."

lock=syd.lock
read_field() { python3 -c "import json,sys;print(json.load(open('$lock')).get('$1') or '')"; }

status="$(read_field status)"
version="$(read_field version)"
url="$(read_field url)"
want="$(read_field sha512)"

if [ "$status" != "verified" ] || [ -z "$url" ] || [ -z "$want" ]; then
  cat >&2 <<MSG
syd.lock is not verified (status=$status).
Fill url, sha512, signingKey.fingerprint and installedPath in phase 0.5, verify with:

  curl -fsSLO <url>            # artifact
  curl -fsSLO <url>.sha512sum  # sidecar
  sha512sum -c <artifact>.sha512sum
  gpg --recv-keys 0x25F201EDF60FF478 && gpg --verify <artifact>.sig <artifact>

then set status=verified. This script never downloads a placeholder pin.
MSG
  exit 1
fi

cache="agent_dir/cache"
mkdir -p "$cache"
cached="$cache/$(basename "$url")"

verify() { # verify <file> — prints sha512 mismatch to stderr on failure
  local got
  got="$(sha512sum "$1" | cut -d' ' -f1)"
  if [ "$got" != "$want" ]; then
    echo "sha512 mismatch: got $got want $want" >&2
    return 1
  fi
  echo "sha512 ok: $version ($got)"
}

if [ -f "$cached" ]; then
  verify "$cached" >&2 # cache hit: the pinned artifact, verified offline
  exit 0
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
if ! curl -fsSL --max-time 60 "$url" -o "$tmp/artifact"; then
  echo "download failed (network unavailable?) and no cached artifact present" >&2
  exit 3
fi
verify "$tmp/artifact" >&2
cp "$tmp/artifact" "$cached"
echo "cached: $cached"
