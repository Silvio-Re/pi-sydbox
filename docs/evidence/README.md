# Committed evidence

`agent_dir/` is gitignored, so nothing in `docs/`, `README.md` or a code comment
may cite it: a citation that a fresh clone cannot open is not evidence. This
directory holds the copies that survive — one subdirectory per work order,
filled when that order ran.

Each subdirectory is a **record**, not a runnable tree: paths inside it are
sanitized placeholders (`@HOME@`, `@SHARE@`, `@SCRATCH@`, `@RUNTIME@`), so a
copied probe script will not execute as-is. The executable working copies stay in
`agent_dir/spike/` (gitignored) or `tools/setup/` (tracked).

## Sanitization rule

Applied by `tools/sanitize-evidence.sh`, which refuses to write a file that still
carries a host path:

| pattern | placeholder |
|---|---|
| `/home/<user>` | `@HOME@` |
| `/media/<share>` | `@SHARE@` |
| `/tmp/pi-sydbox-<suffix>` | `@SCRATCH@` |
| `/tmp/sydbox<suffix>` | `@SCRATCH@` |
| `/run/user/<uid>` | `@RUNTIME@` |

Dates, engine versions, case names and verdicts are kept verbatim — they are what
the evidence is about. Do not extend the rule to hide an inconvenient line;
extend it only for a path shape, and record the new shape here.

Log files are tracked here and nowhere else: `.gitignore` excludes `*.log`
globally and re-includes `docs/evidence/**/*.log`. Without a committed log an
evidence directory would hold a README describing runs no one can open — the
first draft of `m1-20261125/` would have committed 11 files and left all 22 logs
behind.

## Index

| directory | order | holds |
|---|---|---|
| `m1-20261125/` | M1 golden capture + evidence handover | landstrip profile and its resolved shape, engine pin, the phase-0 machine artifact, the two cited verdict runs, the probe scripts the code comments cite, the capture itself |

The `docs/evidence/` copy is the durable one. If a log is cited from a comment,
the citation points here and this table says what it proves.
