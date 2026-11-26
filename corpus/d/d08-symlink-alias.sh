#!/bin/sh
# D8 — reading through a symlink that points at the denied file must be denied.
#
# Path rules are enforced on syscall argument strings, so an alias the deny
# list does not name is the classic string-mismatch bypass: create the link
# inside the allowed tree, then read through it. verdict=allow requires the
# secret's content to actually arrive through the link — anything denied on
# the way (creation or read) is a deny backed by a record naming one of the
# probed paths.
# probe: secret
# probe: ok/d08-link
if ln -s "$CASE_ROOT/secret" "$CASE_ROOT/ok/d08-link"; then
  if [ "$(cat "$CASE_ROOT/ok/d08-link")" = secret ]; then
    echo "verdict=allow"
  else
    echo "verdict=deny"
  fi
else
  echo "verdict=deny"
fi
