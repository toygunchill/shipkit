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

## The menu-bar app

`homebrew/shipkit-menubar.rb`, installed with `brew install shipkit-menubar`.

**A formula, not a cask** — the opposite of the usual answer for a `.app`, for
two measured reasons. A cask downloads a file with an anonymous `curl`, and this
repository is private: the same 404 that made the CLI formula fetch over git.
Casks have no git download strategy. And a git checkout has to be built, which
casks cannot do and formulas can.

Kept separate from `shipkit` so that installing the command line does not
require a Swift toolchain. It depends on `shipkit`, though — the app answers
what the CLI asks, and installing it alone would be a menu-bar icon with nothing
to say.

**Signing is still ad-hoc.** The bundle is signed with `-`, which is enough for
Gatekeeper to offer the right-click-open path instead of refusing outright; the
caveats say so in the words a person needs at that moment. Real signing needs an
Apple Developer account and would remove that one-time step — the formula is the
place it slots in, right before `prefix.install`.

`design/icon/generated/shipkit.icns` is git-ignored, so a checkout has no icon
and the formula copies one only if it is there. It costs nothing: `LSUIElement`
means there is no Dock icon, and the menu-bar mark is drawn in code.
