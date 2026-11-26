#!/usr/bin/env bash
# tools/case-integrity.sh — shared case-integrity checks.
#
# Sourced (never executed) by tools/gate.sh and tools/golden-tsv.sh. Names
# the two rules from the M1 capture so an unbacked deny cannot pass the one
# or land in the golden set through the other:
#
#   1. A case script declares the path(s) it probes as `# probe:` lines
#      (one path per line, after the header summary line). A token without
#      a leading slash is CASE_ROOT-relative; an absolute token is compared
#      verbatim; the literal variables ${CASE_ROOT} and ${CASE_OUT_HOME}
#      are substituted first (no shell evaluation of anything else).
#   2. A deny verdict only counts when the engine's own record in that
#      case's log names one of the probed paths. The record line must carry
#      a deny marker (`"act":"deny"` for syd records, `reason":"deny_match"`
#      for landstrip ones); a stray cat error alone is not a record.
#
# The M1 failure this guards against: the first landstrip capture had two
# deny verdicts that measured the case's own /dev/null redirect (the record
# named /dev/null, not the probed path), so the cases no longer redirect
# there and the recorded rules make such a capture fail loudly here.

# ci_load_case_env <dir> — read the fixed-format case-env written by
# corpus/run.sh into CASE_ROOT and CASE_OUT_HOME. No eval: keys are matched
# by name.
ci_load_case_env() {
  case_env="$1/case-env"
  CASE_ROOT="" CASE_OUT_HOME=""
  if [ -f "$case_env" ]; then
    while IFS='=' read -r key value; do
      case "$key" in
        CASE_ROOT) CASE_ROOT="$value" ;;
        CASE_OUT_HOME) CASE_OUT_HOME="$value" ;;
      esac
    done < "$case_env"
  fi
}

# ci_probe_tokens <case-script> — print the declared probe tokens.
ci_probe_tokens() {
  awk '/^# probe: */ { sub(/^# probe: */, ""); if (length($0) > 0) print }' "$1"
}

# ci_expand_token <token> — expand the documented variables, then resolve a
# CASE_ROOT-relative token to its absolute path.
ci_expand_token() {
  local token="$1"
  token="${token//\$\{CASE_ROOT\}/${CASE_ROOT:-}}"
  token="${token//\$CASE_ROOT/${CASE_ROOT:-}}"
  token="${token//\$\{CASE_OUT_HOME\}/${CASE_OUT_HOME:-}}"
  token="${token//\$CASE_OUT_HOME/${CASE_OUT_HOME:-}}"
  case "$token" in
    /*) printf '%s\n' "$token" ;;
    *) printf '%s/%s\n' "${CASE_ROOT:?CASE_ROOT unknown}" "$token" ;;
  esac
}

# ci_deny_backed <case-name> <case-script> <log>
# Exit 0: the log holds an engine deny record naming a probed path.
# Exit 1: not backed (message on stderr).
ci_deny_backed() {
  local case_name="$1" script="$2" log="$3"
  local tokens token path
  if [ ! -f "$log" ]; then
    printf '%s: deny without a case log (%s)\n' "$case_name" "$log" >&2
    return 1
  fi
  tokens="$(ci_probe_tokens "$script")"
  if [ -z "$tokens" ]; then
    printf '%s: deny but the case declares no probe path; a deny cannot be attributed\n' "$case_name" >&2
    return 1
  fi
  while IFS= read -r token; do
    [ -n "$token" ] || continue
    path="$(ci_expand_token "$token")"
    # The record line must both name the probed path and carry a deny
    # marker: the path alone also appears in tool error text.
    if [ -n "$path" ] \
       && grep -F -- "$path" "$log" | grep -Eq '"act":"deny"|"reason":"deny_match"'; then
      return 0
    fi
  done <<EOF
$tokens
EOF
  printf '%s: deny without an engine record naming a probed path\n' "$case_name" >&2
  return 1
}
