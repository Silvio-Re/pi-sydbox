#!/usr/bin/env bash
# corpus/run.sh — probe harness. Contract: corpus/README.md.
#
# Runs every case script under one engine command and classifies each case.
# The engine command is held as an argv array, never as a shell string: the old
# `bash -c "exec $engine \"$script\""` re-parsed the prefix on every case, so a
# prefix containing `-m '<multi word profile>'` or a quote was split or
# evaluated by a shell. read -r -a + a per-case exec has no such step, and no
# eval anywhere.
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root="$(cd -- "$script_dir/.." && pwd -P)"
# every relative path below is repo-relative; nothing goes above this

# shellcheck disable=SC2317  # invoked indirectly: the EXIT trap set after the
# mktemp below fires this; the analyzer does not follow trap-name references
cleanup() {
  if [ -n "$scratch" ] && [ -d "$scratch" ]; then
    rm -rf -- "$scratch"
  fi
  return 0
}

usage() {
  cat <<'USAGE'
usage: bash corpus/run.sh --engine-cmd "CMD" [options]
       bash corpus/run.sh --syd PATH         [options]

--engine-cmd "CMD"       engine command prefix, split into argv on whitespace.
                         No eval and no shell expansion: only the literals
                         $PROFILE_FILE and ${PROFILE_FILE} are replaced by the
                         generated profile path (see corpus/README.md). The
                         case script path is appended as the last argument.
--syd PATH               engine binary instead of a prefix (default: syd,
                         resolved with command -v). A case is then run as
                         PATH [-P PROFILE] -- SCRIPT.
--label NAME             free-form run label. When --out is not given it names
                         the output directory results/NAME (historical
                         behaviour, used by `make corpus`). Default: eng.
--profile-template FILE  profile template; every @ROOT@ in it is replaced by
                         the case scratch root. Without it no profile file is
                         generated and PROFILE_FILE points at a missing path.
--cases "d01 d02"        keep only case files whose base name contains one of
                         these substrings. Default: every case in corpus/d and
                         corpus/p.
--timeout SECS           per-case wall-clock limit, enforced by coreutils
                         timeout(1). Default: 30.
--out DIR                output directory (summary.tsv + one .log per case).
                         Default: results/<label> when --label was given,
                         otherwise corpus/out.
--help                   print this text.

Classification, one `result` value per case:
  allow, deny, prompt   exit 0 and the case printed verdict=<that word>
  timeout               timeout(1) status 124 or 137 (TERM or KILL)
  engine-error          engine refused to start: status 126 or 127
  error                 any other status, or exit 0 with no usable verdict
engine-error and error are counted as themselves, never as deny.

Exit status: 0 all cases allow/deny/prompt, 1 any timeout/engine-error/error,
2 usage error or nothing selected, 3 engine missing or not executable (no case
is run and no per-case verdict is written).
USAGE
}

# --- options ---------------------------------------------------------------
syd=""
engine_cmd=""
label=""
label_given=0
template=""
cases_filter=""
timeout_secs=30
out_dir=""
out_given=0

while [ "$#" -gt 0 ]; do
  opt="$1"
  case "$opt" in
    --help|-h)
      usage
      exit 0
      ;;
    --syd|--engine-cmd|--label|--profile-template|--cases|--timeout|--out)
      if [ "$#" -lt 2 ]; then
        printf 'missing value for %s (try --help)\n' "$opt" >&2
        exit 2
      fi
      value="$2"
      case "$opt" in
        --syd) syd="$value" ;;
        --engine-cmd) engine_cmd="$value" ;;
        --label) label="$value"; label_given=1 ;;
        --profile-template) template="$value" ;;
        --cases) cases_filter="$value" ;;
        --timeout) timeout_secs="$value" ;;
        --out) out_dir="$value"; out_given=1 ;;
      esac
      shift 2
      ;;
    *)
      printf 'unknown option: %s (try --help)\n' "$opt" >&2
      exit 2
      ;;
  esac
done

case "$timeout_secs" in
  ''|.|*[!0-9.]*)
    printf 'invalid --timeout value: %s (seconds, integer or decimal)\n' "$timeout_secs" >&2
    exit 2
    ;;
esac

if [ -n "$syd" ]; then
  case "$syd" in
    -*) printf 'invalid --syd value: %s\n' "$syd" >&2; exit 2 ;;
  esac
fi

if [ "$out_given" -eq 1 ]; then
  :
elif [ "$label_given" -eq 1 ]; then
  out_dir="results/$label"     # unchanged from the pre-rework script
else
  out_dir="corpus/out"
fi
[ -n "$label" ] || label="eng"

# --- case selection --------------------------------------------------------
# shellcheck disable=SC2206  # the filter is a deliberate whitespace-separated list
filters=()
if [ -n "$cases_filter" ]; then
  read -r -a filters <<< "$cases_filter"
fi

case_list=()
for src in corpus/d/*.sh corpus/p/*.sh; do
  [ -e "$src" ] || continue
  name="$(basename -- "$src" .sh)"
  if [ "${#filters[@]}" -gt 0 ]; then
    matched=0
    for f in "${filters[@]}"; do
      [ -n "$f" ] || continue
      case "$name" in
        *"$f"*) matched=1; break ;;
      esac
    done
    [ "$matched" -eq 1 ] || continue
  fi
  case_list+=("$src")
done

if [ "${#case_list[@]}" -eq 0 ]; then
  printf 'no case selected (--cases "%s")\n' "$cases_filter" >&2
  exit 2
fi

# --- scratch root, fixtures, profile ---------------------------------------
# A run without --engine-cmd and without --profile-template would exec the engine
# with no profile at all, which means its built-in default: Landlock on with an
# empty allowlist, so every case dies with "syd: exec error: Permission denied"
# (rc=13, log record cap=exec sys=execve). Default to the repository profile so
# `--syd PATH` is enough for a meaningful run.
if [ -z "${engine_cmd:-}" ] && [ -z "${template:-}" ]; then
  template="$repo_root/corpus/profiles/syd-a.profile"
fi
scratch="$(mktemp -d "${TMPDIR:-/tmp}/pi-sydbox-corpus.XXXXXX")"
trap cleanup EXIT   # set only once the scratch root exists: no earlier exit can leak anything
mkdir -p -- "$scratch/ok"
printf 'secret\n' > "$scratch/secret"

# Syd only loads configuration files whose name ends in .syd-3, and refuses a
# group-writable file before reading it (both refusals are logged with a ctx of
# parse_config_file; see docs/environment.md).
profile="$scratch/profile.syd-3"
if [ -n "$template" ]; then
  if [ ! -f "$template" ]; then
    printf 'profile template not found: %s\n' "$template" >&2
    exit 2
  fi
  sed "s|@ROOT@|$scratch|g" -- "$template" > "$profile"
  # Syd refuses group-writable config files: under umask 002 the sed output is
  # 0664, and `syd -P` then exits EPERM with an empty log before reading a single
  # rule (evidenced in agent_dir/spike/09-perm-order.sh). 0600 is accepted.
  chmod 600 -- "$profile"
fi
export PROFILE_FILE="$profile"
export CASE_ROOT="$scratch"

# --- engine argv -----------------------------------------------------------
engine_argv=()
if [ -n "$engine_cmd" ]; then
  read -r -a engine_argv <<< "$engine_cmd"
  if [ "${#engine_argv[@]}" -eq 0 ]; then
    printf 'empty --engine-cmd (try --help)\n' >&2
    exit 2
  fi
  # Targeted replacement of the documented placeholder. This is not eval: the
  # token is compared as a whole word and replaced by one path, so no other
  # character in the prefix is ever interpreted.
  for i in "${!engine_argv[@]}"; do
    # shellcheck disable=SC2016  # the quoted forms below ARE the literal placeholder
    # tokens the engine argv carries; matching them verbatim (not expanded) is the point
    case "${engine_argv[$i]}" in
      '$PROFILE_FILE'|'${PROFILE_FILE}') engine_argv[i]="$profile" ;;
    esac
  done
  engine_bin="${engine_argv[0]}"
else
  engine_bin="${syd:-syd}"
fi

case "$engine_bin" in
  */*) engine_path="$engine_bin" ;;
  *) engine_path="$(command -v "$engine_bin" 2>/dev/null || true)" ;;
esac

if [ -z "$engine_path" ] || [ ! -e "$engine_path" ]; then
  printf 'engine not found: %s (%d selected case(s) unrun)\n' \
    "$engine_bin" "${#case_list[@]}" >&2
  exit 3
fi
if [ ! -f "$engine_path" ] || [ ! -x "$engine_path" ]; then
  # A host shared-folder mount never stores the exec bit, so an engine kept
  # inside the repository would land here; install it on a local filesystem
  # instead.
  printf 'engine not executable: %s (%d selected case(s) unrun)\n' \
    "$engine_path" "${#case_list[@]}" >&2
  exit 3
fi

run_argv=()
if [ -n "$engine_cmd" ]; then
  run_argv=("${engine_argv[@]}")
elif [ -n "$template" ]; then
  run_argv=("$engine_path" -P "$profile" --)
else
  run_argv=("$engine_path" --)
fi

# --- run -------------------------------------------------------------------
mkdir -p -- "$out_dir"
tsv="$out_dir/summary.tsv"
printf 'case\tverdict\trc\tresult\n' > "$tsv"

declare -A counts=([allow]=0 [deny]=0 [prompt]=0 [timeout]=0 [engine-error]=0 [error]=0)
failed=0
table=()

for src in "${case_list[@]}"; do
  name="$(basename -- "$src" .sh)"
  script="$scratch/$name.sh"
  cp -- "$src" "$script"
  # 0755, not +x: the default umask here is 002, so +x on a 0644 copy yields 0775
  # and syd's trusted-path-execution layer refuses it with
  # "exec from untrusted path blocked: user in untrusted group and file
  # group-writable" (ctx=trusted_path_execution). Keeping TPE on is deliberate —
  # the sandbox property this repository wants to mirror — so the mode is fixed
  # here rather than the check being disabled in the profile.
  chmod 0755 -- "$script"
  log="$out_dir/$name.log"

  rc=0
  if timeout -- "$timeout_secs" "${run_argv[@]}" "$script" > "$log" 2>&1; then
    rc=0
  else
    rc=$?
  fi

  verdict="$(grep -o -E 'verdict=[A-Za-z_-]+' -- "$log" | tail -n 1 | cut -d= -f2 || true)"

  if [ "$rc" -eq 124 ] || [ "$rc" -eq 137 ]; then
    result=timeout
  elif [ "$rc" -eq 126 ] || [ "$rc" -eq 127 ]; then
    result=engine-error
  elif [ "$rc" -ne 0 ]; then
    result=error
  else
    case "$verdict" in
      allow|deny|prompt) result="$verdict" ;;
      *) result=error ;;
    esac
  fi

  counts[$result]=$(( ${counts[$result]:-0} + 1 ))
  case "$result" in
    timeout|engine-error|error) failed=$(( failed + 1 )) ;;
  esac

  printf '%s\t%s\t%s\t%s\n' "$name" "$verdict" "$rc" "$result" >> "$tsv"
  table+=("$(printf '%-26s %-13s %s' "$name" "$result" "rc=$rc")")
done

printf '\n%-26s %-13s %s\n' "case" "result" "status"
for row in "${table[@]}"; do
  printf '%s\n' "$row"
done
printf '\ncounts: allow=%d deny=%d prompt=%d timeout=%d engine-error=%d error=%d\n' \
  "${counts[allow]}" "${counts[deny]}" "${counts[prompt]}" \
  "${counts[timeout]}" "${counts[engine-error]}" "${counts[error]}"
printf 'run: label=%s timeout=%ss cases=%d out=%s\n' \
  "$label" "$timeout_secs" "${#case_list[@]}" "$out_dir"
printf 'summary: %s\n' "$tsv"

if [ "$failed" -ne 0 ]; then
  exit 1
fi
exit 0
