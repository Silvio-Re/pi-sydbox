# Gate P2 drill — contract-point breaks fail the local check (2026-11-26)

Gate P2 reads: *a drill on a branch that breaks one contract point fails the
local contract check before merge.* Each contract point of order P2.1 was
broken one at a time against the installed, exactly-pinned
`@earendil-works/pi-coding-agent@1.6.0` (package.json devDependency; the
breaks were applied to the `node_modules` copy of that tarball, never to a
committed file), and after each break the local check `npm run ci`
(typecheck + node --test, per `.github/workflows/ci.yml`) was run and its
output captured. After each capture the pristine package was restored and
the check run green again before the next break.

| break | contract point | transcript | result |
| --- | --- | --- | --- |
| 1 | the export is renamed (`createLocalBashOperations` -> `createLocalBashOps`) | `break1-renamed-export.txt` | tsc fails (TS2724, no such export); the runtime path fails too (module import error: the export is gone) |
| 2 | the dialog option flips back to `timeoutMs` (the historical P0 break) | `break2-dialog-timeoutms.txt` | tsc fails twice: the `timeout`-accepted assertion and the `timeoutMs`-rejected assertion both land on `never` |
| 3 | the `tool_call` event is removed from the API surface | `break3-removed-tool-call-event.txt` | tsc fails: the event-type discriminator assertion and the `on("tool_call", ...)` registration both stop compiling |
| — | none (pristine branch state) | `green-run.txt` | 122 tests / 0 fail, typecheck clean, exit 0 |

The type-level breaks (2, 3) fail inside `npm run typecheck`, which is the
first half of `npm run ci`, so the gate is closed before the runtime suite
even starts — exactly the point of type-level assertions for a type-level
surface. The runtime surface (1) additionally fails at run time when the
suite is invoked directly.

A real run of the extended drift check (`tools/weekly-check.sh`, order P2.3)
of the same date is committed as
[../p2-drift-report-20261126.txt](../p2-drift-report-20261126.txt).
