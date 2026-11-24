# Deliberate policy changes

Cases here differ from the landstrip golden set on purpose. Each needs a one-line
rationale in the header and a "wider by design" marker, so a reviewer can tell a
policy decision from an engine regression.

Candidate (decision pending): make `~/.netrc` readable for the sandboxed git HTTPS
client. Today it is in `denyReadAlways`, so all HTTPS git fails inside the sandbox.
