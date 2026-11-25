#!/usr/bin/env bash
# tools/golden-tsv.sh — turn a corpus run's summary.tsv into expectations rows.
#
# The golden set records what an engine *did*, never what it should have done. A
# row is therefore written from a captured run, and a capture that produced an
# unclassified result (timeout, engine-error, error) is refused outright rather
# than recorded as a verdict: a golden row that nobody measured is worse than a
# missing one, because it silently becomes the baseline another engine is judged
# against. Format and comparison rule: expectations/README.md.
#
# Usage:
#   bash tools/golden-tsv.sh --summary results/landstrip-golden/summary.tsv \
#        --engine landstrip --version 0.20.29 [--date YYYY-MM-DD] [--notes DIR]
#
# --summary  summary.tsv written by corpus/run.sh (case, verdict, rc, result)
# --engine   engine name recorded in the golden set (landstrip, syd)
# --version  engine version string, recorded verbatim
# --date     capture date, default: today (UTC-independent, plain `date +%F`)
# --notes    directory holding the case scripts, default: corpus/d; the note
#            column is the case script's own header summary line, so the note
#            cannot drift from the probe it describes
# --run      run directory of the capture (next to summary.tsv): when given,
#            a deny is refused as a row unless that case's log holds an
#            engine record naming one of the case's declared probe paths
#            (tools/case-integrity.sh; the M1 /dev/null lesson)
# --out      write to this file instead of standard output
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"

usage() { sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

summary=""
engine=""
version=""
date_str="$(date +%F)"
notes_dir="$repo_root/corpus/d"
run_dir=""
out=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --summary|--engine|--version|--date|--notes|--run|--out)
      if [ "$#" -lt 2 ]; then printf 'missing value for %s\n' "$1" >&2; exit 2; fi
      case "$1" in
        --summary) summary="$2" ;;
        --engine) engine="$2" ;;
        --version) version="$2" ;;
        --date) date_str="$2" ;;
        --notes) notes_dir="$2" ;;
        --run) run_dir="$2" ;;
        --out) out="$2" ;;
      esac
      shift 2
      ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'unknown option: %s\n' "$1" >&2; exit 2 ;;
  esac
done

if [ -z "$summary" ] || [ -z "$engine" ] || [ -z "$version" ]; then
  printf 'usage: bash tools/golden-tsv.sh --summary FILE --engine NAME --version VERSION\n' >&2
  exit 2
fi
if [ ! -f "$summary" ]; then
  printf 'summary not found: %s\n' "$summary" >&2
  exit 2
fi
if ! printf '%s' "$date_str" | grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'; then
  printf 'invalid --date (want YYYY-MM-DD): %s\n' "$date_str" >&2
  exit 2
fi

# note_for <case> — the case script's header summary line, the first `#` line
# after the shebang. The rest of a long header is explanation for a reader of the
# script; the golden file keeps the line that names what the case asserts.
note_for() {
  local name="$1" script="$2"
  if [ ! -f "$script" ]; then
    printf 'no case script (%s)' "$name"
    return 0
  fi
  awk 'NR==1 { next }
       /^#/ { sub(/^#[ ]?/, ""); print; exit }
       NF { exit }' "$script"
}

if [ -n "$run_dir" ]; then
  # Deny rows are checked against the run's logs: the shared case-integrity
  # rules live in one place for this script and tools/gate.sh.
  # shellcheck source=tools/case-integrity.sh
  source "$repo_root/tools/case-integrity.sh"
  ci_load_case_env "$run_dir"
fi

tmp="$(mktemp "${TMPDIR:-/tmp}/golden-tsv.XXXXXX")"
trap 'rm -f -- "$tmp"' EXIT
printf 'case\tengine\tversion\tverdict\tdate\tnote\n' > "$tmp"

rows=0
bad=0
while IFS= read -r line; do
  # Tab is IFS whitespace, so `read -r a b c d` collapses an empty field and
  # shifts the rest (a case with an empty verdict then reports result= empty).
  # Split on the delimiter explicitly instead.
  case_name="${line%%$'\t'*}"
  rest="${line#*$'\t'}"
  verdict="${rest%%$'\t'*}"
  rest="${rest#*$'\t'}"
  result="${rest#*$'\t'}"
  [ -n "$case_name" ] || continue
  [ "$case_name" = case ] && continue     # the capture's own header line
  # corpus/p cases are deliberate policy probes and are never part of the
  # golden set (corpus/p/README.md); a summary that ran them just skips them.
  [ -f "$repo_root/corpus/p/$case_name.sh" ] && continue
  case "$result" in
    allow|deny|prompt) ;;
    *)
      printf 'refusing to record %s: result=%s (a capture must classify every case)\n' \
        "$case_name" "$result" >&2
      bad=1
      continue
      ;;
  esac
  if [ -z "$verdict" ]; then
    printf 'refusing to record %s: empty verdict\n' "$case_name" >&2
    bad=1
    continue
  fi
  # Case integrity: a deny row must carry its engine record. Without --run
  # there is no log to check and the row is recorded as before (the option
  # is what `make capture` passes).
  if [ "$verdict" = "deny" ] && [ -n "$run_dir" ]; then
    if ! ci_deny_backed "$case_name" "$notes_dir/$case_name.sh" \
                        "$run_dir/$case_name.log"; then
      printf 'refusing to record %s: deny without a backing record\n' "$case_name" >&2
      bad=1
      continue
    fi
  fi
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$case_name" "$engine" "$version" "$verdict" "$date_str" \
    "$(note_for "$case_name" "$notes_dir/$case_name.sh")" >> "$tmp"
  rows=$((rows + 1))
done < "$summary"
unset line rest case_name verdict result

if [ "$bad" -ne 0 ]; then
  printf 'golden set not written: %d case(s) unclassified or unbacked\n' "$bad" >&2
  exit 1
fi
if [ "$rows" -eq 0 ]; then
  printf 'golden set not written: no case row in %s\n' "$summary" >&2
  exit 1
fi

if [ -n "$out" ]; then
  mkdir -p -- "$(dirname -- "$out")"
  cp -- "$tmp" "$out"
  printf 'wrote %d row(s) to %s\n' "$rows" "$out" >&2
else
  cat -- "$tmp"
fi
