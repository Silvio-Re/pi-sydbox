# Changelog

## [Unreleased]

- Fixed: sandboxed writes into the shared-folder checkout were denied by
  the engine's filesystem sandbox on sight — syd 3.59.0 has no entry for that
  fstype in its `FS_MAGIC` table, so `statfs` magic `0x786f4256` fell to the default
  deny. `fsAllowFor` (`src/launcher.ts`) now collects the distinct statfs
  magics of the policy's allow targets (climbing to the nearest existing
  ancestor for paths that do not exist yet, dropping ext magics
  `include_profile` already allows) and the compiler receives those
  `allow/fs+0x<magic>` lines through its `extraAllows` slot; deny rules keep
  holding (probe 19: C1 granted, no-cure control C2 denied).
- Probe 19 rewritten to assert the extension's own emission instead of manual
  append-cure profiles (old section 4 retired; facts live in
  `agent_dir/spike/logs/verdict-20261124-221518/`).
- `docs/environment.md`: fs-sandbox item under "Confinement layers" with the
  deny-record evidence and the by-value cure.

## [0.1.0] - 2026-11-23

- Repository skeleton: design doc, invariants, corpus harness contract, ADR 0001
  (namespace policy, proposed), rollback runbook, `syd.lock` placeholder.
- Real code: namespace-invariant check, violation-record schema validator.
- `src/index.ts` is inert on purpose; no tool registration before phase 2.
