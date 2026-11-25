#!/bin/sh
# D9 — reaching the denied file through the /proc/self/root magic link must be denied.
#
# The open names the magic-link path, which resolves to the denied file.
# Whichever string the engine checks — the raw /proc path or the resolved
# secret — one of the two probes backs a deny; verdict=allow requires the
# secret's content to arrive through the traversal.
# probe: secret
# probe: /proc/self/root${CASE_ROOT}/secret
if [ "$(cat /proc/self/root"$CASE_ROOT/secret")" = secret ]; then
  echo "verdict=allow"
else
  echo "verdict=deny"
fi
