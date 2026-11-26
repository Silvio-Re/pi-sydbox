# Deliberate policy changes

Cases here differ from the landstrip golden set on purpose. Each needs a one-line
rationale in the header and a "wider by design" marker, so a reviewer can tell a
policy decision from an engine regression.

- `p01-read-posture`: not a widening at all — the expected verdict is deny.
  It exists because a posture claim (deny by default outside the granted
  scratch root) is an enforcement claim like any other, so it is pinned to a
  measured verdict at the P3 gate machine (roadmap P1.5) rather
  than asserted. Never compared against the golden set.

Candidate (decision pending): make `~/.netrc` readable for the sandboxed git HTTPS
client. Today it is in `denyReadAlways`, so all HTTPS git fails inside the sandbox.
