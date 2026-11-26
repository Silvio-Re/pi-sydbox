.RECIPEPREFIX = >
ENGINE ?=
LABEL ?= eng
PROFILE ?=
NAME ?=
VERSION ?=
RESULTS ?=
.PHONY: test check corpus verify gate capture setup

test:
> node --experimental-strip-types --test test/*.test.ts

check: test

corpus:
> @test -n "$(ENGINE)" || { echo "usage: make corpus ENGINE='<command prefix>' [LABEL=] [PROFILE=]"; exit 2; }
> bash corpus/run.sh --label "$(LABEL)" --engine-cmd "$(ENGINE)" $(if $(PROFILE),--profile-template $(PROFILE),)

verify:
> bash tools/verify-artifact.sh

# setup: the one-command machine setup (P3/P6). Detects the kernel band, runs
# the release path (>= 7.2: verify + install), the distro path (6.x x86_64
# default: libseccomp + pinned third-party binary) or the source fallback
# (--build-from-source / non-x86_64: libseccomp + engine build), provisions
# the machine lock (~/.local/opt/syd.lock), runs the smoke and prints the pi
# install next steps. Human-run, plain terminal, no sandbox.
#
#   make setup
#   make setup SETUP_ARGS=--build-from-source
setup:
> bash tools/setup/setup.sh $(SETUP_ARGS)

# gate: compare an already-produced run summary against expectations/*.tsv.
# No engine is started; semantics in tools/gate.sh and expectations/README.md.
#   make gate RESULTS=results/<label>/summary.tsv
gate:
> @test -n "$(RESULTS)" || { echo "usage: make gate RESULTS=results/<label>/summary.tsv"; exit 2; }
> @bash tools/gate.sh --summary "$(RESULTS)"

# capture: run the corpus, then emit a candidate golden TSV from that run
# (tools/golden-tsv.sh refuses unclassified cases and denies without a
# backing engine record). Candidates land in results/ (gitignored) on
# purpose: review, then move the rows you want into expectations/ yourself.
#   make capture LABEL=syd-golden PROFILE=corpus/profiles/syd-a.profile \
#        ENGINE='$HOME/.local/opt/syd-3.59.0/syd -P \$PROFILE_FILE --' \
#        NAME=syd VERSION=3.59.0
capture: corpus
> @test -n "$(NAME)" && test -n "$(VERSION)" || { echo "usage: make capture ENGINE='...' NAME=<engine> VERSION=<version> [LABEL=] [PROFILE=]"; exit 2; }
> @bash tools/golden-tsv.sh --summary results/$(LABEL)/summary.tsv --engine $(NAME) --version $(VERSION) --run results/$(LABEL) > results/$(LABEL)/candidate.tsv
> @echo "candidate rows: results/$(LABEL)/candidate.tsv (review, then move rows into expectations/ yourself)"
