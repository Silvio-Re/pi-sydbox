# Runbook — return to landstrip

Use when pi-sydbox is unusable and work must continue now.

## Before phase 4b (AppArmor still relaxed)

1. `pi install npm:pi-landstrip@0.20.29`
2. Confirm the triple: `api`, JS package and platform binary all at 0.20.29 in
   `~/.pi/agent/npm/node_modules`.
3. Run `landstrip --version` and `landstrip --debug run -- /bin/sh -c 'echo hi'`
   in a plain terminal.
4. Remove the pi-sydbox entry from settings if it was installed; a stale local
   package entry loads on every start.

## After phase 4b (stock AppArmor, sysctl back to 1)

Order matters: landstrip cannot create its user namespace until the sysctl is 0.

1. `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`
2. Restore the landstrip AppImage patch if an npm install in `~/.pi/agent/npm`
   overwrote it: `~/.pi/agent_dir/landstrip-patch/fix-landstrip-artifact.sh`
3. Flip the extension entry back to `npm:pi-landstrip@0.20.29`.
4. Verify as above.
5. Record the reason in `CHANGELOG.md` and in the migration directory.

## Not a rollback

Swapping the binary alone. landstrip's protocol changed between 0.20.29 and 0.22.0;
a mixed api/binary pair passes simple commands and leaves the approval channel
unvalidated.
