#!/bin/sh
# D14 — thirty denied operations in one run: the engine must deny every one.
#
# Corpus-side stand-in for the prompt-storm probe: it stresses only the
# engine's per-operation denial path (30 operations naming the denied file
# across append, truncate-in-place, hard link, rename-onto and
# open-create). The dialog half — prompts per operation, session prompt
# budget — is pi-side state and belongs to the soak (roadmap M5), not to
# this corpus case. One succeeded operation is a partial bypass and flips
# the verdict to allow.
# probe: secret
i=0
ok=0
while [ "$i" -lt 30 ]; do
  case $((i % 5)) in
    0) echo x >> "$CASE_ROOT/secret" ;;
    1) printf 'x' > "$CASE_ROOT/secret" ;;
    2) ln "$CASE_ROOT/secret" "$CASE_ROOT/ok/d14-$i" ;;
    3) touch "$CASE_ROOT/secret" ;;
    4) mv "$CASE_ROOT/secret" "$CASE_ROOT/ok/d14-moved" ;;
  esac && ok=$((ok + 1))
  i=$((i + 1))
done
echo "d14: $ok of 30 operations succeeded"
if [ "$ok" -eq 0 ]; then
  echo "verdict=deny"
else
  echo "verdict=allow"
fi
