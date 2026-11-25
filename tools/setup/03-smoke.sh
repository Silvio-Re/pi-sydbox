#!/usr/bin/env bash
# 03-smoke.sh — human-run, in a plain terminal, outside the agent sandbox.
#
#   bash tools/setup/03-smoke.sh ~/.local/opt/syd-3.60.0/syd
#
# Answers: does the engine run and pass its self-check, and does a profile built
# from the repository profile file actually deny one read and allow another?
# Prints everything between <SYD-SMOKE> </SYD-SMOKE>, including the raw log
# lines the engine writes to the file descriptor named by SYD_LOG_FD.
#
# Not -e: a probe that fails is data, the run must continue.
# Exit: 0 every probe ran (whatever the verdicts), 2 usage or missing input.
set -uo pipefail

[ "$#" -ge 1 ] || { printf 'usage: bash %s /path/to/syd\n' "${BASH_SOURCE[0]}" >&2; exit 2; }
syd="$1"
if [ ! -x "$syd" ]; then
  printf 'not an executable file: %s\n' "$syd" >&2
  exit 2
fi

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
base_profile="$repo_root/corpus/profiles/syd-a.profile"
if [ ! -f "$base_profile" ]; then
  printf 'missing profile file: %s\n' "$base_profile" >&2
  exit 2
fi

tmp="$(mktemp -d "${TMPDIR:-/tmp}/syd-smoke.XXXXXX")"
trap 'rm -rf -- "$tmp"' EXIT
root="$tmp/root"
mkdir -p -- "$root/ok"
printf 'secret\n' > "$root/secret"
printf 'plain\n' > "$root/ok/plain"

# Deny profile: the repository profile verbatim, with @ROOT@ resolved.
# Allow probe profile: same file, plus an explicit allow rule for the file the
# allow probe reads, so a success cannot be explained by "nothing is denied".
# The allow/ rule is added by this script only; it mirrors the deny rule's
# grammar and is not repository policy. The allow probe narrows the inherited
# engine profile to one file, so a success cannot come from the base allowlist
# alone. Categories are the engine's (lpath traverse, npath lookup, rpath read).
deny_profile="$tmp/deny.syd-3"
allow_profile="$tmp/allow.syd-3"
sed "s|@ROOT@|$root|g" -- "$base_profile" > "$deny_profile"
{ grep -v -E '^[[:space:]]*(#|$)' -- "$deny_profile" ;
  printf 'allow/lpath,npath,rpath,wpath+%s\n' "$root/ok/plain" ; } > "$allow_profile"

# Syd refuses group-writable configuration: created under umask 002 these files
# are 0664 and `syd -P` exits 1 with "Error: LinuxError: EPERM" and an empty log
# before reading any rule. Mode 600 is accepted (tools/setup/09-perm-order.sh).
chmod 600 -- "$deny_profile" "$allow_profile"

deny_log="$tmp/deny.log"
allow_log="$tmp/allow.log"
: > "$deny_log"
: > "$allow_log"

# Runs one sandboxed probe with the engine log diverted to fd 3, which is the
# destination named by SYD_LOG_FD. Prints the command, its output, its status
# and the log lines.
probe() {
  label="$1"; logf="$2"; shift 2
  printf '\n== %s ==\n' "$label"
  printf '$ SYD_LOG_FD=3 %s\n' "$*"
  out="$(SYD_LOG_FD=3 "$@" 2>&1 3>>"$logf")"
  rc=$?
  if [ -n "$out" ]; then printf '%s\n' "$out"; else printf '(no output)\n'; fi
  printf 'rc=%s\n' "$rc"
  if [ -s "$logf" ]; then
    printf '%s\n' '-- log (fd 3) --'
    cat -- "$logf"
  else
    printf '%s\n' '-- log (fd 3) empty --'
  fi
}

echo '<SYD-SMOKE>'
printf '== input ==\n'
printf 'syd=%s\n' "$syd"
printf 'profile_base=%s\n' "$base_profile"
printf 'root=%s\n' "$root"

printf '\n== deny profile (%s) ==\n' "$deny_profile"
cat -- "$deny_profile"
printf '\n== allow probe profile (%s) ==\n' "$allow_profile"
cat -- "$allow_profile"

probe "version" "$tmp/version.log" "$syd" --version
probe "check" "$tmp/check.log" "$syd" --check

printf '\n== deny probe: read the denied file ==\n'
probe "deny-read-secret" "$deny_log" "$syd" -P "$deny_profile" -- cat "$root/secret"
printf 'expected: rc != 0, no "secret" line in the output, one deny record in the log\n'

printf '\n== allow probe: read an explicitly allowed file ==\n'
probe "allow-read-plain" "$allow_log" "$syd" -P "$allow_profile" -- cat "$root/ok/plain"
printf 'expected: rc = 0 and the line "plain"\n'

printf '\n== what to paste back ==\n'
printf 'the whole block above, unchanged\n'
printf '</SYD-SMOKE>\n'
exit 0
