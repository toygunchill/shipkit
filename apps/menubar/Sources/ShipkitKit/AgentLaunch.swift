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

    /// The script Terminal is asked to open.
    ///
    /// A file, not an Apple Event. `tell application "Terminal" … do script` was tried
    /// first and timed out with -1712: Terminal came to the front and the command never
    /// ran, which is the worst shape a failure can take here because it looks like the
    /// button half-worked. A `.command` file is what `open` hands to Terminal directly,
    /// with no Apple Events, no automation permission to be missing, and nothing to time
    /// out.
    public static func scriptContents(_ line: String) -> String {
        // Run the line, do not `exec` it. An earlier version did, to keep a shell from
        // sitting as the agent's parent — and `exec` replaces the shell with the *first*
        // command, so `exec cd … && claude …` ran `cd`, exited, and never reached the
        // agent. Terminal showed "[Process completed]" instantly and the button looked
        // broken for a reason that was purely this line.
        "#!/bin/sh\n\(line)\n"
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

    /// Writes the script somewhere Terminal can open it, and returns where.
    ///
    /// Left behind rather than deleted: the shell reads a script as it runs it, so removing
    /// the file under a long-lived agent session is a way to break it. The temporary
    /// directory is what cleans these up.
    public static func writeScript(_ line: String, into directory: URL) throws -> URL {
        let at = directory.appendingPathComponent("shipkit-review-\(UUID().uuidString).command")
        try scriptContents(line).write(to: at, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: at.path)
        return at
    }
}
