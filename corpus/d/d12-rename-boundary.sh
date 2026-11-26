#!/bin/sh
# D12 — renaming an allowed file onto the denied path must be denied.
#
# The rename destination is the denied path, so a rule enforced on the
# syscall's path strings must refuse the move; an allow would mean the
# denied file was replaced by allowed content in one syscall (an allowed
# move really does overwrite the secret — that is the bypass the row
# measures, and the verdict records it as allow, not as an error).
# probe: secret
# probe: ok/plain
printf plain > "$CASE_ROOT/ok/plain"
if mv "$CASE_ROOT/ok/plain" "$CASE_ROOT/secret"; then
  echo "verdict=allow"
else
  echo "verdict=deny"
fi
