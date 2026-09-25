# Homebrew formula for shipkit's menu-bar application.
#
# A formula and not a cask, which is the opposite of the usual answer for a
# `.app`. Two reasons, both measured rather than preferred:
#
#   1. A cask downloads a file with an anonymous `curl`, and this repository is
#      private — the same 404 that made the CLI formula fetch over git. Casks
#      have no git download strategy; formulas do.
#   2. A formula can build, and building is what a git checkout requires.
#
# Separate from the `shipkit` formula on purpose. The CLI needs Node and nothing
# else; this needs a Swift toolchain. Folding them together would make every
# person who wants the command line install Xcode to get it.
class ShipkitMenubar < Formula
  desc "Menu-bar approval and review surface for shipkit"
  homepage "https://github.com/toygunchill/shipkit"
  url "https://github.com/toygunchill/shipkit.git",
      tag:      "v0.1.16",
      revision: "a475c06074dffe9643dc011387452085aef97db7"
  license "MIT"
  head "https://github.com/toygunchill/shipkit.git", branch: "main"

  depends_on xcode: ["16.0", :build]
  depends_on :macos
  # The app is the other half of `pr.approval: human`: it answers what the CLI
  # asks. Installing it without the thing that asks would be a menu-bar icon
  # with nothing to say.
  depends_on "toygunchill/tools/shipkit"

  def install
    cd "apps/menubar" do
      system "swift", "build", "-c", "release", "--disable-sandbox"

      # SwiftPM produces an executable; a menu-bar application needs a bundle
      # with an Info.plist saying it has no Dock icon. Assembled here rather
      # than by scripts/app.sh so the formula owns the one thing it installs.
      app = buildpath/"shipkit.app"
      (app/"Contents/MacOS").mkpath
      (app/"Contents/Resources").mkpath
      cp ".build/release/ShipkitMenuBar", app/"Contents/MacOS/ShipkitMenuBar"

      icon = buildpath/"design/icon/generated/shipkit.icns"
      cp icon, app/"Contents/Resources/shipkit.icns" if icon.exist?

      (app/"Contents/Info.plist").write <<~PLIST
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist version="1.0">
        <dict>
          <key>CFBundleName</key><string>shipkit</string>
          <key>CFBundleIdentifier</key><string>com.shipkit.menubar</string>
          <key>CFBundleExecutable</key><string>ShipkitMenuBar</string>
          <key>CFBundleIconFile</key><string>shipkit</string>
          <key>CFBundlePackageType</key><string>APPL</string>
          <key>CFBundleShortVersionString</key><string>#{version}</string>
          <key>LSMinimumSystemVersion</key><string>14.0</string>
          <key>LSUIElement</key><true/>
        </dict>
        </plist>
      PLIST

      # Ad-hoc. Without any signature at all Gatekeeper refuses the bundle
      # outright rather than offering the right-click-open path; with one it is
      # a single decision per machine. Real signing needs an Apple Developer
      # account and is a separate decision — see packaging/README.md.
      system "codesign", "--force", "--sign", "-", app
      prefix.install app
    end
  end

  def caveats
    <<~TEXT
      The app is at:
        #{opt_prefix}/shipkit.app

      Open it once, and it stays in your menu bar:
        open #{opt_prefix}/shipkit.app

      It is ad-hoc signed, so the first launch needs Finder's right-click → Open,
      once per machine. Gatekeeper refuses a double-click on an app it cannot
      trace to a Developer ID; the right-click is macOS's own way of saying
      "I know where this came from".

      To have it start with you, add it under
      System Settings → General → Login Items.
    TEXT
  end

  test do
    app = opt_prefix/"shipkit.app"
    assert_predicate app/"Contents/MacOS/ShipkitMenuBar", :executable?

    # Proves the bundle is one launchd and Gatekeeper will accept: a valid
    # signature, and an Info.plist that actually parses and says this is a
    # menu-bar app rather than a windowed one.
    system "codesign", "--verify", "--deep", app
    assert_equal "true",
      shell_output("/usr/libexec/PlistBuddy -c 'Print :LSUIElement' '#{app}/Contents/Info.plist'").strip
  end
end
