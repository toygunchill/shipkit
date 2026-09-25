import Foundation
import Testing
@testable import ShipkitKit

@Suite("Starting an agent on a review")
struct AgentLaunchTests {
    @Test func itChangesDirectoryBeforeRunningTheAgent() {
        let line = AgentLaunch.shellLine(command: "claude", directory: "/work/app")

        #expect(line?.hasPrefix("cd '/work/app' && claude ") == true)
    }

    // The rules are read from the checkout. An agent started somewhere else
    // reviews the pull request against whatever conventions happen to be there,
    // so a missing directory must stop the line rather than let it run on.
    @Test func itStopsWhenTheDirectoryIsGoneRatherThanRunningAnywhere() {
        let line = AgentLaunch.shellLine(command: "claude", directory: "/work/app")

        #expect(line?.contains(" && ") == true)
        #expect(line?.contains("; ") == false)
    }

    // This project is developed in a directory with a space in its name. A
    // command that breaks on one is a button that works on the author's machine
    // and nowhere else.
    @Test func itSurvivesASpaceInThePath() {
        let line = AgentLaunch.shellLine(command: "claude", directory: "/Users/me/Github Pegasus/app")

        #expect(line?.contains("'/Users/me/Github Pegasus/app'") == true)
    }

    @Test func itSurvivesAnApostropheInThePath() {
        let line = AgentLaunch.shellLine(command: "claude", directory: "/Users/me/Ali's work")

        // Closed, escaped, reopened — the shell's only way to put one inside a
        // single-quoted string.
        #expect(line?.contains(#"'/Users/me/Ali'\''s work'"#) == true)
    }

    // `~` is what a person types into a settings field, and `cd` does not expand
    // it once the string is quoted.
    @Test func itExpandsATildeTheUserTyped() {
        let line = AgentLaunch.shellLine(command: "claude", directory: "~/app")

        #expect(line?.contains("~") == false)
        #expect(line?.contains(NSHomeDirectory()) == true)
    }

    @Test func thePromptIsQuotedSoItArrivesAsOneArgument() {
        let line = AgentLaunch.shellLine(command: "claude", directory: "/w")

        #expect(line?.hasSuffix("'\(AgentLaunch.prompt)'") == true)
    }

    // With nothing configured the button must fall back to explaining itself,
    // not run `cd  &&  ''`.
    @Test func nothingConfiguredProducesNoLine() {
        #expect(AgentLaunch.shellLine(command: "", directory: "/w") == nil)
        #expect(AgentLaunch.shellLine(command: "claude", directory: "") == nil)
        #expect(AgentLaunch.shellLine(command: "   ", directory: "  ") == nil)
    }

    @Test func aCommandWithItsOwnArgumentsIsLeftAlone() {
        let line = AgentLaunch.shellLine(command: "claude --agent reviewer", directory: "/w")

        #expect(line?.contains("&& claude --agent reviewer '") == true)
    }

    // A file, not an Apple Event: `do script` timed out with -1712 and brought
    // Terminal to the front without running anything, which looks like the
    // button half-worked. Nothing here needs escaping for a second language.
    @Test func theScriptIsAShellFileThatRunsTheLineVerbatim() {
        let line = "cd '/a b' && claude 'do \"this\"'"

        let script = AgentLaunch.scriptContents(line)

        #expect(script.hasPrefix("#!/bin/sh\n"))
        #expect(script.contains(line))
    }

    // The line is a compound command — `cd … && agent …` — and `exec` replaces the
    // shell with the *first* of those, so the agent is never reached. That shipped
    // once: Terminal opened, printed "[Process completed]", and the button looked
    // broken.
    @Test func itDoesNotExecACompoundCommand() {
        let line = AgentLaunch.shellLine(command: "claude", directory: "/w") ?? ""

        let script = AgentLaunch.scriptContents(line)

        #expect(script.contains("exec ") == false)
        #expect(script.contains("cd '/w' && claude "))
    }

    @Test func theScriptIsWrittenExecutableAndOnlyForItsOwner() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("shipkit-launch-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }

        let at = try AgentLaunch.writeScript("echo hi", into: directory)

        let mode = try FileManager.default.attributesOfItem(atPath: at.path)[.posixPermissions] as? NSNumber
        #expect(mode?.int16Value == 0o700)
        #expect(at.pathExtension == "command")
    }
}
