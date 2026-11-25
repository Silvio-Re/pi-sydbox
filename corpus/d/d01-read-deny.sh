#!/bin/sh
# D1 — reading a deny-globbed file must be denied.
#
# No /dev/null redirect, deliberately: with a profile that does not grant
# /dev/null the redirect itself is denied, the shell never runs the command, and
# the case reports deny without ever attempting the read. The first landstrip
# capture did exactly that (evidence: docs/evidence/m1-*/capture/d01-read-deny.log,
# a denial record on /dev/null and none on the secret). Stderr from the engine is
# left in the case log — it is the evidence of why the verdict came out as it did.
if cat "$CASE_ROOT/secret"; then echo "verdict=allow"; else echo "verdict=deny"; fi
