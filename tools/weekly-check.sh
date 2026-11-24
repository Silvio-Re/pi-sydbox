#!/usr/bin/env bash
# Weekly drift check. Read-only; prints WARN/OK lines and exits non-zero on WARN.
set -uo pipefail
warn=0
say() { printf '%-5s %s\n' "$1" "$2"; [ "$1" = WARN ] && warn=1; }

settings="$HOME/.pi/agent/settings.json"
if [ -f "$settings" ] && grep -q 'pi-landstrip@0.20.29' "$settings"; then
  say OK "landstrip fallback pin present"
else
  say WARN "landstrip pin absent from $settings (expected until phase 5)"
fi

if [ -f "$HOME/.pi/agent_dir/landstrip-patch/fix-landstrip-artifact.sh" ]; then
  say OK "appimage patch script present"
else
  say WARN "appimage patch script missing (an npm install may have wiped it)"
fi

npm_root="$HOME/.pi/agent/npm/node_modules"
for p in pi-landstrip @landstrip/landstrip-api @landstrip/landstrip-linux-x64; do
  path="$npm_root/$p/package.json"
  if [ -f "$path" ]; then
    v="$(python3 -c "import json;print(json.load(open('$path'))['version'])")"
    say OK "$p $v"
  else
    say WARN "$p not found under $npm_root"
  fi
done

pi_pkg="$HOME/.nvm/versions/node/v22.22.2/lib/node_modules/@agegr/pi-web/node_modules/@earendil-works/pi-coding-agent/package.json"
if [ -f "$pi_pkg" ]; then
  say OK "bundled pi $(python3 -c "import json;print(json.load(open('$pi_pkg'))['version'])")"
else
  say WARN "bundled pi package not found at the recorded path"
fi

if grep -rq 'SchemaDriftError' results 2>/dev/null; then
  say WARN "record schema drift appears in results/ (inspect before upgrading syd)"
else
  say OK "no recorded schema drift"
fi

exit "$warn"
