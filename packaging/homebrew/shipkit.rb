# Homebrew formula for shipkit.
#
# The url and sha256 below are placeholders. `scripts/release.sh` fills them in
# from a tarball it builds, and prints what to do next. Nothing here works until
# the repository is published somewhere Homebrew can fetch from — see
# packaging/README.md.
#
# No `license` line: this repository carries no LICENSE file yet. A private tap
# does not require one, and inventing a license is not mine to do. Add both when
# the repository is published.
class Shipkit < Formula
  desc "Holds AI coding agents to a team's pull-request conventions"
  homepage "REPLACE_WITH_REPOSITORY_URL"
  url "REPLACE_WITH_TARBALL_URL"
  sha256 "REPLACE_WITH_TARBALL_SHA256"

  depends_on "node"

  def install
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
