#!/bin/sh
# D1 — reading a deny-globbed file must be denied.
if cat "$CASE_ROOT/secret" >/dev/null 2>&1; then echo "verdict=allow"; else echo "verdict=deny"; fi
