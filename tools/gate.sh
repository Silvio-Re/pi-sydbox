#!/usr/bin/env bash
# tools/gate.sh — compare a corpus run against the golden set.
#
# Input: the summary.tsv of a run someone already produced (with
# corpus/run.sh), plus the per-case logs next to it. No engine is started:
# the gate is a comparison over a run directory, nothing more.
#
# Semantics (contract in expectations/README.md and docs/ROADMAP.md P1.4):
#   - Golden rows come from expectations/*.tsv, one row at a time. Strictness
#     order is allow < prompt < deny; a run verdict equal to the golden row or
#     stricter passes; wider fails, named with the case and both verdicts.
#     Golden rows exist only where a capture produced them; the gate never
#     invents predicted rows for new cases.
#   - A D case without a golden row still has to classify: timeout,
#     engine-error and error never pass, they fail the gate with the case
#     named. Any classified verdict (allow, prompt, deny) passes the
#     non-golden check itself.
#   - Case integrity, both M1 rules: a deny only counts when an engine
#     record in that case's log names one of the case's declared probe
#     paths (tools/case-integrity.sh); a D case the harness could not
#     classify fails however its golden row reads. The D2 row is covered
#     like every other golden row and nothing in this tool's output says
#     anything about append behavior: the row is a regression row, and the
#     d02 case, not this comparison, is what rejects a truncation-only
#     profile.
#   - corpus/p cases are deliberate policy changes and p rows are never
#     compared: they are counted and ignored.
#
# Usage:
#   bash tools/gate.sh --summary results/<label>/summary.tsv \
#        [--expectations expectations] [--corpus-d corpus/d] [--corpus-p corpus/p]
#   make gate RESULTS=results/<label>/summary.tsv
#
# Exit status: 0 pass, 1 failure (named cases), 2 usage error.
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"

usage() { sed -n '2,31p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

summary=""
expectations="$repo_root/expectations"
corpus_d="$repo_root/corpus/d"
corpus_p="$repo_root/corpus/p"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --summary|--expectations|--corpus-d|--corpus-p)
      if [ "$#" -lt 2 ]; then printf 'missing value for %s\n' "$1" >&2; exit 2; fi
      case "$1" in
        --summary) summary="$2" ;;
        --expectations) expectations="$2" ;;
        --corpus-d) corpus_d="$2" ;;
        --corpus-p) corpus_p="$2" ;;
      esac
      shift 2
      ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'unknown option: %s\n' "$1" >&2; exit 2 ;;
  esac
done

if [ -z "$summary" ]; then
  printf 'usage: bash tools/gate.sh --summary results/<label>/summary.tsv\n' >&2
  exit 2
fi
if [ ! -f "$summary" ]; then
  printf 'summary not found: %s\n' "$summary" >&2
  exit 2
fi
run_dir="$(dirname -- "$summary")"

# shellcheck source=tools/case-integrity.sh
source "$repo_root/tools/case-integrity.sh"
ci_load_case_env "$run_dir"

# rank: strictness order allow < prompt < deny. Unranked values never reach
# here as a pass: the per-case loop below fails them first.
rank() {
  case "$1" in
    allow) printf '0\n' ;;
    prompt) printf '1\n' ;;
    deny) printf '2\n' ;;
    *) printf '?\n' ;;
  esac
}

# --- the run's verdicts ----------------------------------------------------
declare -A seen_case=() seen_result=()
result_fields() { # line -> name result (tab-safe split, verdict col skipped)
  local line="$1" rest
  case_name="${line%%$'\t'*}"
  rest="${line#*$'\t'}"
  rest="${rest#*$'\t'}"        # skip verdict
  rest="${rest#*$'\t'}"        # skip rc
  row_result="${rest%%$'\t'*}"
}

while IFS= read -r line || [ -n "$line" ]; do
  [ -n "$line" ] || continue
  # shellcheck disable=SC2317  # helper above mutates these variables
  result_fields "$line"
  [ -n "$case_name" ] || continue
  [ "$case_name" = "case" ] && continue
  seen_case["$case_name"]=1
  seen_result["$case_name"]="$row_result"
done < "$summary"

# --- case scripts ----------------------------------------------------------
shopt -s nullglob
d_scripts=("$corpus_d"/*.sh)
p_scripts=("$corpus_p"/*.sh)
shopt -u nullglob

failures=()
pass_deny=0
fail() { failures+=("$1"); }

for script in "${d_scripts[@]}"; do
  name="$(basename -- "$script" .sh)"
  if [ -z "${seen_case[$name]:-}" ]; then
    fail "$name: no row in the summary (the corpus run skipped a D case)"
    continue
  fi
  result="${seen_result[$name]:-}"
  case "$result" in
    allow|prompt|deny)
      # Case integrity rule: a deny is only a deny with a record backing it.
      if [ "$result" = "deny" ]; then
        if ci_deny_backed "$name" "$script" "$run_dir/$name.log"; then
          pass_deny=$((pass_deny + 1))
        else
          fail "$name: deny without an engine record naming a probed path"
        fi
      fi
      ;;
    timeout|engine-error|error)
      fail "$name: unclassified result ($result), never a pass"
      ;;
    *)
      fail "$name: unparseable result ($result)"
      ;;
  esac
done

# --- golden rows -----------------------------------------------------------
golden_pass=0
golden_files=0
for golden in "$expectations"/*.tsv; do
  [ -f "$golden" ] || continue
  golden_files=$((golden_files + 1))
  while IFS= read -r line || [ -n "$line" ]; do
    [ -n "$line" ] || continue
    g_case="${line%%$'\t'*}"
    rest="${line#*$'\t'}"
    rest="${rest#*$'\t'}"     # engine
    rest="${rest#*$'\t'}"     # version
    g_verdict="${rest%%$'\t'*}"
    [ -n "$g_case" ] || continue
    [ "$g_case" = "case" ] && continue
    if [ -z "${seen_case[$g_case]:-}" ]; then
      fail "$g_case: golden row ($golden: verdict=$g_verdict) but no row in the summary"
      continue
    fi
    result="${seen_result[$g_case]:-}"
    case "$result" in
      allow|prompt|deny) ;;
      *) continue ;; # already failed above as unclassified
    esac
    run_rank="$(rank "$result")"
    golden_rank="$(rank "$g_verdict")"
    if [ "$golden_rank" = "?" ]; then
      fail "$g_case: golden row with unranked verdict ($g_verdict)"
      continue
    fi
    if [ "$run_rank" -lt "$golden_rank" ]; then
      fail "$g_case: wider than the golden row (golden=$g_verdict, run=$result)"
    else
      golden_pass=$((golden_pass + 1))
    fi
  done < "$golden"
done

# --- report ----------------------------------------------------------------
p_count="${#p_scripts[@]}"
printf 'run: %s\n' "$summary"
printf 'golden rows passed: %d (from %d file(s) in %s)\n' \
  "$golden_pass" "$golden_files" "$expectations"
printf 'D cases checked: %d (deny verdicts with a backing record: %d)\n' \
  "${#d_scripts[@]}" "$pass_deny"
printf 'p cases: %d (never compared)\n' "$p_count"

if [ "${#failures[@]}" -gt 0 ]; then
  printf '\nFAIL: %d\n' "${#failures[@]}"
  for f in "${failures[@]}"; do
    printf '  %s\n' "$f"
  done
  exit 1
fi
printf 'PASS\n'
