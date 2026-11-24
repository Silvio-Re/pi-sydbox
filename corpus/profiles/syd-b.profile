# PROVISIONAL — variant B: mount namespace allowed, user namespace forbidden.
#
# Body is variant A's plus the mount-namespace allowance. The directive stays
# commented until its spelling is verified: one bad directive makes syd refuse the
# whole profile, which would turn every case into a load error and hide the
# differential the corpus exists to produce.
# unshare/mount:1
include_profile linux
sandbox/lock:off
allow/lpath,npath,rpath,wpath,cpath,tpath,exec,readdir+@ROOT@/***
deny/lpath,npath,rpath,wpath,cpath,tpath+@ROOT@/secret
