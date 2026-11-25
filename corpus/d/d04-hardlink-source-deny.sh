#!/bin/sh
# D4 — creating a hard link of the denied file into the allowed tree must be denied.
#
# The link(2) source names the denied path, so a rule enforced on the
# syscall's path strings must refuse the creation itself; an allow would
# mean the denied inode became reachable under a name the policy grants
# (d11 keeps going and writes through the link).
# probe: secret
# probe: ok/d04-hard
if ln "$CASE_ROOT/secret" "$CASE_ROOT/ok/d04-hard"; then
  echo "verdict=allow"
else
  echo "verdict=deny"
fi
