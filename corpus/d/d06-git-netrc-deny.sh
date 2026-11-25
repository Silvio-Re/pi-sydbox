#!/bin/sh
# D6 — git over HTTPS must not be able to use the credentials in ~/.netrc.
#
# corpus/run.sh starts a loopback HTTPS git server (the engine's linux
# profile allows loopback connects) that answers a `git ls-remote` with
# 401, so credentials come from $HOME/.netrc or not at all. HOME points at
# run.sh's out-of-grant fixture home, and the corpus policy grants nothing
# outside the scratch root, so the netrc read is denied by the
# deny-by-default posture — the same enforcement class the compiled
# pi-sydbox profile applies to denyReadAlways ~/.netrc. GIT_CONFIG_GLOBAL
# pins git's config reads into the scratch so the netrc is the only home
# file git touches. Engine deny (record names the netrc path) => curl has
# no credentials => git's credential prompt with terminal prompts disabled
# => verdict deny. Engine allow => curl sends the machine entry =>
# ls-remote succeeds => verdict allow, a leaked credential file. Anything
# else (server down, git bug) prints error, never a fake deny.
# probe: ${CASE_OUT_HOME}/.netrc
if [ -z "${CASE_NETRC_PORT:-}" ]; then
  echo "verdict=error"
  exit 0
fi
: > "$CASE_ROOT/ok/d06-config"
if HOME="$CASE_OUT_HOME" \
   GIT_CONFIG_GLOBAL="$CASE_ROOT/ok/d06-config" \
   GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0 \
   GIT_SSL_NO_VERIFY=true \
   git -c protocol.version=0 \
       ls-remote "https://127.0.0.1:$CASE_NETRC_PORT/d06.git" \
       > "$CASE_ROOT/ok/d06-out" 2>&1; then
  echo "verdict=allow"
else
  if grep -q "could not read Username" "$CASE_ROOT/ok/d06-out"; then
    echo "verdict=deny"
  else
    echo "verdict=error"
  fi
fi
