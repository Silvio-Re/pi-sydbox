# ADR 0001 — namespace policy for the compiled profile

Status: **proposed** (blocked on phase 0.5)
Date: 2026-11-23

## Context

syd's shipped profiles use `unshare/mount,uts,pid,ipc,cgroup:1` and `bind+…` rules.
Bind-mount-based read-only enforcement requires a mount namespace. The plan's
original invariant forbade every namespace option, which would also forbid `bind`
rules and leave Landlock plus seccomp-notify alone.

User namespaces are the part that must stay off: they are what the landstrip
AppArmor workaround relaxes, and what the migration exists to remove.

## Options

- **A — no namespace option at all.** Compiled profile contains no `unshare` and no
  `bind` rule. Self-test rejects both. Smallest TCB, no mount topology changes.
- **B — mount namespace permitted, user namespace forbidden.** `unshare/mount:1` and
  `bind` rules allowed when they implement policy; `unshare/user` and `user` in any
  `unshare` list rejected. Self-test enforces only the user-namespace prohibition.

## Decision procedure (phase 0.5)

1. `syd -m 'unshare/mount,user,pid,uts,ipc,cgroup:0 <deny rule>' -- cat <secret>`
   must deny. If it does not, A is unavailable.
2. Repeat with `bind+/tmp:ro` plus the deny rule to see whether B buys anything A
   cannot express.
3. Run D7, D8, D9 under the candidate configuration.

## Consequences to record

Variant chosen, the exact command line and its output, the record sample, and
whether `ptrace` had to be enabled. Until this ADR is accepted, no module in
`src/` may assume either variant.
