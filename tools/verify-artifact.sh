#!/usr/bin/env bash
# Verify the syd artifact against syd.lock, then optionally unpack it.
# Refuses to proceed while the lock is unverified: a placeholder pin is a bug.
#
# The verified tarball, its detached minisign .sig and the release public key
# are cached under agent_dir/cache/ and re-checked on every run, so verdict.sh
# keeps its guarantee while offline: the cache IS the artifact, byte-checked
# by the pinned sha512 and, once the .sig and key are cached, by signature.
#
# The release is minisign, not OpenPGP: `gpg --verify` cannot succeed on it
# and no .sha512sum sidecar exists (verified against distfiles, see syd.lock
# notes). Signature checks go through tools/minisign-verify.py (vendored: a
# fresh clone is self-contained; agent_dir/ is gitignored by design).
#
# Exit: 0 verified (fresh download or cache hit; a missing cached signature is
# reported as a gap, not a failure), 3 network unavailable and no usable cache
# (verdict.sh reports this as SKIP), 1 verification failed.
set -euo pipefail
cd "$(dirname "$0")/.."

lock=syd.lock
read_field() { python3 -c "import json,sys;print(json.load(open('$lock')).get('$1') or '')"; }
read_sub() { python3 -c "import json;print(json.load(open('$lock')).get('$1',{}).get('$2') or '')"; }

status="$(read_field status)"
version="$(read_field version)"
url="$(read_field url)"
want="$(read_field sha512)"
keysrc="$(read_sub signingKey source)"
keyid="$(read_sub signingKey fingerprint)"

if [ "$status" != "verified" ] || [ -z "$url" ] || [ -z "$want" ]; then
  cat >&2 <<MSG
syd.lock is not verified (status=$status).
Fill url, sha512, signingKey.source/.fingerprint in phase 0.5, verify with:

  curl -fsSLO "$url"          # artifact
  curl -fsSLO "$url.sig"      # detached minisign signature (no .sha512sum sidecar exists)
  curl -fsSLO "$keysrc"       # public key, served by the upstream repository over TLS
  python3 tools/minisign-verify.py "$(basename "$keysrc")" "$(basename "$url").sig" "$(basename "$url")"
  sha512sum "$(basename "$url")"   # must equal syd.lock's sha512

then set status=verified. This script never downloads a placeholder pin.
MSG
  exit 1
fi

cache="agent_dir/cache"
mkdir -p "$cache"
name="$(basename "$url")"
cached="$cache/$name"
sig="$cache/$name.sig"
pub="$cache/$(basename "$keysrc")"
verifier="tools/minisign-verify.py"

sha_ok() { # sha_ok <file> — a mismatch is a tamper alarm
  local got
  got="$(sha512sum "$1" | cut -d' ' -f1)"
  if [ "$got" != "$want" ]; then
    echo "sha512 mismatch: got $got want $want" >&2
    return 1
  fi
  echo "sha512 ok: $version ($got)"
}

# 0 = signature verified, 2 = not verifiable (files missing), 1 = BAD signature.
sig_ok() { # sig_ok <file>
  if [ ! -f "$sig" ] || [ ! -f "$pub" ]; then
    echo "signature not checked online-unavailable files: ${sig} ${pub}" >&2
    return 2
  fi
  # D1 (external review): a missing verifier is a tooling gap, not tamper
  # evidence. Missing files must never be reported as a failed check.
  if [ ! -f "$verifier" ]; then
    echo "signature not checked: $verifier missing" >&2
    return 2
  fi
  if ! python3 "$verifier" "$pub" "$sig" "$1"; then
    echo "minisign signature FAILED for $1" >&2
    return 1
  fi
  echo "minisign signature ok (key $keyid)"
}

verify_sig_or() { # verify_sig_or <file> <label> — an incomplete check is a gap, a bad one is fatal
  local rc=0
  sig_ok "$1" >&2 || rc=$?
  if [ "$rc" -eq 1 ]; then
    exit 1
  fi
  if [ "$rc" -eq 2 ]; then
    echo "WARNING: sha512-only verification ($2); fetch the .sig and the key once to complete the pin" >&2
  fi
}

if [ -f "$cached" ]; then
  sha_ok "$cached" >&2 # cache hit: the pinned artifact, verified offline
  verify_sig_or "$cached" "cache hit without a cached .sig or key"
  exit 0
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
if ! curl -fsSL --max-time 60 "$url" -o "$tmp/artifact"; then
  echo "download failed (network unavailable?) and no cached artifact present" >&2
  exit 3
fi
sha_ok "$tmp/artifact" >&2

# Best effort, not gating: a signature that cannot be fetched downgrades the
# verification to the pinned hash only, loudly.
if curl -fsSL --max-time 60 "$url.sig" -o "$tmp/artifact.sig" && [ -n "$keysrc" ] \
  && curl -fsSL --max-time 60 "$keysrc" -o "$tmp/pub"; then
  cp "$tmp/artifact.sig" "$sig"
  cp "$tmp/pub" "$pub"
fi
cp "$tmp/artifact" "$cached"
verify_sig_or "$cached" "fresh download without its signature"
echo "cached: $cached"
