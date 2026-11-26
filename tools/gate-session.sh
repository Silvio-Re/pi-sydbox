#!/usr/bin/env bash
# gate-session.sh — one-command scripted part of the gate machine session
# (docs/ROADMAP.md, P4; carries the P3 gate, the M2 canonical witness and the
# M6 state capture). Run from a FRESH clone, in a plain terminal on the gate
# machine (kernel 6.x band, x86_64, >= 4 GB RAM, build tools present):
#
#   git clone https://github.com/Silvio-Re/pi-sydbox.git ~/pi-sydbox-gate
#   cd ~/pi-sydbox-gate && bash tools/gate-session.sh
#
# Everything is captured under --work (default ~/pi-sydbox-gate-session-<ts>):
#   0. preflight  : tools present, kernel + band, versions, timestamps
#   1. backup     : the maintainer engine is copied to ~/.local/opt/syd-3.59.0
#                   -maintainer FIRST (the distro install overwrites the
#                   prefix); its sha256 is recorded
#   2. setup      : `make setup` (the P3 drill; elapsed time is recorded as
#                   the onboarding metric, method "scripted drill") + npm ci
#   3. probe      : the headless RPC dialog probe (stub engine by design)
#   4. distro     : corpus + `make gate` with the installed 6.x-default engine
#                   (label p3-gate-distro)
#   5. canonical  : M2 witness with the backed-up maintainer binary: smoke,
#                   corpus + gate (label m6-canonical), machine-lock diff
#   6. state      : AppArmor/sysctl snapshot (phase-4a input)
#   7. pack       : evidence tarball; its path is printed — attach that file
#
# Deliberately NOT scripted (printed at the end as the human tail):
#   - phase 4a/4b sudo + reboot (docs/design.md phase 4, runbook-rollback.md)
#   - the M4 flip drill sessions (interactive pi use)
#   - the 1-day M5 soak (daily-driver use)
# After the reboot run `bash tools/gate-session.sh --phase-4b` (verifies the
# sysctl, reruns corpus + gate with the installed engine, repacks evidence).
#
#   --skip-setup   engine + machine lock already provisioned (skip step 2's
#                  make setup; npm ci still runs, it is idempotent)
#   --phase-4b     post-reboot verification + repack, nothing destructive
#   --work DIR     evidence directory (default below)
#
# Exit: 0 every scripted phase green (tar path printed); 1 any phase red
# (the evidence dir is packed anyway); 2 usage.
set -uo pipefail

work="$HOME/pi-sydbox-gate-session-$(date +%Y%m%d-%H%M%S)"
skip_setup=0
phase_4b=0
usage() { sed -n '3,32p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }
while [ "$#" -gt 0 ]; do
  case "$1" in
    --work)       work="${2:?--work needs a value}"; shift 2 ;;
    --skip-setup) skip_setup=1; shift ;;
    --phase-4b)   phase_4b=1; shift ;;
    -h|--help)    usage; exit 0 ;;
    *) printf 'unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
done

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$repo_root" || exit 2
mkdir -p -- "$work/logs" "$work/results" || exit 2

failures=0
verdicts=""
record() { # record <phase> <rc> [note]
  verdicts="${verdicts}$(printf '%-10s rc=%s %s' "$1" "$2" "${3:-}")
"
  [ "$2" -eq 0 ] || failures=$((failures + 1))
}
log_phase() { # run a phase: log_phase <name> <command...>
  local name="$1"; shift
  printf '\n== %s ==\n' "$name"
  "$@" >"$work/logs/$name.log" 2>&1
  local rc=$?
  tail -n 12 "$work/logs/$name.log"
  return $rc
}

# --- 0. preflight ------------------------------------------------------------
{
  printf 'date: %s\n' "$(date -Is)"
  printf 'uname: %s\n' "$(uname -a)"
  printf 'arch: %s\n' "$(uname -m)"
  printf 'node: %s\n' "$(node --version 2>&1)"
  printf 'npm: %s\n' "$(npm --version 2>&1)"
  printf 'repo: %s\n' "$repo_root"
  printf 'band: %s\n' "$(node --experimental-strip-types src/setup.ts band --release "$(uname -r)" 2>&1)"
} >"$work/preflight.txt" 2>&1
cat "$work/preflight.txt"
missing=0
for t in make node npm python3 curl tar git; do
  command -v "$t" >/dev/null 2>&1 || { printf 'missing tool: %s\n' "$t" >&2; missing=1; }
done
tar --zstd -cf /dev/null /dev/null 2>/dev/null || { printf 'missing zstd\n' >&2; missing=1; }
if [ "$missing" -ne 0 ]; then
  printf 'preflight: install the missing tools (sudo apt install build-essential zstd curl nodejs npm python3 git), then re-run\n' >&2
  exit 1
fi
if [ "$phase_4b" -eq 1 ]; then
  : # post-reboot mode: setup already done
elif [ "$skip_setup" -eq 1 ]; then
  [ -x "$HOME/.local/opt/syd-3.59.0/syd" ] || { printf '--skip-setup: engine missing at ~/.local/opt/syd-3.59.0/syd\n' >&2; exit 1; }
  [ -f "$HOME/.local/opt/syd.lock" ] || { printf '--skip-setup: machine lock missing at ~/.local/opt/syd.lock\n' >&2; exit 1; }
fi

# --- 1. maintainer-engine backup ---------------------------------------------
engine_dir="$HOME/.local/opt/syd-3.59.0"
maint_dir="$HOME/.local/opt/syd-3.59.0-maintainer"
if [ "$phase_4b" -eq 0 ] && [ -d "$engine_dir" ] && [ ! -d "$maint_dir" ]; then
  log_phase backup cp -a "$engine_dir" "$maint_dir" \
    && printf 'maintainer binary sha256: %s\n' "$(sha256sum "$maint_dir/syd" | cut -d' ' -f1)" | tee -a "$work/logs/backup.log"
  record backup $? "copied to $maint_dir"
fi

# --- 2. the P3 drill: make setup + npm ci --------------------------------------
if [ "$phase_4b" -eq 0 ] && [ "$skip_setup" -eq 0 ]; then
  t0=$(date +%s)
  log_phase setup make setup
  setup_rc=$?
  t1=$(date +%s)
  printf 'setup elapsed: %s s (onboarding metric, method: scripted drill, excludes clone)\n' "$((t1 - t0))" \
    | tee "$work/metrics.txt"
  record setup "$setup_rc"
else
  record setup 0 "skipped (--skip-setup or --phase-4b)"
fi
log_phase npm-ci npm ci --no-audit --no-fund
record npm-ci $?

# --- 3. headless RPC probe -----------------------------------------------------
pi_cli="$repo_root/node_modules/@earendil-works/pi-coding-agent/dist/cli.js"
[ -f "$pi_cli" ] || pi_cli="$repo_root/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"
if [ "$phase_4b" -eq 0 ]; then
  if [ -f "$pi_cli" ]; then
    expect_ms="$(grep -oP 'AUTO_DENY_MS = \K[0-9_]+' src/dialog.ts | tr -d '_')"
    log_phase rpc-probe node tools/rpc-dialog-probe/run-probe.mjs \
      --pi "$pi_cli" --ext "$repo_root/src/index.ts" --repo "$repo_root" \
      --work "$work/rpc-work" --expect-timeout-ms "$expect_ms"
    record rpc-probe $? "expect ${expect_ms}ms"
  else
    record rpc-probe 1 "pi cli.js not found after npm ci"
  fi
fi

# --- 4/5. corpus + gate (distro default, then maintainer canonical) -----------
run_corpus() { # run_corpus <label> <engine-path>
  local label="$1" engine="$2"
  log_phase "corpus-$label" make corpus \
    ENGINE="$engine -P \$PROFILE_FILE --" \
    PROFILE=corpus/profiles/syd-a.profile LABEL="$label"
  local rc=$?
  record "corpus-$label" "$rc"
  if [ "$rc" -eq 0 ] && [ -f "results/$label/summary.tsv" ]; then
    log_phase "gate-$label" make gate RESULTS="results/$label/summary.tsv"
    record "gate-$label" $?
  else
    record "gate-$label" 1 "no summary.tsv"
  fi
  cp -a "results/$label" "$work/results/" 2>/dev/null \
    || printf 'warning: no results/%s to copy\n' "$label" >&2
}
if [ "$phase_4b" -eq 1 ]; then
  sysctl_now="$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>&1)"
  { printf 'apparmor_restrict_unprivileged_userns: %s\n' "$sysctl_now"; uname -a; } >"$work/phase-4b-check.txt"
  cat "$work/phase-4b-check.txt"
  if [ "$sysctl_now" = "1" ]; then
    record sysctl 0 "back to 1"
  else
    record sysctl 1 "expected 1, got $sysctl_now"
  fi
  run_corpus m6-4b "$engine_dir/syd"
else
  run_corpus p3-gate-distro "$engine_dir/syd"
  if [ -x "$maint_dir/syd" ]; then
    log_phase smoke-maintainer bash tools/setup/03-smoke.sh "$maint_dir/syd"
    record smoke-maintainer $?
    run_corpus m6-canonical "$maint_dir/syd"
  else
    record canonical 1 "maintainer backup missing ($maint_dir)"
  fi
  # machine-lock record: the provisioned lock, plus write-lock's printed diff
  cp -- "$HOME/.local/opt/syd.lock" "$work/syd.lock.capture" 2>/dev/null || record lock-capture 1 "no machine lock"
  log_phase lock-diff node --experimental-strip-types src/setup.ts write-lock \
    --repo-lock syd.lock --engine "$engine_dir/syd" --out "$work/machine-lock-check.json"
  record lock-diff $?
fi

# --- 6. AppArmor/sysctl state (phase-4a input) --------------------------------
{
  printf 'apparmor_restrict_unprivileged_userns: %s\n' \
    "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>&1)"
  if compgen -G '/etc/apparmor.d/*landstrip*' >/dev/null; then
    ls -la /etc/apparmor.d/*landstrip*
  else
    printf '(no landstrip conffiles in /etc/apparmor.d)\n'
  fi
  printf 'engine wrapper sha256: %s\n' "$(sha256sum "$engine_dir/syd" 2>/dev/null | cut -d' ' -f1)"
  printf 'engine binary sha256: %s\n' "$(sha256sum "$engine_dir/syd.bin" 2>/dev/null | cut -d' ' -f1)"
  "$engine_dir/syd" --version 2>&1 | head -n 2
} >"$work/apparmor-engine-state.txt" 2>&1

# --- 7. pack -------------------------------------------------------------------
printf '\n== verdicts ==\n%s' "$verdicts" | tee "$work/verdicts.txt"
tar czf "$work.tar.gz" -C "$work" . 2>/dev/null || tar czf "$work.tar.gz" "$work"
printf '\n<SYD-GATE-SESSION>\nwork=%s\ntar=%s\nfailures=%s\n</SYD-GATE-SESSION>\n' \
  "$work" "$work.tar.gz" "$failures"
printf 'human tail (NOT scripted):\n'
printf '  phase 4a/4b: docs/design.md phase 4 + docs/runbook-rollback.md (sudo, reboot),\n'
printf '               then: bash tools/gate-session.sh --phase-4b\n'
printf '  M4 flip drill: pi install ./pi-sydbox <-> pi install npm:pi-landstrip@0.20.29\n'
printf '               (both sessions green, twice; second can ride the soak)\n'
printf '  M5 soak (1 day, daily pi-web): checklist in docs/ROADMAP.md P4\n'
if [ "$failures" -ne 0 ]; then
  printf 'session: %s phase(s) red — attach the tar anyway\n' "$failures"
  exit 1
fi
printf 'session: all scripted phases green — attach %s\n' "$work.tar.gz"
exit 0
