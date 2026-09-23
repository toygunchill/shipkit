# Homebrew formula for shipkit.
#
# `scripts/release.sh` keeps the tag and the pinned revision in step with the
# repository. See packaging/README.md for how a release is cut and why this
# fetches over git rather than from a release tarball.
class Shipkit < Formula
  desc "Holds AI coding agents to a team's pull-request conventions"
  homepage "https://github.com/toygunchill/shipkit"
  # Fetched over git, not as a release tarball.
  #
  # Measured, not chosen: this repository is private, and Homebrew downloads a
  # release asset with an anonymous `curl` — which gets a 404 and reports it as
  # a failed download, with nothing to say it was a permissions problem. Git is
  # the one channel that carries the person's own credentials (`brew tap`
  # already clones this tap the same way), so a private formula has to fetch
  # this way or not at all.
  #
  # `revision:` pins the commit so the tag cannot be moved under an install, and
  # `tag:` is what a person reads.
  url "https://github.com/toygunchill/shipkit.git",
      tag:      "v0.1.4",
      revision: "fab783cfb01bd00e03606b37d391db6d72a17d50"
  license "MIT"
  head "https://github.com/toygunchill/shipkit.git", branch: "main"

  depends_on "node"

  def install
    # `dist/` is git-ignored, so a git checkout carries source and no build. The
    # published tarball carried `dist` already; this does not, so the compile
    # that `prepublishOnly` used to do at pack time happens here instead.
    system "npm", "ci"
    system "npm", "run", "build"

    # Development dependencies were needed for that build and are dead weight in
    # the installed tree — `npm install` below re-resolves from package.json, so
    # what lands in libexec is the runtime set only.
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    # Proves the binary is on PATH, node resolves, and the ESM entry point loads.
    assert_match version.to_s, shell_output("#{bin}/shipkit --version")

    # Proves the real work is reachable, not merely that the process starts:
    # `check` is the one command with no side effects, and a body that leaves the
    # template's own instruction text in place must be refused with exit 1.
    (testpath/"body.md").write <<~BODY
      ## Summary

      TBD
    BODY
    (testpath/".shipkit.yml").write <<~YAML
      pr:
        titlePattern: '^(feat|fix): .+'
        forbidden: ["TBD"]
        sections:
          - name: Summary
            required: true
      branch:
        pattern: '^(feature|bugfix)/.+'
      jira:
        baseUrl: https://example.invalid/jira
        keyPattern: 'ABC-\d+'
    YAML

    output = shell_output(
      "#{bin}/shipkit check --title 'fix: x' --body-file body.md " \
      "--config .shipkit.yml 2>&1",
      1,
    )
    assert_match "forbidden-text", output
  end
end
