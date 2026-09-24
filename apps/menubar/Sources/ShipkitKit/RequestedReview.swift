import Foundation

/// A review the person asked for from the menu bar, left where an agent will find it.
///
/// The delivery mechanism, and the reason it is a file rather than a message.
/// The menu bar knows an agent is attached (see `AgentPresence`) but cannot
/// interrupt it, so the request waits somewhere the agent's next turn reads.
/// One press, and the work begins on that next turn — not instantly, which is
/// the honest description and the one the button uses.
public struct RequestedReview: Sendable, Equatable, Codable {
    public let version: Int
    /// `owner/name`, or `host/owner/name` on an enterprise forge.
    public let repository: String
    public let number: Int
    public let title: String
    public let url: String
    public let requestedAt: Date

    public init(repository: String, number: Int, title: String, url: String, requestedAt: Date = Date()) {
        self.version = 1
        self.repository = repository
        self.number = number
        self.title = title
        self.url = url
        self.requestedAt = requestedAt
    }
}

public enum RequestedReviewStore {
    /// Beside the socket and the rest of this application's state, not in the
    /// repository being reviewed: the request is about a pull request, which may
    /// belong to a repository this machine has never checked out.
    public static func defaultURL(
        home: URL = URL(fileURLWithPath: NSHomeDirectory())
    ) -> URL {
        home
            .appendingPathComponent("Library/Application Support/shipkit", isDirectory: true)
            .appendingPathComponent("requested-review.json", isDirectory: false)
    }

    /// Writes the request, replacing any earlier one.
    ///
    /// Replacing rather than queueing. A queue would mean a press could be
    /// answered minutes later by an agent working through a backlog, on a pull
    /// request the person has stopped thinking about — and the thing being asked
    /// for ends in comments published under their name. The most recent press is
    /// the only one that reflects an intention anybody still holds.
    @discardableResult
    public static func write(
        _ review: RequestedReview,
        to url: URL = RequestedReviewStore.defaultURL()
    ) throws -> URL {
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        encoder.dateEncodingStrategy = .iso8601
        try encoder.encode(review).write(to: url, options: .atomic)
        // 0600: it names a repository and a pull request, which on a private
        // forge is not everybody's business.
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        return url
    }

    public static func read(from url: URL = RequestedReviewStore.defaultURL()) -> RequestedReview? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try? decoder.decode(RequestedReview.self, from: data)
    }

    public static func clear(at url: URL = RequestedReviewStore.defaultURL()) {
        try? FileManager.default.removeItem(at: url)
    }

    /// What to run when no agent is attached.
    ///
    /// The command is built here rather than in the view so it can be tested,
    /// and so the two paths — hand it to an agent, or tell the person how to
    /// start one — cannot drift into asking for different things.
    public static func command(repository: String, number: Int) -> String {
        "shipkit pr-review brief --pr \(number) --repo-slug \(repository)"
    }
}

/// The pull request number in a forge URL, or `nil` when there is not one.
///
/// Read from the URL because the inbox carries one and does not carry a number.
/// Strict about the shape: the last path component must be all digits and be
/// preceded by `pull` or `pulls`, so a link to a comment, a file, or a branch
/// that merely ends in digits is not mistaken for the pull request itself.
public func inboxPullRequestNumber(_ url: String) -> Int? {
    guard let parsed = URL(string: url) else { return nil }
    let parts = parsed.pathComponents.filter { $0 != "/" }
    guard let last = parts.last, let number = Int(last), number > 0 else { return nil }
    guard parts.count >= 2 else { return nil }
    let kind = parts[parts.count - 2]
    guard kind == "pull" || kind == "pulls" else { return nil }
    // `Int` accepts a leading plus or minus and surrounding nothing else; a
    // component like "+12" would parse but is not what a forge writes.
    guard last.allSatisfy(\.isNumber) else { return nil }
    return number
}
