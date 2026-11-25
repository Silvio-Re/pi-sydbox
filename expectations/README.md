# Recorded decisions (the golden set)

One line per case per engine: what that engine *did* when the case ran, captured
in a plain terminal. Nothing here is a prediction — a row exists only because a
run produced it, and `tools/golden-tsv.sh` refuses to emit a row for a case the
harness could not classify (`timeout`, `engine-error`, `error`).

`docs/design.md:92-107` holds the *expected* table (D1-D14, several still
"to measure"). Where this file and that table disagree, this file is the record
and the table gets corrected.

## Format

Tab-separated, one header line, six columns:

| column | content |
|---|---|
| `case` | case name as `corpus/run.sh` reports it — the script's base name, no `.sh` |
| `engine` | `landstrip`, `syd` — free-form, but one name per engine and never renamed |
| `version` | engine version string, verbatim (`landstrip --version`) |
| `verdict` | `allow`, `deny` or `prompt` — exactly the value the case printed |
| `date` | capture date, `YYYY-MM-DD` |
| `note` | the case script's header summary line (first `#` line after the shebang), so the note cannot drift from the probe |

A case may appear once per engine per version. Two rows for the same
(case, engine, version) is a capture error, not a second opinion.

## Comparison rule

A differential (`corpus/d/`) means: same policy, both engines, decision compared
against the golden row. Order of strictness:

```
allow  <  prompt  <  deny
```

- syd decides **equal or stricter** than the golden row: pass.
- syd decides **wider** (allow where the golden says prompt or deny; prompt where
  the golden says deny): fail, named case and both verdicts.
- `timeout`, `engine-error` and `error` are never a pass and never a verdict.

D2 is recorded as `deny`: landstrip 0.20.29 denied the append (`openat` with
`O_WRONLY,O_CREAT,O_APPEND`, `reason: deny_match`), so the older "0.20 allowed
the append" report did not reproduce on this build. The case is kept — a compiled
profile that checks only truncation or `O_WRONLY` would still allow an append —
but it is no longer a differential row: both engines must deny there.

## Case shape

A case's verdict must come from the operation it names, and nothing else. Two
rules follow from the first capture, where both failures actually happened:

- **No `/dev/null` redirect.** With a profile that grants nothing outside the
  scratch root, `2>/dev/null` is itself denied, the shell never runs the command,
  and the case reports `deny` for a reason it is not testing. Engine stderr stays
  in the case log; that is the evidence of why the verdict came out as it did.
- **A deny needs a record on the probed path.** `tools/golden-tsv.sh` reads the
  verdict; the capture step also checks that the engine's own record names the
  path the case probes, and fails a capture where a deny is unaccompanied by one.

`corpus/p/` cases are deliberate widenings and are never compared with rows
here.

## Regenerating a row set

```sh
# capture (plain terminal; needs the engine, refused inside a sandbox)
bash corpus/run.sh --label landstrip-golden \
  --profile-template corpus/profiles/landstrip.json \
  --engine-cmd "$LANDSTRIP run -p \$PROFILE_FILE --"

# record (refuses unclassified cases; note column from corpus/d/*.sh headers)
bash tools/golden-tsv.sh --summary results/landstrip-golden/summary.tsv \
  --engine landstrip --version 0.20.29 > expectations/landstrip.tsv
```

`results/` is gitignored, so a capture that only lives there dies with the
checkout. The durable copy is the TSV plus the evidence directory that
the run was taken from (`docs/evidence/`; the landstrip rows refer to
`docs/evidence/m1-20261125/`, the pinned-engine runner runs to
`docs/evidence/p1-20261125/`).

The whole flow is two tracked make targets; a gitignored spare script is no
longer the only way to reproduce it:

```sh
# 1. capture: run the corpus, then emit a candidate TSV through
#    tools/golden-tsv.sh (refuses unclassified cases and denies without a
#    backing engine record; the candidate lands in gitignored results/):
make capture LABEL=syd-golden PROFILE=corpus/profiles/syd-a.profile \
     ENGINE='$HOME/.local/opt/syd-3.59.0/syd -P \$PROFILE_FILE --' \
     NAME=syd VERSION=3.59.0
# 2. review results/<label>/candidate.tsv, then move the rows you want to
#    keep into expectations/ yourself, and commit the sanitized run under
#    docs/evidence/ (tools/sanitize-evidence.sh).
# 3. gate the commit against the new golden set:
make gate RESULTS=results/<label>/summary.tsv
```

The first landstrip capture (and this file's rows) used the same harness
with `ENGINE='<landstrip binary> -p $PROFILE_FILE --'`, `NAME=landstrip`,
`VERSION=0.20.29`; that capture was produced on the phase-0 machine
before the make target existed and is sanitized under
`docs/evidence/m1-20261125/`.

## The landstrip profile these rows were captured against

`corpus/profiles/landstrip.json` is a corpus-scoped **reduction** of the phase-0
machine artifact, not the artifact itself:

| | |
|---|---|
| artifact | `~/.pi/agent/sandbox.json` (112 lines, host-specific allow-lists) |
| archived as | `docs/evidence/m1-*/sandbox.json`, sanitized |
| reduction | keep the two dimensions the D cases probe: `allowRead`/`allowWrite` of `@ROOT@`, `denyRead`/`denyWrite` of `@ROOT@/secret`; drop network, sockets, and every host path |

Why the reduction and not the artifact: the artifact names `/home/<user>/.nvm`,
the anaconda tree and a host mount, so it would deny the case script its own exec
on any machine that is not this one, and its `allowRead` list would make most D
cases pass for reasons unrelated to the rule they probe. Why not the bare
`denyRead`/`denyWrite` the file used to hold: with no `allowWrite` the engine
resolves `writeRoots=[]`, so D2 and D3 would be denied by a blanket rule rather
than by the deny rule they exist to test.

`landstrip resolve` (not `run`, which the agent sandbox cannot do) shows the
resulting shape: `read=allowRoots` with the built-in root set plus the scratch
root, `writeRoots=[<scratch>]`, both denial lists `[<scratch>/secret]`. `/bin`
appears as a `readSymlink` entry, not a root — that is why exec still works and
must not be "fixed".
