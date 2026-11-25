#!/bin/sh
# D3 — rename and unlink of a deny-globbed path must both be denied.
#
# No /dev/null redirect (see d01): with a profile that does not grant /dev/null,
# both redirects were denied, neither mv nor rm ever ran, and the verdict said
# deny for a reason the case was not testing.
if mv "$CASE_ROOT/secret" "$CASE_ROOT/ok/moved"; then
  echo "verdict=allow"
elif rm -f "$CASE_ROOT/secret" && [ ! -e "$CASE_ROOT/secret" ]; then
  echo "verdict=allow"
else
  echo "verdict=deny"
fi
