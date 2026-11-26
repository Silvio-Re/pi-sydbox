#!/bin/sh
# D2 — appending to a deny-globbed file must be denied.
#
# The 0.20 "append allowed" report did not reproduce on 0.20.29: the capture of
# 2026-11-25 recorded a deny_match on openat with flags O_WRONLY,O_CREAT,O_APPEND
# (docs/evidence/m1-*/capture/d02-append-deny.log). Keep the case: a compiled
# profile that only checks truncate or O_WRONLY would still allow the append.
#
# No /dev/null redirect (see d01): the verdict must come from the append alone.
# probe: secret
if echo tampered >> "$CASE_ROOT/secret"; then echo "verdict=allow"; else echo "verdict=deny"; fi
