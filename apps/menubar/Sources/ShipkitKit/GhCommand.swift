import Foundation

/// Why a `gh` invocation produced nothing usable. Every case carries a short,
/// one-line reason, because the panel shows exactly one line of it: the rule
/// for the inbox is that a number it cannot establish is shown as absent with
/// a reason, never as a zero and never as the last number it happened to know.
public enum GhFailure: Error, Equatable, Sendable {
    /// None of the candidate paths held an executable.
    case notInstalled(searched: [String])
    /// The process could not be started at all (missing, not executable, a
    /// sandbox refusal). Distinct from `notInstalled`: here the path existed.
    case spawnFailed(String)
    /// The process was still running when the deadline passed and was
    /// terminated. A hung `gh` must not wedge the panel.
    case timedOut(seconds: Double)
    /// Ran to completion with a non-zero status. `message` is the first line
    /// of stderr, which is where `gh` puts "not logged in" and HTTP errors.
    case failed(exitCode: Int32, message: String)

    /// One line, short enough for the panel and specific enough to act on.
    public var shortReason: String {
        switch self {
        case .notInstalled(let searched):
            return "gh was not found in \(searched.joined(separator: ", "))"
        case .spawnFailed(let detail):
            return "gh could not be started: \(detail)"
        case .timedOut(let seconds):
            return "gh did not answer within \(Int(seconds))s"
        case .failed(let exitCode, let message):
            return message.isEmpty
                ? "gh exited \(exitCode)"
                : "gh exited \(exitCode): \(message)"
        }
    }
}

/// Runs `gh` and hands back its standard output.
///
/// The whole point of naming this type is the seam: `PullRequestInbox` takes a
/// closure of this shape, so every test in this package drives the parser and
/// the bucket assembly from bytes it wrote itself. No test spawns a process and
/// no test touches the network — the only authenticated host here is a company
/// GitHub Enterprise server, and reaching it from a test suite is out of bounds.
public struct GhCommand: Sendable {
    /// Where to look for `gh`, in order. A menu-bar application launched by
    /// LaunchServices inherits the session environment, not a login shell's,
    /// so `PATH` there is the bare system default and `/opt/homebrew/bin` —
    /// where an Apple-silicon Homebrew puts `gh` — is not on it. Looking in
    /// known locations is what makes the inbox work for an app double-clicked
    /// from Finder rather than only for one started from a terminal.
    public static let candidatePaths = [
        "/opt/homebrew/bin/gh",
        "/usr/local/bin/gh",
        "/usr/bin/gh",
    ]

    /// First candidate that is an executable file, or `nil`.
    ///
    /// The existence check is injected so the ordering can be tested without
    /// depending on what happens to be installed on the machine running the
    /// tests.
    public static func resolvePath(
        isExecutable: (String) -> Bool = { FileManager.default.isExecutableFile(atPath: $0) }
    ) -> String? {
        candidatePaths.first(where: isExecutable)
    }

    public let executablePath: String
    /// How long `gh` gets before it is terminated. A network call to an
    /// enterprise server behind a VPN that is not connected does not fail
    /// fast, and the refresh this bounds runs on panel appearance — so the
    /// deadline is the difference between "the counts say they could not be
    /// determined" and a panel that never draws its content.
    public let timeoutSeconds: Double

    public init(executablePath: String, timeoutSeconds: Double = 12) {
        self.executablePath = executablePath
        self.timeoutSeconds = timeoutSeconds
    }

    /// The closure `PullRequestInbox` wants, bound to a real process.
    ///
    /// Returns `.notInstalled` rather than spawning when no candidate path
    /// holds an executable, and resolves the path per call: a `gh` installed
    /// while the app is running should start working without a relaunch.
    public static func live(timeoutSeconds: Double = 12) -> @Sendable ([String]) async -> Result<Data, GhFailure> {
        { arguments in
            guard let path = resolvePath() else {
                return .failure(.notInstalled(searched: candidatePaths))
            }
            return await GhCommand(executablePath: path, timeoutSeconds: timeoutSeconds)
                .run(arguments)
        }
    }

    public func run(_ arguments: [String]) async -> Result<Data, GhFailure> {
        // Off Swift's cooperative pool, for the same reason `Listener` moves
        // its blocking socket calls: that pool is sized to the core count and
        // never overcommitted, and waiting out a process deadline on one of
        // its few threads stalls every other `await` in the process, not just
        // this refresh.
        await withCheckedContinuation { continuation in
            let path = executablePath
            let seconds = timeoutSeconds
            DispatchQueue.global().async {
                continuation.resume(returning: Self.runBlocking(path, arguments, seconds))
            }
        }
    }

    private static func runBlocking(
        _ path: String,
        _ arguments: [String],
        _ timeoutSeconds: Double
    ) -> Result<Data, GhFailure> {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: path)
        process.arguments = arguments
        // The environment is inherited deliberately, not cleared: `gh` reads
        // its host and credentials from `$HOME/.config/gh/hosts.yml`, and an
        // emptied environment turns an authenticated CLI into an
        // unauthenticated one for no gain.
        process.standardInput = FileHandle.nullDevice
        let output = Pipe()
        let errorOutput = Pipe()
        process.standardOutput = output
        process.standardError = errorOutput

        let exited = DispatchSemaphore(value: 0)
        process.terminationHandler = { _ in exited.signal() }
        do {
            try process.run()
        } catch {
            return .failure(.spawnFailed("\(error)"))
        }

        // Both pipes are drained on their own threads before anything waits on
        // the process. A pipe buffer is finite (64KB here): a `gh` whose output
        // is larger than the buffer blocks writing until someone reads, so
        // waiting for exit first and reading afterwards deadlocks on exactly
        // the large responses this inbox asks for.
        //
        // The bytes land in a reference box rather than in captured `var`s:
        // two concurrent closures mutating a local variable is a data race the
        // compiler is right to refuse, and a lock it cannot see does not change
        // its mind. The box carries its own lock and says so in its name.
        let collected = LockedOutput()
        let readers = DispatchGroup()
        readers.enter()
        DispatchQueue.global().async {
            let data = output.fileHandleForReading.readDataToEndOfFile()
            collected.set(standardOutput: data)
            readers.leave()
        }
        readers.enter()
        DispatchQueue.global().async {
            let data = errorOutput.fileHandleForReading.readDataToEndOfFile()
            collected.set(standardError: data)
            readers.leave()
        }

        if exited.wait(timeout: .now() + timeoutSeconds) == .timedOut {
            process.terminate()
            // SIGTERM, then a short grace period, then give up waiting on it.
            // The readers end when the process's ends of the pipes close; if
            // `gh` ignores SIGTERM this returns anyway rather than holding the
            // refresh open forever.
            _ = exited.wait(timeout: .now() + 2)
            _ = readers.wait(timeout: .now() + 2)
            return .failure(.timedOut(seconds: timeoutSeconds))
        }
        _ = readers.wait(timeout: .now() + 5)

        guard process.terminationStatus == 0 else {
            let text = String(decoding: collected.standardError, as: UTF8.self)
            let firstLine = text
                .split(whereSeparator: \.isNewline)
                .first
                .map(String.init)?
                .trimmingCharacters(in: .whitespaces) ?? ""
            return .failure(.failed(exitCode: process.terminationStatus, message: firstLine))
        }
        return .success(collected.standardOutput)
    }
}

/// What the two pipe readers write into, and the lock that makes that safe.
/// `@unchecked Sendable` because the checking is the lock, which is the
/// smallest honest thing to say here.
private final class LockedOutput: @unchecked Sendable {
    private let lock = NSLock()
    private var out = Data()
    private var error = Data()

    func set(standardOutput data: Data) {
        lock.lock()
        out = data
        lock.unlock()
    }

    func set(standardError data: Data) {
        lock.lock()
        error = data
        lock.unlock()
    }

    var standardOutput: Data {
        lock.lock()
        defer { lock.unlock() }
        return out
    }

    var standardError: Data {
        lock.lock()
        defer { lock.unlock() }
        return error
    }
}
