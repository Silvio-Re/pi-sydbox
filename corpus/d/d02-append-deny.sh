#!/bin/sh
# D2 — appending to a deny-globbed file must be denied.
# Regression target: landstrip 0.20.29 allowed the append (case-insensitive O_APPEND bug).
if echo tampered >> "$CASE_ROOT/secret" 2>/dev/null; then echo "verdict=allow"; else echo "verdict=deny"; fi
