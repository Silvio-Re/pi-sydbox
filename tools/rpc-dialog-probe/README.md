# RPC dialog probe

Headless measurement harness for the pi-sydbox approval dialog over pi's RPC
mode. It exists to make the dialog layer's behavior a repeatable, recorded
fact (option key honored, timeout enforced, auto-resolve observed) instead of
a claim about UI code nobody drove.

What it measures: the real pi binary runs in RPC mode with the real extension
loaded, its bash tool is driven twice by a scripted local model, and the
committed capture line `test/fixtures/syd-3.59.0-access-deny.jsonl` (line 1)
is appended to the extension's session log between the two rounds. The second
round's `tool_result` therefore offers a real deny prompt; the harness answers
nothing and measures the agent-side auto-resolve.

What it does NOT measure: engine confinement. The engine is a stub that passes
the gate self-check and execs nothing. Engine behavior is the corpus's and the
end machine's evidence, not this probe's. The pi-web browser-layer
confirmation of the same dialog behavior is roadmap item M3.

```sh
# --pi, --ext and --repo must be ABSOLUTE paths: the harness runs pi with
# its cwd inside --work, so relative paths resolve against the scratch
# project dir and fail (verified 2026-11-26).
node tools/rpc-dialog-probe/run-probe.mjs \
  --pi "$PWD/node_modules/@earendil-works/pi-coding-agent/dist/cli.js" \
  --ext "$PWD/src/index.ts" \
  --repo "$PWD" \
  --work <scratch dir, created> \
  --expect-timeout-ms $(grep -oP 'AUTO_DENY_MS = \K[0-9_]+' src/dialog.ts | tr -d '_')
```

Requirements: node >= 22, a fetched or installed
`@earendil-works/pi-coding-agent` (pinned version; the `--pi` flag points at
its `dist/bundle/cli.js`), and `jiti` resolvable from that package (pi's
extension loader requires it at runtime; it is a package dependency, so an
ordinary install provides it). Nothing else; the fake model server listens on
127.0.0.1 and is part of the harness.

Outputs under `--work`: `rpc-records.jsonl` (every RPC record, timestamped),
`model-server.jsonl` (the scripted model's request log), and a JSON summary on
stdout (phases, the select's timeout field, the measured auto-deny interval,
checks). A committed example run with all checks green:
`docs/evidence/p0-auto-deny-20261125/`.

The fake provider is registered by `fake-provider.ts`, and the harness passes
both files to pi with `-e`; nothing is installed into `~/.pi` and no session is
saved (`--no-session`). The harness creates the stub engine and the extension
state tree under `--work`; point `PI_SYDBOX_DIR`-independent state away from
any real machine state by keeping `--work` a throwaway directory.
