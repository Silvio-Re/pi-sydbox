# Support matrix

What this repository claims to support, and the committed evidence behind each
row. Claims are limited to what is tested or recorded in the repository: a row
without evidence here is a bug, not an aspiration. Pending rows are marked and
name the roadmap item that fills them.

| Host | Component | Claimed version / path | Status | Evidence |
| --- | --- | --- | --- | --- |
| Linux < 7.2 | syd engine | 3.59.0 built from the `v3.59.0` tag | tested | [docs/environment.md](environment.md) (engine, two paths: 3.60.0 needs landlock ABI 10, Linux 7.2), [syd.lock](../syd.lock) (`sourceBuild`: tag, commit `7e602aa`, toolchain, sha256), build script `tools/setup/build-engine.sh` |
| Linux >= 7.2 | syd engine | 3.60.0 signed release tarball | artifact verified, band pending | [docs/environment.md](environment.md) (release path), [syd.lock](../syd.lock) (`url`, `sha512`, minisign `signingKey`), verification chain `tools/verify-artifact.sh` + `tools/syd-release.pub`. No machine in the >= 7.2 band has run the corpus yet; that evidence lands at Gate P3 ([docs/ROADMAP.md](ROADMAP.md), order P3) |
| any host | pi (`@earendil-works/pi-coding-agent`) | 1.6.0 (exact devDependency pin) | tested | [package.json](../package.json) (devDependencies), API surface asserted by `test/pi-contract.test.ts` (exported `createLocalBashOperations`, dialog `timeout` option, `tool_call`/`tool_result`/`user_bash` events), dialog behavior measured headless in [docs/evidence/p0-auto-deny-20261125/](evidence/p0-auto-deny-20261125/) |
| any host | pi-web (`@agegr/pi-web`) | 0.18.0 | install recorded, browser layer pending | [syd.lock](../syd.lock) (`hosts.piWeb`: the maintainer's daily-driver install is 0.18.0), resolved by `tools/weekly-check.sh`. The browser-layer auto-deny confirmation rides the M5 soak (roadmap M3, folded) |
| Ubuntu-class guest, kernel 6.8 | operating system | the author's machine only | tested | [docs/environment.md](environment.md) (prerequisites, measured 6.8 guest with landlock ABI 4, per [syd.lock](../syd.lock) notes). Nothing broader is claimed: no other distribution, kernel or machine has been tested. The second kernel band (>= 7.2) is pending, it lands at Gate P3 |

Maintenance: dependency drift (syd on crates.io / GitLab tags / distfiles, both
npm packages, and the repo devDependencies) is reported by
`tools/weekly-check.sh`; the comparison baselines are [syd.lock](../syd.lock)
and [package.json](../package.json). The engine-per-kernel-band policy is
[docs/environment.md](environment.md), "Engine, two paths".
