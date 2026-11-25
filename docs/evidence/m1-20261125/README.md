# M1 — landstrip golden capture and evidence handover

Order: `docs/ROADMAP.md:195-219`. Captured 2026-11-25 on the end-usage machine
(Ubuntu 24.04.5, kernel 6.8.0-151-generic), engine `landstrip 0.20.29`, before
the engine is decommissioned by M7. Nothing here can be recreated once it is
gone, which is why the copies live in the repository and not in `agent_dir/`.

## What this directory proves

| claim | file |
|---|---|
| the corpus profile resolves to the shape the D cases need | `policy/landstrip.json`, `policy/resolved-projection.json` |
| which machine profile that profile is a reduction of | `policy/sandbox.json` (phase-0 artifact, sanitized) |
| which engine binary produced the golden rows | `engine.txt` (version + sha256) |
| the verification chain at the time of the capture | `verdict-20261124-221518/`, `verdict-20261125-105950/` |
| the probes the code comments cite | `scripts/` |
| the golden capture itself | `capture/` — filled by the handover run, see below |

`policy/sandbox.json` is the phase-0 machine artifact (`~/.pi/agent/sandbox.json`,
112 lines). It is *not* the corpus profile: it names this machine's node, anaconda
and shared-folder paths, so on any other machine it would deny a case script its
own exec. The corpus profile is the reduction described in
`expectations/README.md` ("The landstrip profile these rows were captured
against"), and this copy is kept so the reduction can be audited rather than
trusted.

`policy/resolved-projection.json` is a projection of `landstrip resolve`, not the
full dump: the dump lists 1555 read roots (the built-in system set plus this
machine's `/tmp`), which is noise in a record. The projection keeps the read
mode, the scratch entries, the symlink entries that make exec work, and both
denial lists.

`verdict-20261124-221518/` and `verdict-20261125-105950/` are whole
`agent_dir/spike/logs/verdict-*/` runs as `agent_dir/spike/verdict.sh` wrote them.
The first carries six steps (unit, artifact, corpus, compiled, relocated, matrix)
and is the run behind the probe-19 verdict; the second carries all eleven steps the
driver had at the time (adds typecheck, logcapture, fdappend, fdforge, netdefault)
and is the run the roadmap names for the fd-forge verdict.

`scripts/` holds sanitized copies of the probes the tracked files cite:

| copy | cited by |
|---|---|
| `02-verify.sh` | `docs/environment.md:57`, `docs/environment.md:64` |
| `09-perm-order.sh` | `corpus/run.sh:187`, `docs/environment.md:133`, `tools/setup/03-smoke.sh:51` |
| `19-relocated-profile.sh` | `AGENTS.md:28` |
| `24-fd-forge.sh` | the fd-forge verdict cited at `src/index.ts:156`, `test/index.test.ts:37`, `CHANGELOG.md:93` |

The `<SYD-BUILD>` record the roadmap asks for is already tracked in its final
location (`tools/setup/build-engine.sh:126-145`, the heredoc that emits it), so it
is referenced here rather than copied.

## The capture

```
capture/summary.tsv     corpus/run.sh output for corpus/d against landstrip
capture/<case>.log      one log per case, as run.sh wrote it
```

Produced by the handover step in `agent_dir/spike/verdict.sh`
(`step_landstrip_golden`, probe `25-landstrip-golden.sh`), which also writes
`expectations/landstrip.tsv` through `tools/golden-tsv.sh`.

### First run, 2026-11-25 14:30 — no rows committed

The step passed its own assertions (`allow=0 deny=3`, no unclassified case) and
its capture was withdrawn after reading the logs:

- **D1 and D3 were confounded.** Their verdict was `deny`, but the engine's only
  record named `/dev/null`: the case's own `>/dev/null`/`2>/dev/null` redirect was
  denied by a profile that grants nothing outside the scratch root, so the shell
  never ran `cat`, `mv` or `rm`. The verdict measured the redirect, not the rule.
  Fixed in the case scripts (no `/dev/null` redirect; the reason is in each
  header), and the capture step now fails a deny whose record does not name the
  probed path.
- **D2 did not reproduce the reported 0.20 bug.** The append was denied
  (`openat`, `O_WRONLY,O_CREAT,O_APPEND`, `reason: deny_match`), so the row is
  `deny`, not the predicted `allow`. `docs/design.md:95` and
  `expectations/README.md` now say so; the case stays, because a compiled profile
  that checks only truncation would still allow an append.

Nothing from that run is committed: a golden row has to be a measurement of the
rule it names, and two of the three were not.

### Second run, 2026-11-25 14:34 — the captured set

Same profile, same engine, cases corrected:

| case | verdict | the record that carries it |
|---|---|---|
| `d01-read-deny` | deny | `openat`, `O_RDONLY`, `operation: read`, `deny_match`, `EACCES` on `<scratch>/secret` |
| `d02-append-deny` | deny | `openat`, `O_WRONLY,O_CREAT,O_APPEND`, `operation: write`, `deny_match`, `EACCES` |
| `d03-unlink-mv-deny` | deny | `renameat2` and then `unlinkat`, `operation: write`, `deny_match`, `EACCES` |

All three now carry a denial record on the path the case names, which is what the
first run could not show. `expectations/landstrip.tsv` holds these rows;
`capture/` holds the logs they were read from.

D2 remains the finding to remember: landstrip did deny the append, so the
comparison for D2 is `deny` against `deny` — strict enough, but it cannot detect a
compiled profile that only guards truncation. `docs/design.md:95` and
`expectations/README.md` say so next to the row.
