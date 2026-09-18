import Foundation

public let protocolVersion = 1

public struct Warning: Codable, Equatable, Sendable {
    public let check: String
    public let message: String

    public init(check: String, message: String) {
        self.check = check
        self.message = message
    }
}

/// One request per connection, exactly as `src/approval/protocol.ts` emits it.
public struct ApprovalRequest: Codable, Equatable, Sendable {
    public let protocolVersion: Int
    public let fingerprint: String
    public let repo: String
    public let branch: String
    public let base: String
    public let head: String
    public let title: String
    public let commitMessage: String
    public let diffstat: String
    public let warnings: [Warning]

    // `protocol` is a Swift keyword. Without this mapping the decoder quietly
    // finds no version at all and every request looks like a version mismatch.
    enum CodingKeys: String, CodingKey {
        case protocolVersion = "protocol"
        case fingerprint, repo, branch, base, head, title, commitMessage, diffstat, warnings
    }
}

public enum Decision: String, Codable, Sendable {
    case approved, denied, pending
}

public struct ApprovalResponse: Codable, Equatable, Sendable {
    public let protocolVersion: Int
    public let fingerprint: String
    public let decision: Decision

    public init(protocolVersion: Int, fingerprint: String, decision: Decision) {
        self.protocolVersion = protocolVersion
        self.fingerprint = fingerprint
        self.decision = decision
    }

    enum CodingKeys: String, CodingKey {
        case protocolVersion = "protocol"
        case fingerprint, decision
    }
}

public func decodeRequest(_ line: Data) throws -> ApprovalRequest {
    try JSONDecoder().decode(ApprovalRequest.self, from: line)
}

public func encodeResponse(_ response: ApprovalResponse) throws -> Data {
    var data = try JSONEncoder().encode(response)
    data.append(0x0A)
    return data
}

/// One item shipkit has to say about the change, as the panel draws it.
public struct OfferedItem: Codable, Equatable, Sendable, Identifiable {
    /// `finding`, `warning`, `readiness` or `advice` — which channel it came out of.
    public let kind: String
    /// The check id, rule id or topic, whichever the channel spells it as.
    public let id: String
    public let message: String
    /// `refuses`, `warns` or `informs`. How hard shipkit is pushing.
    public let severity: String

    public init(kind: String, id: String, message: String, severity: String) {
        self.kind = kind
        self.id = id
        self.message = message
        self.severity = severity
    }
}

/// One file the change touches, and where to put the cursor when it opens.
public struct OfferedFile: Codable, Equatable, Sendable, Identifiable {
    public let path: String
    public let status: String
    public let line: Int

    /// The path is the identity: `readPushDiff` never returns a path twice.
    public var id: String { path }

    public init(path: String, status: String, line: Int) {
        self.path = path
        self.status = status
        self.line = line
    }
}

/// A review offered while `shipkit review` is also serving its page.
///
/// `kind` is what tells this apart from an approval on the wire: an approval
/// request carries no `kind`, a Keychain token request carries `kind: "token"`.
/// The convention was already here, so a third kind needed no version bump.
///
/// The diff is deliberately absent. A popover is the wrong shape for four
/// hundred files, the page is one click away, and `files` carries what the
/// panel actually needs — a row per file with a button that opens it.
public struct ReviewRequest: Codable, Equatable, Sendable {
    public let protocolVersion: Int
    public let kind: String
    public let fingerprint: String
    /// The repository's name, for the panel to display.
    public let repo: String
    /// The checkout's absolute path. The editor button resolves a file against it.
    public let root: String
    public let branch: String
    public let base: String
    /// Empty when the review is running without an agent's answer.
    public let commitMessage: String
    public let diffstat: String
    public let items: [OfferedItem]
    public let files: [OfferedFile]

    enum CodingKeys: String, CodingKey {
        case protocolVersion = "protocol"
        case kind, fingerprint, repo, root, branch, base, commitMessage, diffstat, items, files
    }

    public init(
        protocolVersion: Int, kind: String, fingerprint: String,
        repo: String, root: String, branch: String, base: String,
        commitMessage: String, diffstat: String,
        items: [OfferedItem], files: [OfferedFile]
    ) {
        self.protocolVersion = protocolVersion
        self.kind = kind
        self.fingerprint = fingerprint
        self.repo = repo
        self.root = root
        self.branch = branch
        self.base = base
        self.commitMessage = commitMessage
        self.diffstat = diffstat
        self.items = items
        self.files = files
    }
}

/// One thing a person ticked, with whatever they wrote about it.
public struct SelectedItem: Codable, Equatable, Sendable {
    public let kind: String
    public let id: String
    public let message: String
    /// What they want done. Empty when they ticked the box and said nothing.
    public let note: String

    public init(kind: String, id: String, message: String, note: String) {
        self.kind = kind
        self.id = id
        self.message = message
        self.note = note
    }
}

/// What the person said about a review.
///
/// Two answers rather than one with an empty list, because the difference is
/// what the command does next: an empty selection clears whatever was pending,
/// and that is a decision, not the absence of one.
public enum ReviewAnswer: String, Codable, Sendable {
    case selected, nothing
}

public struct ReviewResponse: Codable, Equatable, Sendable {
    public let protocolVersion: Int
    public let kind = "review"
    public let fingerprint: String
    public let answer: ReviewAnswer
    public let items: [SelectedItem]

    public init(protocolVersion: Int, fingerprint: String, answer: ReviewAnswer, items: [SelectedItem]) {
        self.protocolVersion = protocolVersion
        self.fingerprint = fingerprint
        self.answer = answer
        self.items = items
    }

    enum CodingKeys: String, CodingKey {
        case protocolVersion = "protocol"
        case kind, fingerprint, answer, items
    }
}

public func decodeReviewRequest(_ line: Data) throws -> ReviewRequest {
    try JSONDecoder().decode(ReviewRequest.self, from: line)
}

public func encodeReviewResponse(_ response: ReviewResponse) throws -> Data {
    var data = try JSONEncoder().encode(response)
    data.append(0x0A)
    return data
}
