# Packaging

What is here, what is missing, and what to run when it stops being missing.

## Why nothing installs yet

Homebrew installs from a URL. shipkit has no remote, so there is nothing to
fetch. Everything below is ready except that one fact.

`scripts/release.sh` reflects this honestly: it builds the tarball, computes the
checksum, fills the checksum into the formula, and leaves the url as a named
placeholder rather than a plausible-looking guess. A formula carrying a wrong
url fails at install time, in front of whoever tried; a formula that says
`REPLACE_WITH_TARBALL_URL` fails here, in front of us.

## When the repository is published

```bash
git remote add origin <url>
scripts/release.sh            # reads the url from the remote
```

It then prints the four steps in order: tag, attach the tarball to the release,
copy the formula into a tap, install. The tap is an ordinary git repository
named `homebrew-<something>` — `homebrew-tools`, say — with the formula at
`Formula/shipkit.rb`. Consumers then run:

```bash
brew tap <owner>/tools
brew install shipkit
```

## The formula

`homebrew/shipkit.rb` depends on `node` and installs the npm package. That is
the simple route and it is the right one to start with: Node is already a
requirement for everyone who would install this, and `npm pack` produces a
29 kB tarball with no build step at install time.

The alternative — compiling a single executable with Node's SEA support or with
bun, so nothing external is needed — is a real option later. It removes the
`node` dependency and adds a build chain. Not worth it until someone without
Node wants to install shipkit.

Its `test do` block is not ceremonial. It runs `shipkit check` against a body
that leaves a placeholder in place and asserts the run is refused with the rule
named. That exercises config loading, the ESM entry point, and the validation
gate — so `brew test shipkit` failing means something real is broken, not that
a version string moved.

**No `license` line.** This repository has no LICENSE file. A private tap does
not require one, and choosing a license is not a packaging decision. Add both
together.

## The menu-bar cask

Not written yet, because the app does not exist yet. When it does, it ships as
a cask — that is the normal channel for a `.app` — living beside the formula in
the same tap.

**Signing is unresolved and it affects this.** An unsigned app installed by cask
is blocked by Gatekeeper on first launch: the user must right-click and choose
Open, once per machine. Signing and notarising with an Apple Developer account
removes that, at the cost of a signing step in the release.

`scripts/release.sh` is written so the step slots in between packing and the
checksum — the checksum must be taken *after* signing, because signing rewrites
the bundle. Until the account question is settled, the app is ad-hoc signed and
the right-click is documented for whoever installs it.
