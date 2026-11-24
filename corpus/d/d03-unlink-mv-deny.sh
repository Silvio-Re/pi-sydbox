#!/bin/sh
# D3 — rename and unlink of a deny-globbed path must both be denied.
if mv "$CASE_ROOT/secret" "$CASE_ROOT/ok/moved" 2>/dev/null; then
  echo "verdict=allow"
elif rm -f "$CASE_ROOT/secret" 2>/dev/null && [ ! -e "$CASE_ROOT/secret" ]; then
  echo "verdict=allow"
else
  echo "verdict=deny"
fi
