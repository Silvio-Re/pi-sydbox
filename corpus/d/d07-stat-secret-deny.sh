#!/bin/sh
# D7 — stat of the denied path must be denied (no existence leak).
#
# The design row's concern is the existence leak: a path rule denied on
# the lookup hides both the content and the existence of the deny-globbed
# path, while an allow hands the sandboxed process the metadata (existence,
# size, mode). The table the stat prints lands in the case log when the
# engine allows it; a deny is backed by a record naming the probed path.
# probe: secret
if stat "$CASE_ROOT/secret"; then
  echo "verdict=allow"
else
  echo "verdict=deny"
fi
