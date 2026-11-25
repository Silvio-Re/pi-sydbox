#!/usr/bin/env bash
# 09-perm-order.sh — human-run, in a plain terminal, outside the agent sandbox.
#
#   bash agent_dir/spike/09-perm-order.sh /path/to/syd
#
# Two questions left after 07/08:
#   1. `-P` stats mode/uid/ino/mnt-id and then exits EPERM with no failing syscall
#      traced. Our profiles are 0664 (umask 002). Does a 0600 file load?
#   2. syd is deny-by-default. Can it express "allow everything except X" the way
#      the ADR needs, by ordering a wildcard allow before a deny?
set -uo pipefail

[ "$#" -ge 1 ] || { printf 'usage: bash %s /path/to/syd\n' "${BASH_SOURCE[0]}" >&2; exit 2; }
syd="$1"
[ -x "$syd" ] || { printf 'not an executable: %s\n' "$syd" >&2; exit 2; }

tmp="$(mktemp -d "${TMPDIR:-/tmp}/syd-po.XXXXXX")" || exit 1
trap 'rm -rf -- "$tmp"' EXIT

root="$tmp/root"
mkdir -p "$root/ok"
printf 'plain\n' >"$root/ok/plain"
printf 'secret\n' >"$root/secret"
deny_rule="deny/read,stat,write+$root/secret"

run() {                                  # run <label> <target> [syd args...]
  local label="$1" target="$2" rc out log
  shift 2
  SYD_LOG_FD=3 "$syd" "$@" -- cat "$target" >"$tmp/o" 2>&1 3>"$tmp/l"
  rc=$?
  out="$(head -1 "$tmp/o" | cut -c1-20)"
  if [ -s "$tmp/l" ]; then log="$(wc -l <"$tmp/l")"; else log=0; fi
  printf '%-18s rc=%-3s out=%-22s log=%s line(s)\n' "$label" "$rc" "${out:-<empty>}" "$log"
}

echo '<SYD-PERM-ORDER>'
printf 'syd=%s\n' "$syd"
printf 'deny rule: %s\n' "$deny_rule"
echo
echo '== config file permissions (-P), same content, three modes =='
for mode in 600 644 664; do
  cfg="$tmp/p.$mode.syd-3"
  printf '%s\n' "$deny_rule" >"$cfg"
  chmod "$mode" "$cfg"
  run "P-mode$mode" "$root/ok/plain" -P "$cfg"
done
echo
echo '== ordering: wildcard allow first, deny second (blacklist shape) =='
run order-allow "$root/ok/plain" -m "allow/read,stat,exec+/***" -m "$deny_rule"
run order-deny "$root/secret" -m "allow/read,stat,exec+/***" -m "$deny_rule"
echo
echo '== same shape reversed, deny first (should not protect) =='
run rev-allow "$root/ok/plain" -m "$deny_rule" -m "allow/read,stat,exec+/***"
run rev-deny "$root/secret" -m "$deny_rule" -m "allow/read,stat,exec+/***"
echo
echo '== full strace if -P still refuses (all syscalls, EPERM only) =='
cfg="$tmp/p.600.syd-3"
if command -v strace >/dev/null 2>&1; then
  chmod 600 "$cfg"
  strace -f -qq -o "$tmp/s.log" "$syd" -P "$cfg" -- /bin/true >"$tmp/so" 2>&1 3>/dev/null
  printf 'engine output: %s\n' "$(head -1 "$tmp/so")"
  printf 'EPERM/EACCES returns:\n'
  grep -E '= -1 E(PERM|ACCES)' "$tmp/s.log" | tail -10 || echo '  (none: the errno is chosen in-process)'
  printf 'last 6 calls:\n'
  tail -6 "$tmp/s.log"
else
  echo 'strace missing, skipping'
fi
echo
echo '== reading =='
echo 'A mode that loads while 0664 does not means the compiler must write profiles'
echo '0600 (or pass rules with -m and never write a file). order-allow printing'
echo 'plain with order-deny exiting 13 means the blacklist shape works and the ADR'
echo 'can keep deny-rules-over-allow-all.'
printf '</SYD-PERM-ORDER>\n'
exit 0
