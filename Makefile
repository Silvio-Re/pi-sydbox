.RECIPEPREFIX = >
ENGINE ?=
LABEL ?= eng
PROFILE ?=
.PHONY: test check corpus verify gate

test:
> node --experimental-strip-types --test test/*.test.ts

check: test

corpus:
> @test -n "$(ENGINE)" || { echo "usage: make corpus ENGINE='<command prefix>'"; exit 2; }
> bash corpus/run.sh --label "$(LABEL)" --engine-cmd "$(ENGINE)" $(if $(PROFILE),--profile-template $(PROFILE),)

verify:
> bash tools/verify-artifact.sh

gate: test
> @echo "gate: corpus differential vs expectations/ is phase 1+; nothing enforced yet"
