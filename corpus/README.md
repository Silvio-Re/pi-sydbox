# Probe corpus

Two sets, never mixed:

- `d/` differential: the *same* policy is given to both engines and the decision is
  compared with the landstrip golden decision. Rule: equal or strictly stricter.
- `p/` deliberate policy changes: each case documents why the decision is meant to
  differ. Never compared with the golden set.

## Case contract

A case is an executable `sh` script, run *inside* the sandbox, with `CASE_ROOT`
pointing at a shared scratch directory. Fixtures (`$CASE_ROOT/secret`, `$CASE_ROOT/ok`)
are created by `run.sh` before the engine starts, so a write probe really tests a write.

A case prints exactly one `verdict=<allow|deny|error|prompt>` and exits 0. `run.sh`
collects the verdicts into `results/<label>/summary.tsv` and keeps full per-case logs.

## Running

On this machine the repo lives on a host shared-folder mount, which does not
store the exec bit; the scripts are recorded as executable in git, so call
them through `bash` here (after a normal clone elsewhere, direct execution
works).

```sh
# variant A (no namespace options), phase 0.5 tentative profile
bash corpus/run.sh --label syd-a --profile-template corpus/profiles/syd-a.profile \
     --engine-cmd "/home/silvio/.local/opt/syd-3.60.0/syd -m \$PROFILE_FILE --"

# or through make
make corpus LABEL=syd-a PROFILE=corpus/profiles/syd-a.profile \
     ENGINE='/home/silvio/.local/opt/syd-3.60.0/syd -m $PROFILE_FILE --'

# landstrip baseline (legacy policy artifact, not a syd profile)
corpus/run.sh --label landstrip --profile-template corpus/profiles/landstrip.json \
              --engine-cmd "/path/to/landstrip -p \$PROFILE_FILE --"

# a case that fails to produce a verdict is reported as `error`, not as a pass
```
