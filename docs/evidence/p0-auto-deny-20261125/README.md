# P0 auto-deny measurement (2026-11-25)

Measured fact: pi-coding-agent 1.6.0 honors the dialog `timeout` option.
An unanswered pi-sydbox deny prompt, issued by the real extension through the
real pi process in RPC mode, auto-resolves agent-side and the session
continues 120 070 ms after the request when the extension sends
`timeout: 120000` (pi's own option name; the extension's `AUTO_DENY_MS`).

This closes P0 item 1: before the fix the extension sent `timeoutMs`, a key
pi ignores, so auto-deny was dead config and a prompt could block forever.

## How it was measured

Headless RPC harness `tools/rpc-dialog-probe/` (committed beside this file):

- real pi 1.6.0 (npm tarball `@earendil-works/pi-coding-agent@1.6.0`,
  `dist/bundle/cli.js`, loaded with `-e` against this repository's
  `src/index.ts`),
- real pi-sydbox pipeline: `tool_call` wraps the bash tool,
  `tool_result` reads the session log, the denial record is the committed
  capture line 1 of `test/fixtures/syd-3.59.0-access-deny.jsonl` appended to
  the session log between the two probe rounds,
- a fake openai-completions server on 127.0.0.1 scripts the model (bash tool
  call, then completion), so the run needs no network LLM,
- a stub engine stands in for the seccomp/Landlock binary: it passes the gate
  self-check and execs nothing. The probe therefore measures the DIALOG layer
  (option key honored, timeout enforced, auto-resolve observed). It is not
  engine-confinement evidence; that lives in the corpus runs. The pi-web
  browser-layer confirmation of the same behavior is roadmap item M3.

Environment: Linux 6.18.35 x86_64 CI-style VM, node 22.20.0,
jiti 2.7.0 (pi's extension loader requires it at runtime). UTC timestamps in
the logs; the run took 2 m 3 s wall.

Reproduce:

```sh
node tools/rpc-dialog-probe/run-probe.mjs \
  --pi <path to pi-coding-agent dist/bundle/cli.js> \
  --ext src/index.ts \
  --repo . \
  --work <scratch dir> \
  --expect-timeout-ms 120000
```

(The harness writes the stub engine and the state tree under `--work`; a
short-constant sanity run is done by first patching `AUTO_DENY_MS` in a
scratch copy of the extension, never in the committed tree.)

## Files

- `summary.json` — the harness summary: phases, the select record's timeout
  field, the auto-deny interval, the pass/fail checks.
- `rpc-records.jsonl` — every RPC record pi emitted, timestamped, including
  the `extension_ui_request` (method `select`) whose title is the extension's
  constant framing line and whose `timeout` field is 120000. The client never
  answered it; the records after it show the session continuing.
- `model-server.jsonl` — the fake model server's request log: the fourth
  request (round B continuation) arrives only after the auto-resolve, which
  is the measured continuation event.
