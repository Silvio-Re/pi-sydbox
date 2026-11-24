# Recorded decisions

Golden set captured under landstrip 0.20.29 (phase 0), and the syd results from
phase 1 beside it.

Format, one row per probe: `engine<TAB>case<TAB>verdict<TAB>date<TAB>note`.

Rules:
- D cases: syd must be equal or strictly stricter than the landstrip verdict.
- Any *wider* syd verdict is a failure, not a tuning opportunity.
- "stricter" is recorded with a note naming the probe and why (e.g. D2 append bug).
- P cases never appear here as a comparison; they carry their own rationale.

These files are the oracle for `make gate`. Paths inside are sanitized to
`$SANDBOX_TEST_ROOT`; host-specific captures stay in the migration directory.
