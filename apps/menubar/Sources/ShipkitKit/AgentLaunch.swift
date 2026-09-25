import Foundation

/// Starting an agent on a review, from the menu bar.
///
/// The menu bar cannot hand work to an agent that is already running: MCP is
/// request/response and a server does not interrupt its client. What it can do
/// is *start* one, in the right directory, with the request already waiting —
/// and that is a real one-press trigger rather than a note left on a desk.
///
/// Which command starts an agent is not something shipkit knows. `claude`,
/// `codex`, something wrapped in a script — it is the person's choice, so it is
/// a setting, and with nothing set the button falls back to saying so.
public enum AgentLaunch {
    /// What the agent is told when it starts. Phrased to match what
    /// `shipkit_pending_review` says it answers to, so an agent reading the tool
    /// list knows this sentence is for it.
    public static let prompt = "Pick up the review I asked for from the shipkit menu bar."

    /// Single-quotes a string for `sh`.
    ///
    /// Paths have spaces in them — this project is developed in a directory that
    /// does — and a command that breaks on a space would be a button that works
    /// on the author's machine and nowhere else. A single-quoted string ends at
    /// the first `'`, so an embedded one is closed, escaped and reopened.
    public static func shellQuoted(_ value: String) -> String {
        "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }

    /// Escapes a string for an AppleScript string literal.
    public static func appleScriptQuoted(_ value: String) -> String {
        value
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
    }

    /// The shell line Terminal is asked to run, or `nil` when nothing is configured.
    ///
    /// `cd` first, because the rules are read from the checkout: an agent started
    /// in the wrong directory reviews the pull request against whatever
    /// conventions happen to be there. `&&` and not `;` — if the directory is
    /// gone, failing loudly beats running the agent somewhere arbitrary.
    public static func shellLine(command: String, directory: String) -> String? {
        let command = command.trimmingCharacters(in: .whitespacesAndNewlines)
        let directory = directory.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !command.isEmpty, !directory.isEmpty else { return nil }
        return "cd \(shellQuoted(expandingTilde(directory))) && \(command) \(shellQuoted(prompt))"
    }

    /// `~` is what a person types in a settings field and not something `cd`
    /// expands when the string is quoted.
    public static func expandingTilde(_ path: String) -> String {
        (path as NSString).expandingTildeInPath
    }

    /// The AppleScript that opens Terminal on that line.
    public static func terminalScript(running line: String) -> String {
        """
        tell application "Terminal"
        activate
        do script "\(appleScriptQuoted(line))"
        end tell
        """
    }
}
