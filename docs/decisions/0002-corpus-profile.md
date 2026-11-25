# ADR 0002 — corpus profile for the landstrip golden set

Status: **accepted**
Date: 2026-11-25

## Context

The golden rows (order M1) have to be reproducible on any checkout, and they
have to measure the rule each D case probes. The phase-0 artifact
(`~/.pi/agent/sandbox.json`, archived sanitized under `docs/evidence/`) is
neither: it names this machine's node, anaconda and mount paths, so on another
machine the case script loses its own exec, and its `allowRead` list overlaps
most of the paths the deny cases touch.

Three candidate shapes were considered:

- **A — the phase-0 artifact verbatim.** Faithful to the machine, useless as a
  baseline: not portable, and its grants mask the deny rule.
- **B — `denyRead`/`denyWrite` only.** Small enough to be portable, but with no
  `allowWrite` the engine resolves `writeRoots=[]`, and D2/D3 are then denied
  because nothing is writable at all rather than because `/secret` is denied.
  A golden row from that shape says nothing about the deny rule.
- **C — the two dimensions the D corpus probes.** `allowRead`/`allowWrite` of
  `@ROOT@`, `denyRead`/`denyWrite` of `@ROOT@/secret`, nothing else.

## Decision

C, committed as `corpus/profiles/landstrip.json`:

```json
{"filesystem": {"allowRead": ["@ROOT@"], "allowWrite": ["@ROOT@"],
                "denyRead": ["@ROOT@/secret"], "denyWrite": ["@ROOT@/secret"]}}
```

`read=allowRoots` with built-in system roots, `writeRoots=[@ROOT@]`, both denial
lists `[@ROOT@/secret]`. Exec still works because the built-in root set covers
`/bin`, `/usr` and `/lib`; the `readSymlink` entries in `landstrip resolve` are
the engine's own, not a grant this profile adds.

Network, sockets, `/proc` and every host path are out of scope: no D case probes
them, and leaving them out is what makes the capture portable.

## Consequences

- The rows record the deny rule's effect inside a writable root, which is the
  shape the compiled syd profile has to reproduce.
- Nothing outside `@ROOT@` is granted, `/dev/null` included. That is what makes
  the first capture's failure visible: a case that redirects to `/dev/null` is
  denied the redirect and never runs its command, so the case scripts carry no
  `/dev/null` redirect and the deny record must name the path they probe (rule
  in `expectations/README.md`, "Case shape"). Granting `/dev/null` here would
  have hidden the same defect, not fixed it.
- The profile is not the production policy, and the golden set does not claim to
  measure one. `docs/evidence/m1-*/policy/` keeps the production artifact for
  audit; `expectations/README.md` states the reduction and its reason.
- Denial paths depend on the mount underneath: `EACCES` on vboxsf, `EPERM` on
  ext4, both counted as `deny` by `corpus/d/01-read-deny.sh`. A capture taken on
  a different filesystem therefore stays comparable at the verdict level only —
  which is the level the comparison rule in `expectations/README.md` uses.
