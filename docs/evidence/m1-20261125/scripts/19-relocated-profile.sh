#!/usr/bin/env bash
# 19-relocated-profile — the profile-relocation path, end to end.
#
# The work directory here is the repository itself, which lives on a VirtualBox
# shared folder: vboxsf forces 0770/0660 and ignores chmod, so the engine's
# trusted-path check can never be satisfied there. The extension must therefore
# keep only the profile on guest disk (placeProfile) — and the engine must accept
# that relocated file.
#
# ASSERTED: placement relocates to guest disk with mode 600; the placed
# profile carries the automatic fs cure (fsAllowFor: a statfs magic the
# engine's FS_MAGIC table does not know — 0x786f4256, vboxsf, on this host —
# would make every path grant inert); the compiled profile then grants the
# write to its vboxsf allow target; and the deny rule still holds through
# the same cured profile.
#
# DIAGNOSTIC (printed, not asserted): B1/B2 write through the compiled profile
# and a corpus-style control to a guest-ext target include_profile does not
# cover; C2 is the corpus-style control WITHOUT the fs cure, which stays denied
# — the contrast C1 granted / C2 denied isolates the fs cure as the effective
# change, not the path spelling. (The earlier vacuous-PASS era — include_profile
# linux already allows /tmp/** — died with probe targets moved off /tmp.)
#
# Run:  bash <repo>/agent_dir/spike/19-relocated-profile.sh
# Exit: 0 the asserted guarantees hold (diagnostic cells print either way).
set -uo pipefail

HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
ROOT=$(cd -- "$HERE/../.." && pwd -P)
SYD=${SYD:-"$HOME/.local/opt/syd-3.59.0/syd"}
WORK="$ROOT/agent_dir/.sydbox-probe-$$"
CACHE=${CACHE:-"$HOME/.cache/pi-sydbox-probe"}
GALLOW="$CACHE/ga"          # guest-disk allow target, not covered by include_profile

if [ ! -x "$SYD" ]; then
  printf 'engine not executable: %s\n' "$SYD" >&2
  exit 2
fi

rm -rf -- "$WORK"; mkdir -p -- "$WORK/allow" "$WORK/deny"
printf 'top secret\n' >"$WORK/deny/secret.txt"
mkdir -p -- "$GALLOW"

printf '== 1. compile and place the profile\n'
# The single-quoted body is JavaScript: ${...} there is a template literal, not a
# shell expansion (SC2016).
# shellcheck disable=SC2016
PLACED=$(ROOT_TS=$ROOT WORK=$WORK CACHE=$CACHE GALLOW=$GALLOW node --experimental-strip-types --input-type=module -e '
  const { compileProfile } = await import(`file://${process.env.ROOT_TS}/src/compiler.ts`);
  const { placeProfile, fsAllowFor } = await import(`file://${process.env.ROOT_TS}/src/launcher.ts`);
  const work = process.env.WORK;
  const gall = process.env.GALLOW;
  const policy = {
    filesystem: {
      allowWrite: [`${work}/allow`, `${gall}`],
      denyReadAlways: [`${work}/deny/secret.txt`],
    },
  };
  const profile = compileProfile(policy, "A", fsAllowFor([
    ...(policy.filesystem?.allowWrite ?? []),
    ...(policy.filesystem?.allowRead ?? []),
  ]));
  const placed = placeProfile(`${work}/profiles`, process.env.CACHE, profile);
  console.log(`RELOCATED=${placed.relocated ?? ""}`);
  console.log(`PROFILE=${placed.path}`);
')
RC=$?
if [ "$RC" -ne 0 ]; then
  printf 'place step failed (rc=%s)\n' "$RC" >&2
  rm -rf -- "$WORK"; exit 1
fi

PROFILE=$(printf '%s\n' "$PLACED" | sed -n 's/^PROFILE=//p')
RELOCATED=$(printf '%s\n' "$PLACED" | sed -n 's/^RELOCATED=//p')
printf 'profile=%s\n' "$PROFILE"
printf 'fstype(work)=%s fstype(profile)=%s\n' \
  "$(stat -f -c '%T' "$WORK")" "$(stat -f -c '%T' "$(dirname -- "$PROFILE")")"

CHECK=0
if [ -n "$RELOCATED" ]; then
  printf 'PASS relocated (%s)\n' "$RELOCATED"
else
  printf 'FAIL not relocated: the work directory accepted a profile, so this probe did not exercise the fallback\n'
  CHECK=1
fi

case "$PROFILE" in
  "$CACHE"/*) printf 'PASS profile on guest disk\n' ;;
  *) printf 'FAIL profile not under %s: %s\n' "$CACHE" "$PROFILE"; CHECK=1 ;;
esac

MODE=$(stat -c '%a' "$PROFILE" 2>/dev/null || printf 'absent')
[ "$MODE" = 600 ] && printf 'PASS mode 600\n' || { printf 'FAIL mode %s (expect 600)\n' "$MODE"; CHECK=1; }

# The extension must emit the fs cure itself on this host: statfs of the
# vboxsf allow target reports 0x786f4256 (this machine's magic), which the
# engine's FS_MAGIC table does not know, and the workbook target makes the
# placed profile carry allow/fs+0x786f4256. On a host whose work directory is
# ext-family, no such line is needed or emitted.
if grep -q '^allow/fs+0x786f4256$' "$PROFILE"; then
  printf 'PASS fs cure emitted\n'
else
  printf 'FAIL fs cure missing from the placed profile\n'
  CHECK=1
fi

# A second, hand-built profile: the corpus-validated spelling (one allow line
# with exec+readdir, exactly as corpus/profiles/syd-a.profile spells it) over the
# same allow targets, placed next to the first one.
CORPUS_PROFILE="$CACHE/corpus-style.syd-3"
mkdir -p -- "$CACHE"
{
  printf 'include_profile linux\n'
  printf 'sandbox/lock:off\n'
  printf 'allow/lpath,npath,rpath,wpath,cpath,tpath,exec,readdir+%s\n' "$GALLOW"
  printf 'allow/lpath,npath,rpath,wpath,cpath,tpath,exec,readdir+%s/***\n' "$GALLOW"
  printf 'allow/lpath,npath,rpath,wpath,cpath,tpath,exec,readdir+%s\n' "$WORK/allow"
  printf 'allow/lpath,npath,rpath,wpath,cpath,tpath,exec,readdir+%s/***\n' "$WORK/allow"
} >"$CORPUS_PROFILE" || { rm -rf -- "$WORK"; exit 1; }
chmod 600 "$CORPUS_PROFILE"

# <write cmd> <profile> <target> <label>
cell() { # cell <profile> <target-file> <label>
  local rc
  timeout 30 "$SYD" -P "$1" -- /bin/sh -c "printf ok >'$2'" >"$CACHE/cell.out" 2>&1
  rc=$?
  if [ "$rc" -eq 0 ] && [ -f "$2" ]; then
    printf 'DIAG %s: GRANTED (rc=0, file created)\n' "$3"
  else
    printf 'DIAG %s: DENIED  rc=%s out=%s\n' "$3" "$rc" "$(head -c 2000 "$CACHE/cell.out" | head -1)"
  fi
  rm -f -- "$CACHE/cell.out"
}

printf '\n== 2. diagnostic cells: does ANY of the two spellings grant a write, and on which filesystem\n'
rm -f -- "$GALLOW/f.txt" "$GALLOW/g.txt" "$WORK/allow/f.txt" "$WORK/allow/g.txt"
cell "$PROFILE"        "$GALLOW/f.txt"    "B1 compiled profile, guest disk ext target"
cell "$CORPUS_PROFILE" "$GALLOW/g.txt"    "B2 corpus spelling, guest disk ext target"
cell "$PROFILE"        "$WORK/allow/f.txt" "C1 compiled profile + auto fs-cure, vboxsf"
cell "$CORPUS_PROFILE" "$WORK/allow/g.txt" "C2 corpus spelling, no fs-cure (control), vboxsf"

# The extension now emits the fs cure itself (fsAllowFor probes the statfs magic
# of every allow target), so C1 GRANTED is the asserted end-to-end outcome:
# compiler → placement → engine enforcement. C2 stays denied: the corpus-style
# control profile has no fs rule, proving the guard is what the cure lifts.
if [ -f "$WORK/allow/f.txt" ]; then
  printf 'PASS cure granted (compiled profile writes to the vboxsf allow target)\n'
else
  printf 'FAIL cure granted (compiled profile still denied on vboxsf)\n'
  CHECK=1
fi

printf '\n== 3. the denied read through the relocated profile\n'
timeout 30 "$SYD" -P "$PROFILE" -- /bin/cat "$WORK/deny/secret.txt" >"$CACHE/cell.out" 2>&1
RC=$?
if [ "$RC" -ne 0 ] && ! grep -q 'top secret' "$CACHE/cell.out"; then
  printf 'PASS deny\n'
else
  printf 'FAIL deny rc=%s out=%s\n' "$RC" "$(head -c 2000 "$CACHE/cell.out" | head -1)"
  CHECK=1
fi
rm -f -- "$CACHE/cell.out"

rm -rf -- "$WORK"
printf '\nsummary: assert-check=%s\n' "$CHECK"
exit "$CHECK"
