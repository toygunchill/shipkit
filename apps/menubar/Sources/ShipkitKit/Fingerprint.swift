import CryptoKit
import Foundation

/// Everything an approval is bound to. The mirror of `Situation` in
/// `src/approval/fingerprint.ts`; the two must render identically.
public struct Situation: Sendable, Equatable {
    public let repo: String
    public let branch: String
    public let base: String
    public let head: String
    public let title: String
    public let commitMessage: String
    public let warnings: [Warning]

    public init(
        repo: String, branch: String, base: String, head: String,
        title: String, commitMessage: String, warnings: [Warning]
    ) {
        self.repo = repo
        self.branch = branch
        self.base = base
        self.head = head
        self.title = title
        self.commitMessage = commitMessage
        self.warnings = warnings
    }
}

private let version = "shipkit-approval-v1"

/// Code-unit order, matching the TypeScript. Not `localeCompare`, which is
/// locale-sensitive, and not a collation that would put "alpha" before "Alpha".
///
/// Comparison must walk UTF-16 code units, not Swift's native `String <`,
/// which compares Unicode scalars. The two disagree for exactly the pair that
/// matters here: an astral character (a UTF-16 surrogate pair, whose leading
/// unit is below 0xE000) against a BMP character at or above U+E000. Scalar
/// order puts the astral character last; JavaScript's `<`, which compares
/// UTF-16 code units, puts it first. Swift adapts to match JavaScript because
/// `src/approval/fingerprint.ts` is the implementation the fixture was
/// generated from.
private func utf16Less(_ a: String, _ b: String) -> Bool {
    a.utf16.lexicographicallyPrecedes(b.utf16)
}

public func sortWarnings(_ warnings: [Warning]) -> [Warning] {
    warnings.sorted { a, b in
        if a.check != b.check { return utf16Less(a.check, b.check) }
        return utf16Less(a.message, b.message)
    }
}

/// Length-prefixed, not escaped. A delimiter that can appear inside a warning
/// message is a disagreement waiting for the first message that contains one.
public func canonical(_ situation: Situation) -> String {
    func field(_ value: String) -> String { "\(value.utf8.count):\(value)" }

    let sorted = sortWarnings(situation.warnings)
    var lines = [
        version,
        field(situation.repo),
        field(situation.branch),
        field(situation.base),
        field(situation.head),
        field(situation.title),
        field(situation.commitMessage),
        String(sorted.count),
    ]
    for warning in sorted {
        lines.append(field(warning.check))
        lines.append(field(warning.message))
    }
    return lines.joined(separator: "\n")
}

public func fingerprint(_ situation: Situation) -> String {
    let digest = SHA256.hash(data: Data(canonical(situation).utf8))
    return digest.map { String(format: "%02x", $0) }.joined()
}

public extension ApprovalRequest {
    /// The situation this request claims. The listener re-hashes it and refuses
    /// when the result is not the fingerprint the request carries — which is what
    /// makes the facts on screen provably the facts that were hashed.
    var situation: Situation {
        Situation(
            repo: repo, branch: branch, base: base, head: head,
            title: title, commitMessage: commitMessage, warnings: warnings
        )
    }
}
