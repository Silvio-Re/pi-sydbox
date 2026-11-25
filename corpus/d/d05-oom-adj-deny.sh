#!/bin/sh
# D5 — writing to /proc/self/oom_score_adj must be denied (engine side).
#
# The design row is "deny + prompt shape": the prompt-shaped half is dialog
# behavior and belongs to the soak (roadmap M5); this corpus case measures
# only the engine's decision on the write. The redirect names the probed
# path itself, so a deny is backed by an engine record naming that path
# (a /dev/null redirect is contractually banned: it is denied for its own
# sake and measures nothing).
# probe: /proc/self/oom_score_adj
if printf 0 > /proc/self/oom_score_adj; then
  echo "verdict=allow"
else
  echo "verdict=deny"
fi
