#!/usr/bin/env bash
# 02-verify.sh — human-run, in a plain terminal, outside the agent sandbox.
#
#   bash agent_dir/spike/02-verify.sh agent_dir/dist
#   bash agent_dir/spike/02-verify.sh <artifact-dir> 3.60.0    # explicit version
#
# Verifies a downloaded syd artifact: sha512 (transport) and the detached
# minisign signature (provenance). Prints everything between <SYD-VERIFY>
# </SYD-VERIFY>.
#
# Why this does not call tools/verify-artifact.sh:
#   * that script reads syd.lock and refuses to run while status != verified;
#     filling syd.lock is what this spike produces, so the gate is circular;
#   * it downloads with curl, i.e. network — this spike must not need the network
#     except for the single explicit key import below;
#   * it prints its verification steps as advice and never runs them, while the
#     whole point here is to capture the verdict.
#   Once syd.lock is filled, `make verify` is the repeatable check.
#
# Exit: 0 all checks ran, 1 a check failed or files are missing, 2 usage.
set -uo pipefail

usage() {
  printf 'usage: bash %s <artifact-dir> [version]   e.g. bash %s agent_dir/dist\n' \
    "${BASH_SOURCE[0]}" "${BASH_SOURCE[0]}" >&2
  printf '       version defaults to the pinned version in syd.lock; run from the repository root\n' >&2
  exit 2
}

[ "$#" -ge 1 ] || usage
dir="$1"
if [ "$#" -ge 2 ]; then
  version="$2"
else
  version="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' syd.lock 2>/dev/null | head -1)"
  if [ -z "$version" ]; then
    printf 'no version argument and none readable from syd.lock (run from the repository root)\n' >&2
    exit 2
  fi
  printf 'version taken from syd.lock: %s\n' "$version" >&2
fi

if [ ! -d "$dir" ]; then
  printf 'not a directory: %s\n' "$dir" >&2
  exit 2
fi

# The release signature is minisign, not OpenPGP: `gpg --verify` reports "no
# valid OpenPGP data" whatever key is imported. Id and source are recorded in
# syd.lock (signingKey). The PGP key published at /sydbox/syd.asc is not the
# signer of the release.
key_id="b1e47bc29cc65132"
pub_url="https://gitlab.exherbo.org/sydbox/sydbox/-/raw/main/dev/syd-release.pub"
verifier="agent_dir/spike/minisign_verify.py"

# Pick the artifact: one regular file in $dir whose name contains the version,
# sidecars excluded.
shopt -s nullglob
cands=()
for f in "$dir"/*"$version"*; do
  [ -f "$f" ] || continue
  case "$f" in
    *.sig|*.asc|*.sha512|*.sha512sum|*.txt|*.md) continue ;;
  esac
  cands+=("$f")
done
shopt -u nullglob

echo '<SYD-VERIFY>'
printf '== input ==\n'
printf 'dir=%s\nversion=%s\n' "$dir" "$version"

if [ "${#cands[@]}" -eq 0 ]; then
  printf 'no artifact found: no file in %s has "%s" in its name and is not a sidecar\n' "$dir" "$version"
  printf 'files present:\n'
  ls -l -- "$dir"
  printf '</SYD-VERIFY>\n'
  exit 1
fi
if [ "${#cands[@]}" -gt 1 ]; then
  printf 'ambiguous input, more than one candidate:\n'
  printf '  %s\n' "${cands[@]}"
  printf 'keep only the artifact (and its .sig/.sha512sum sidecars) in a directory of its own\n'
  printf '</SYD-VERIFY>\n'
  exit 1
fi

artifact="${cands[0]}"
printf 'artifact=%s\n' "$artifact"
printf 'size=%s bytes\n' "$(wc -c < "$artifact")"

printf '\n== sha512sum ==\n'
sha512sum -- "$artifact"
printf 'rc=%s\n' "$?"

sidecar=""
for s in "$artifact.sha512sum" "$artifact.sha512" "$dir/sha512sum"; do
  if [ -f "$s" ]; then sidecar="$s"; break; fi
done
if [ -n "$sidecar" ]; then
  printf '\n== sha512sum -c %s ==\n' "$sidecar"
  ( cd -- "$dir" && sha512sum -c -- "$(basename -- "$sidecar")" )
  printf 'rc=%s\n' "$?"
else
  printf '\n== sha512sum -c ==\n'
  printf 'no sidecar next to the artifact (looked for %s.sha512sum, %s.sha512)\n' \
    "$(basename -- "$artifact")" "$(basename -- "$artifact")"
fi

printf '\n== minisign signature lookup ==\n'
sig=""
for s in "$artifact.sig" "$artifact.minisig"; do
  if [ -f "$s" ]; then sig="$s"; break; fi
done
pub=""
for p in "$dir/syd-release.pub" agent_dir/spike/syd-release.pub; do
  if [ -f "$p" ]; then pub="$p"; break; fi
done
printf 'expected key id: %s (syd.lock signingKey.id)\n' "$key_id"
if [ -n "$sig" ] && [ -n "$pub" ] && [ -f "$verifier" ]; then
  printf 'signature=%s\npublic key=%s\n' "$sig" "$pub"
  printf '\n== minisign verify ==\n'
  printf '$ python3 %s %s %s %s\n' "$verifier" "$pub" "$sig" "$artifact"
  python3 "$verifier" "$pub" "$sig" "$artifact" 2>&1
  rc=$?
  printf 'rc=%s  (0 verified, 1 invalid, 2 unusable input)\n' "$rc"
  printf '\nwhat to paste back: the key id line and the "signature: valid" verdict, or the failure text\n'
elif [ -z "$sig" ]; then
  printf 'no detached signature next to the artifact (looked for %s.sig, %s.minisig)\n' \
    "$(basename -- "$artifact")" "$(basename -- "$artifact")"
  printf 'download the release .sig from the release page and re-run\n'
elif [ -z "$pub" ]; then
  printf 'no release public key found; fetch %s into the artifact dir and re-run\n' "$pub_url"
else
  printf 'verifier missing: %s (run from the repository root)\n' "$verifier"
fi

printf '</SYD-VERIFY>\n'
exit 0
