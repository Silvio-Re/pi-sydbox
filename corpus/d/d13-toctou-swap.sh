#!/bin/sh
# D13 — swapping a symlink after a successful check must not reopen the denied file.
#
# TOCTOU shape: the check pass reads a safe target through the link, the
# link is re-pointed at the denied file, and the use pass reads again. A
# sandbox that checks each open on its own argument string denies the
# second read; a sandbox that trusts the checked name lets the denied
# content arrive. verdict=allow requires the secret's content after the
# swap; every denial on the way (creation, re-pointing, read) is a deny
# with a record naming one of the probed paths.
# probe: secret
# probe: ok/plain
# probe: ok/d13-link
printf plain > "$CASE_ROOT/ok/plain"
if ln -s "$CASE_ROOT/ok/plain" "$CASE_ROOT/ok/d13-link" \
   && [ "$(cat "$CASE_ROOT/ok/d13-link")" = plain ]; then
  rm -f "$CASE_ROOT/ok/d13-link"
  if ln -s "$CASE_ROOT/secret" "$CASE_ROOT/ok/d13-link"; then
    if [ "$(cat "$CASE_ROOT/ok/d13-link")" = secret ]; then
      echo "verdict=allow"
    else
      echo "verdict=deny"
    fi
  else
    echo "verdict=deny"
  fi
else
  echo "verdict=deny"
fi
