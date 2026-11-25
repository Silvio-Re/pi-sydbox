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

Two classes of cases probe outside the scratch grant (d06 netrc, p01 posture):
for them `run.sh` also builds an out-of-grant fixture home and exports:

- `CASE_OUT_HOME` — a private directory under `$HOME` the sandbox policy grants
  nothing of: it holds `.netrc` (d06: a `machine 127.0.0.1` entry) and `plain`
  (p01). Cases must check it is non-empty and print `verdict=error` when it is.
- `CASE_NETRC_PORT` — the port of a loopback HTTPS git server `run.sh` starts
  (python3 + openssl required) that answers `git ls-remote` with 401, so d06's
  credentials can only come from the netrc. Empty string means no server.

Every D case must declare the paths it probes, one `# probe:` line each, after
the header summary line:

- a token without a leading slash is `$CASE_ROOT`-relative (`secret`,
  `ok/d08-link`);
- an absolute token is compared verbatim, and only the literal variables
  `${CASE_ROOT}` and `${CASE_OUT_HOME}` are substituted first
  (`/proc/self/root${CASE_ROOT}/secret`, `${CASE_OUT_HOME}/.netrc`).

`tools/gate.sh` and `tools/golden-tsv.sh` use the declarations to enforce the
capture rule from M1: a deny verdict only counts when the engine's own record
in that case's log names one of the declared paths — the first landstrip
capture measured its own `/dev/null` redirect instead, and since then a
`/dev/null` redirect may not appear in a case at all.

The run directory additionally holds `case-env` (the actual `CASE_ROOT`,
`CASE_OUT_HOME`, `CASE_NETRC_PORT` of that run — the gate re-derives probe
paths from it) and `netrc-server.log` (the loopback server's log, never
credential content).

## Gating a run

`make gate RESULTS=results/<label>/summary.tsv` compares a run against the
committed golden rows (equal-or-stricter, plus the probe-declaration rules);
see `expectations/README.md` for the semantics and `tools/gate.sh` for the
implementation. The gate needs no engine: it works on a run directory someone
already produced. `make capture ...` runs the corpus and emits a candidate
golden TSV from the run; nothing is recorded into `expectations/` automatically.

## Running

On this machine the repo lives on a host shared-folder mount, which does not
store the exec bit; the scripts are recorded as executable in git, so call
them through `bash` here (after a normal clone elsewhere, direct execution
works).

```sh
# variant A (no namespace options), phase 0.5 tentative profile
bash corpus/run.sh --label syd-a --profile-template corpus/profiles/syd-a.profile \
     --engine-cmd "/home/silvio/.local/opt/syd-3.59.0/syd -P \$PROFILE_FILE --"

# or through make
make corpus LABEL=syd-a PROFILE=corpus/profiles/syd-a.profile \
     ENGINE='/home/silvio/.local/opt/syd-3.59.0/syd -P \$PROFILE_FILE --'

# landstrip baseline (legacy policy artifact, not a syd profile)
corpus/run.sh --label landstrip --profile-template corpus/profiles/landstrip.json \
              --engine-cmd "/path/to/landstrip -p \$PROFILE_FILE --"

# a case that fails to produce a verdict is reported as `error`, not as a pass
```
