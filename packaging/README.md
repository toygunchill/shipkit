# Packaging

What is here, what is missing, and what to run when it stops being missing.

## How it installs

```bash
brew tap toygunchill/tools
brew trust toygunchill/tools
brew install shipkit
```

The `brew trust` line is not optional and not ours: current Homebrew refuses to
load a formula from a third-party tap until the tap is trusted, and says so with
the exact command. Anyone installing this will meet it, so it belongs in the
instructions rather than in a surprise.

The tap is `toygunchill/homebrew-tools`, an ordinary private repository with the
formula at `Formula/shipkit.rb`.

## Why it fetches over git rather than from a release tarball

Measured, not preferred. The repository is private, and Homebrew downloads a
release asset with an anonymous `curl`:

```
Error: Failed to download resource "shipkit (0.1.0)"
curl: (56) The requested URL returned error: 404
```

A 404, with nothing to say it was a permissions problem. `brew tap` had worked
moments earlier because a tap is a `git clone`, and git carries the person's own
credentials. So git is the only channel a private formula can use, and the
formula's `url` is the repository with `tag:` and a pinned `revision:`.

Two consequences worth naming. The checkout carries no `dist/` — it is
git-ignored — so the formula builds: `npm ci`, `npm run build`, then
`npm install`. And the release tarball `scripts/release.sh` still produces is now
a convenience for anyone who wants one, not the install channel.

## Cutting a release

```bash
scripts/release.sh            # reads the url from the remote
git tag vX.Y.Z && git push origin vX.Y.Z
```

Then update `tag:` and `revision:` in the formula and push the tap. `revision:`
pins the commit so a moved tag cannot change what an install gets.

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

**`license "MIT"`.** It matches `LICENSE` and `package.json`, and `brew audit`
compares all three — which is what keeps them from drifting apart. `npm pack`
includes `LICENSE` in the tarball on its own, whatever `files` says, so the
license travels with every install.

## The menu-bar cask

Not written yet. The app itself exists — `apps/menubar`, assembled into a
bundle by `scripts/app.sh` — but it is not yet packaged, because a cask is the
normal channel for a `.app` and that channel is only worth opening once the
signing question below is answered.

**Signing is unresolved and it affects this.** An unsigned app installed by cask
is blocked by Gatekeeper on first launch: the user must right-click and choose
Open, once per machine. Signing and notarising with an Apple Developer account
removes that, at the cost of a signing step in the release.

`scripts/release.sh` is written so the step slots in between packing and the
checksum — the checksum must be taken *after* signing, because signing rewrites
the bundle. Until the account question is settled, the app is ad-hoc signed and
the right-click is documented for whoever installs it.
