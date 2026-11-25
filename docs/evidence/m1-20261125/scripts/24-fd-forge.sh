#!/usr/bin/env bash
# 24-fd-forge — the record channel must be unforgeable by the workload.
#
# Context (external review S1, confirmed in syd 3.59.0 source): the wrap shell
# opens the record log as `exec 3>>log` and the engine keeps SYD_LOG_FD raw —
# no FD_CLOEXEC is set anywhere on that path (log/mod.rs log_init stores the
# number; trace/force_cloexec only marks fds the child itself creates). The
# sandboxed child therefore inherits fd 3 open-for-append, and write(2) on a
# numeric fd is unmediated: the workload could append forged denial records
# and farm the approval dialogs.
#
# Fix history: attempt 1 marked fd 3 CLOEXEC in the wrap shell (rejected —
# syd is exec'd by that same shell, so the engine's own channel died,
# verdict 20261125-105950). The shipped fix keeps the fd inheritable into
# the engine and seals one level down: the workload's first statement is
# `exec 3>&-`, then the log path's standing denies block every reopen
# (syd checks the canonical path, so /proc/self/fd/3 resolves to the
# denied log path).
#
# Probe history: the first probe used `[ -e /proc/self/fd/3 ]` as the
# visibility test and grep '"path":"/never.txt"' for the engine's record —
# both wrong (verdicts 105950/110147: fixed cell "empty", records "missing").
# The visibility test is now the attack itself: a write to fd 3, which is
# exactly the channel to close. The record grep now uses the canonical path.
# Evidence of the workload's own stdout/stderr and the raw sink is printed
# and kept on failure (DEBUGCOPY=1 forces the dump+keep on PASS too).
#
# ASSERTED:
#   - fixed shape: the workload cannot write fd 3 (EBADF after the closer),
#     so no forged record can reach the sink whatever the procfs posture;
#   - the engine's real denial record IS in the sink (the seal did not
#     break the channel — the defect of the CLOEXEC attempt);
#   - no forged bytes land in the sink;
#   - no forged bytes land in the sink;
#   - the engine's real denial record IS in the sink (the seal did not
#     break the channel — the defect of the CLOEXEC attempt);
#   - control cell (diagnostic, never fatal): syd 3.59.0 closes inherited
#     fds for the workload itself (every control cell on host saw EBADF
#     without any closer), so the engine's own fd hygiene is reported;
#     if a future engine leaks instead, the closer becomes load-bearing
#     and the fixed cell's seal assert still guards the wrap.
#
# Guest /tmp, not the vboxsf checkout (corpus rule: grants are inert there).
# Run:  bash <repo>/agent_dir/spike/24-fd-forge.sh
# Exit: 0 the record channel is unforgeable for the contained workload.
set -uo pipefail

SYD=${SYD:-"$HOME/.local/opt/syd-3.59.0/syd"}
WORK=$(mktemp -d @SCRATCH@)
LOG="$WORK/records.jsonl"

if [ ! -x "$SYD" ]; then
  printf 'engine not executable: %s\n' "$SYD" >&2
  exit 2
fi

PROFILE="$WORK/probe.syd-3"
{
  printf 'include_profile linux\n'
  printf 'sandbox/lock:off\n'
  printf 'allow/lpath,npath,rpath,wpath,cpath,tpath,exec,readdir+%s/***\n' "$WORK"
  printf 'deny/lpath,npath,rpath,wpath,cpath,tpath+%s/never.txt\n' "$WORK"
} >"$PROFILE"
chmod 600 "$PROFILE"
printf seed >"$WORK/never.txt"

# The probe payload confined by the engine. $1 = answer file. The forged
# write IS the test: if fd 3 is open-for-append in the child, the bytes land
# in the sink (control, pre-fix shape); after the closer, write(2) is EBADF.
# A real denial follows so the engine's channel aliveness is on record.
PAYLOAD='
  out="$1"; ok=fd3unwritable; msg=""
  if printf "FORGED-BY-CHILD " >&3 2>/dev/null; then ok=fd3writable; fi
  cat "$(dirname "$1")/never.txt" >/dev/null 2>&1 || msg="$msg real-deny-happened"
  printf "%s %s" "$ok" "$msg" > "$out"
'
export PAYLOAD

run_case() {  # <fixed|control> <logfile>
  local tag=$1 logf=$2 payload
  shift 2
  # Same nested pi-shape scaffolding as probe 22's known-good cells, with
  # the -P that probe 21 uses: without it syd treats the profile PATH as the
  # workload to execve (host evidence 20261125-110147: `syd: exec error:
  # Permission denied`, execve denied ON probe.syd-3 — the payload never ran).
  # The fixed workload carries the shipped seal as its first statement; the
  # control workload is the bare pre-fix shape.
  if [ "$tag" = fixed ]; then payload="exec 3>&-; $PAYLOAD"; else payload="$PAYLOAD"; fi
  /bin/bash -c '
    exec 3>>"$1" || { echo open-fd-failed; exit 9; }
    SYD_LOG_FD=3 LC_ALL=C timeout 30 "$2" -P "$3" -- /bin/bash -c "$4" x "$5"
  ' x "$logf" "$SYD" "$PROFILE" "$payload" "$WORK/see-$tag" >"$WORK/cmd-$tag.out" 2>&1
}

run_case fixed "$LOG"
run_case control "$WORK/control.jsonl"

CHECK=0
FIXED=$(cat "$WORK/see-fixed" 2>/dev/null || true)
CTRL=$(cat "$WORK/see-control" 2>/dev/null || true)
FORGED=$(grep -c 'FORGED-BY-CHILD' "$LOG" 2>/dev/null || true)
RLIMIT=$(grep -cF "\"path\":\"$WORK/never.txt\"" "$LOG" 2>/dev/null || true)

dump() {  # <tag> <logfile> — evidence for a failing cell
  printf '  [evidence] %s: see=<%s>\n' "$1" "$(cat "$WORK/see-$1" 2>/dev/null || echo NO-FILE)"
  printf '  [evidence] %s shell output: <%s>\n' "$1" "$(head -c 400 "$WORK/cmd-$1.out" 2>/dev/null | tr '\n' ' ')"
  printf '  [evidence] %s sink (%s line(s)): <%s>\n' "$1" \
    "$(wc -l <"$2" 2>/dev/null || echo '?')" "$(head -c 400 "$2" 2>/dev/null | tr '\n' ' ')"
}

case "$FIXED" in
  'fd3unwritable '*|fd3unwritable)
    printf 'PASS fixed shape: the workload cannot write the record fd\n'
    ;;
  fd3writable*)
    printf 'FAIL fixed shape: the workload wrote fd 3 (%s)\n' "$FIXED"
    CHECK=1; dump fixed "$LOG"
    ;;
  *)
    printf 'FAIL fixed cell produced no verdict (%s)\n' "${FIXED:-empty}"
    CHECK=1; dump fixed "$LOG"
    ;;
esac

if [ "${FORGED:-0}" -ge 1 ]; then
  printf 'FAIL forged bytes landed in the sink (%s occurrence(s))\n' "$FORGED"
  CHECK=1; dump fixed "$LOG"
else
  printf 'PASS no forged bytes reached the sink\n'
fi
if [ "${RLIMIT:-0}" -ge 1 ]; then
  printf 'PASS engine records still reach the sealed sink (%s real denial(s))\n' "$RLIMIT"
else
  printf 'FAIL engine records no longer reach the sink\n'
  CHECK=1; dump fixed "$LOG"
fi

case "$CTRL" in
  fd3writable*)
    printf 'INFO control cell: this engine leaks fd 3 to the workload — the closer is load-bearing\n'
    ;;
  *)
    # Host evidence (verdicts 105950/110147/111134): every control cell sees
    # EBADF on fd 3 — syd 3.59.0 closes inherited fds for the sandboxed
    # workload itself. The closer stays as defense-in-depth (and covers
    # engines without this hygiene); it cannot be vacuously tested here.
    printf 'INFO control cell: engine closes inherited fds for the workload (syd 3.59.0 self-hygiene); closer is defense-in-depth\n'
    ;;
esac

printf 'VERDICT-FD3 fixed=%s control=%s forged=%s real=%s\n' "${FIXED:-?}" "${CTRL:-?}" "${FORGED:-?}" "${RLIMIT:-?}"
if [ "$CHECK" -eq 0 ] && [ "${DEBUGCOPY:-0}" != 1 ]; then
  rm -rf -- "$WORK"
else
  printf 'probe dir kept for evidence: %s\n' "$WORK"
fi
printf 'summary: assert-check=%s\n' "$CHECK"
exit "$CHECK"
