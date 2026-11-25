#!/bin/sh
# p01 — read posture: a policy that grants only the scratch root must deny a read outside it.
#
# Rationale: this pins the deny-by-default claim (design.md invariant 5,
# README hard invariant 5) to a measured verdict instead of a design
# assertion — the probe reads a plain file in run.sh's out-of-grant fixture
# home (CASE_OUT_HOME), and the corpus policy grants nothing there.
# Deliberate widening: none; the expected verdict is deny. corpus/p rule:
# never compared against the golden set.
# probe: ${CASE_OUT_HOME}/plain
if [ -z "${CASE_OUT_HOME:-}" ]; then
  echo "verdict=error"
  exit 0
fi
if cat "$CASE_OUT_HOME/plain" > "$CASE_ROOT/ok/p01-out"; then
  echo "verdict=allow"
else
  echo "verdict=deny"
fi
