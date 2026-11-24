# PROVISIONAL — variant A: no unshare rules, no bind rules. Landlock + seccomp.
#
# Shape: inherit the engine's own allowlist, then deny the listed paths, because
# syd is deny-by-default and a later rule overrides an earlier one — PROFILE_LINUX
# in src/config.rs of syd 3.59.0 relies on exactly that (it denies
# /lib*/modules/*** right after allowing /lib*/***).
#
# Categories are the engine's vocabulary, not glibc's: lpath = traverse,
# npath = name lookup, rpath = read, wpath = write, cpath = create,
# tpath = truncate. There is no read/stat/write/all spelling in 3.59.0; a profile
# using one is refused at load time (rc=22 EINVAL) or over-restricts silently.
# `include_profile linux` supplies the seccomp allowlist (/usr, /bin, /lib*,
# /opt, /tmp/**, /dev).
#
# `sandbox/lock:off` is required and is not an optimisation: Landlock is on by
# default (src/config.rs:1969, "default unless feature(trusted)"), PROFILE_LINUX
# ships no `lock/` rules, so its Landlock layer is an empty allowlist that denies
# every path — including exec, which surfaces as "syd: exec error: Permission
# denied", rc=13 and an empty log (Landlock denials are not logged; seccomp ones
# are). Landlock cannot express "deny this one path" either, so a blacklist is
# seccomp-only by construction. The directive must follow the include, because a
# later directive wins.
include_profile linux
sandbox/lock:off
# The case scripts are exec'd from the scratch root, and PROFILE_LINUX allows
# /tmp/** for read/write/create/truncate but not for exec. Without this line every
# case dies as "syd: exec error: Permission denied", logged with cap=exec,
# sys=execve and the tip "configure allow/exec+<script>".
allow/lpath,npath,rpath,wpath,cpath,tpath,exec,readdir+@ROOT@/***
deny/lpath,npath,rpath,wpath,cpath,tpath+@ROOT@/secret
