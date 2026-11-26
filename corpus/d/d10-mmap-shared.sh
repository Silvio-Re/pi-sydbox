#!/bin/sh
# D10 — writing to the denied file through a shared writable mapping must be denied.
#
# The chain is open(O_RDWR) then mmap PROT_WRITE MAP_SHARED then a write
# through the mapping; POSIX sh exposes no mmap, so the attempt runs as
# python3 (the engine's linux profile grants exec under /usr). A name-based
# engine denies the open itself and the verdict records where the chain
# stopped: reaching mmap at all would have required an allowed O_RDWR open
# of the denied file, and the write then really would change its content.
# probe: secret
if python3 - "$CASE_ROOT/secret" <<'PY'
import mmap, sys
path = sys.argv[1]
with open(path, "r+b") as f:
    m = mmap.mmap(f.fileno(), 0)
    m[0:8] = b"tampered"
    m.flush()
    print("d10: mapping write landed on", path)
PY
then
  echo "verdict=allow"
else
  echo "verdict=deny"
fi
