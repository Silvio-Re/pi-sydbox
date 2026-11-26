#!/usr/bin/env python3
"""Network drift report (roadmap P2), called by tools/weekly-check.sh.

Read-only: prints one "OK|WARN <available vs pinned>" line per source and
stops. It opens no issues and triggers nothing. The comparison baselines come
from syd.lock and package.json only. A network failure prints a single WARN
line and ends the report.
"""

import json
import socket
import sys
import urllib.error
import urllib.request

TIMEOUT = 20


def fetch_json(url: str) -> object:
    req = urllib.request.Request(url, headers={"User-Agent": "pi-sydbox-drift-check"})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as res:
        return json.load(res)


def reachable(url: str) -> bool:
    try:
        req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": "pi-sydbox-drift-check"})
        urllib.request.urlopen(req, timeout=TIMEOUT)
        return True
    except urllib.error.HTTPError:
        return True  # the server answered; the artifact check reports the code
    except (urllib.error.URLError, socket.timeout, OSError):
        return False


def version_key(text: str) -> tuple:
    parts = text.lstrip("v").split(".")
    out: list = []
    for part in parts:
        digits = ""
        for ch in part:
            if ch.isdigit():
                digits += ch
            else:
                break
        out.append(int(digits) if digits else 0)
    while len(out) < 3:
        out.append(0)
    return tuple(out)


def satisfies(version: str, spec: str) -> bool:
    """Minimal semver check for the exact and ^/~ specs this repo pins with."""
    spec = spec.strip()
    if spec.startswith("^"):
        floor = version_key(spec[1:])
        have = version_key(version)
        if floor[0] > 0:
            return floor[0] == have[0] and have >= floor
        if floor[1] > 0:
            return floor[:2] == have[:2] and have >= floor
        return have == floor
    if spec.startswith("~"):
        floor = version_key(spec[1:])
        have = version_key(version)
        return floor[:2] == have[:2] and have >= floor
    return version_key(version) == version_key(spec)


def npm_latest(package: str) -> str:
    name = package.replace("/", "%2f") if package.startswith("@") else package
    doc = fetch_json(f"https://registry.npmjs.org/{name}")
    return str(doc["dist-tags"]["latest"])


def main() -> int:
    repo = sys.argv[1] if len(sys.argv) > 1 else "."
    try:
        with open(f"{repo}/syd.lock") as fh:
            lock = json.load(fh)
        with open(f"{repo}/package.json") as fh:
            pkg = json.load(fh)
    except (OSError, json.JSONDecodeError) as err:
        print(f"WARN cannot read the drift baselines: {err}")
        return 0

    pinned_source = str(lock["sourceBuild"]["version"])
    pinned_release = str(lock["version"])
    pinned_pi_web = str(lock["hosts"]["piWeb"]["pinned"])

    try:
        crates = fetch_json("https://crates.io/api/v1/crates/syd")["crate"]  # type: ignore[index]
        latest_crate = str(crates.get("max_stable_version") or crates.get("max_version"))
    except (urllib.error.URLError, socket.timeout, OSError, KeyError, json.JSONDecodeError):
        print("WARN network unreachable, drift check skipped")
        return 0

    if latest_crate == pinned_source:
        print(f"OK syd crates.io {latest_crate} matches the pinned source build {pinned_source} (syd.lock)")
    else:
        print(f"WARN syd crates.io has {latest_crate}, pinned source build is {pinned_source} (syd.lock)")

    newest_tag = ""
    try:
        tags = [str(t["name"]) for t in fetch_json(
            "https://gitlab.exherbo.org/api/v4/projects/sydbox%2Fsydbox/repository/tags?per_page=100")]
        newest_tag = max(tags, key=version_key)
        if newest_tag.lstrip("v") == pinned_release:
            print(f"OK syd GitLab newest tag {newest_tag} matches the pinned release {pinned_release} (syd.lock)")
        else:
            print(f"WARN syd GitLab newest tag is {newest_tag}, pinned release is {pinned_release} (syd.lock)")
    except (urllib.error.URLError, socket.timeout, OSError, KeyError, json.JSONDecodeError):
        print("WARN syd GitLab tags unreachable")
    except ValueError:
        print("WARN syd GitLab tags unreadable (no tags in the first page)")

    try:
        probe = newest_tag.lstrip("v") or pinned_release
        tarball = f"https://distfiles.exherbo.org/sydbox/syd-{probe}-x86_64-pc-linux-gnu.tar.xz"
        if reachable(tarball):
            if probe == pinned_release:
                print(f"OK syd distfiles newest tarball syd-{probe} matches the pinned release {pinned_release} (syd.lock)")
            else:
                print(f"WARN syd distfiles serves a newer tarball syd-{probe}, pinned release is {pinned_release} (syd.lock)")
        else:
            print(f"OK syd distfiles has no syd-{probe} tarball yet; pinned release stays {pinned_release} (syd.lock)")
    except OSError:
        print("WARN syd distfiles unreachable")

    try:
        latest_pi_web = npm_latest(str(lock["hosts"]["piWeb"]["package"]))
        if latest_pi_web == pinned_pi_web:
            print(f"OK {lock['hosts']['piWeb']['package']} {latest_pi_web} matches the pinned {pinned_pi_web} (syd.lock)")
        else:
            print(f"WARN {lock['hosts']['piWeb']['package']} has {latest_pi_web}, pinned is {pinned_pi_web} (syd.lock)")
    except (urllib.error.URLError, socket.timeout, OSError, KeyError, json.JSONDecodeError):
        print(f"WARN {lock['hosts']['piWeb']['package']} on npm unreachable")

    for name, spec in sorted(pkg.get("devDependencies", {}).items()):
        try:
            latest = npm_latest(name)
        except (urllib.error.URLError, socket.timeout, OSError, KeyError, json.JSONDecodeError):
            print(f"WARN {name} on npm unreachable")
            continue
        if satisfies(latest, str(spec)):
            print(f"OK {name} {latest} satisfies the pinned spec {spec} (package.json)")
        else:
            print(f"WARN {name} has {latest}, the pinned spec {spec} does not cover it (package.json)")

    return 0


if __name__ == "__main__":
    sys.exit(main())
