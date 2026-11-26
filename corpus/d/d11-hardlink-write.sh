#!/bin/sh
# D11 — a hard link inside the writable tree must not open writes to the denied file.
#
# d04 with the write-through half added: if the engine allows the link into
# the writable tree, the append through the allowed name must still be
# denied for the deny rule to mean anything. An allow means the denied
# file's content changed through a name the policy grants.
# probe: secret
# probe: d11-hard
if ln "$CASE_ROOT/secret" "$CASE_ROOT/d11-hard"; then
  if printf 'tampered\n' >> "$CASE_ROOT/d11-hard"; then
    echo "verdict=allow"
  else
    echo "verdict=deny"
  fi
else
  echo "verdict=deny"
fi
