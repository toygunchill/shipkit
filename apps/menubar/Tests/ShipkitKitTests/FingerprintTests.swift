import Foundation
import Testing
@testable import ShipkitKit

private struct Vector: Decodable {
    struct Sit: Decodable {
        let repo, branch, base, head, title, commitMessage: String
        let warnings: [Warning]
    }
    let name: String
    let situation: Sit
    let fingerprint: String
}

private func loadVectors() throws -> [Vector] {
    // The fixture lives at the repository root, four levels above this package's
    // Tests directory. Walking up from #filePath keeps it working wherever the
    // package is checked out.
    var url = URL(fileURLWithPath: #filePath)
    for _ in 0..<5 { url.deleteLastPathComponent() }
    url.appendPathComponent("tests/fixtures/fingerprint-vectors.json")
    return try JSONDecoder().decode([Vector].self, from: Data(contentsOf: url))
}

@Test func matchesEveryVectorInTheSharedFixture() throws {
    let vectors = try loadVectors()
    #expect(vectors.count >= 11)

    for vector in vectors {
        let situation = Situation(
            repo: vector.situation.repo,
            branch: vector.situation.branch,
            base: vector.situation.base,
            head: vector.situation.head,
            title: vector.situation.title,
            commitMessage: vector.situation.commitMessage,
            warnings: vector.situation.warnings
        )
        #expect(fingerprint(situation) == vector.fingerprint, "vector: \(vector.name)")
    }
}

@Test func countsBytesNotCharacters() {
    let situation = Situation(
        repo: "/r", branch: "fix 🎉", base: "d", head: "c",
        title: "t", commitMessage: "m", warnings: []
    )
    // "fix 🎉" is 6 UTF-16 code units (what `.count` would give in JS) but only
    // 5 Swift Characters — and 8 UTF-8 bytes, which is the value that must appear.
    #expect(canonical(situation).contains("8:fix 🎉"))
}

@Test func endsWithoutATrailingNewline() {
    let situation = Situation(
        repo: "/r", branch: "b", base: "d", head: "c",
        title: "t", commitMessage: "m", warnings: []
    )
    #expect(canonical(situation).hasSuffix("\n") == false)
}

@Test func sortsWarningsByCheckThenMessage() {
    let unsorted = [
        Warning(check: "blocking-label", message: "z"),
        Warning(check: "approvals-dismissed", message: "b"),
        Warning(check: "approvals-dismissed", message: "a"),
    ]
    #expect(sortWarnings(unsorted).map(\.message) == ["a", "b", "z"])
}

/// Swift's `String ==` calls these two check ids equal — they are the same
/// character spelled two ways — while JavaScript's `!==` calls them different.
/// The order has to follow JavaScript's, because the fixture was generated from
/// `src/approval/fingerprint.ts`. Code unit 0x0065 sorts before 0x00E9, so the
/// decomposed spelling comes first however the messages compare.
@Test func ordersCanonicallyEqualCheckIdsByTheirCodeUnits() {
    let precomposed = Warning(check: "caf\u{e9}", message: "a")
    let decomposed = Warning(check: "caf\u{65}\u{301}", message: "b")
    #expect(sortWarnings([precomposed, decomposed]).map(\.message) == ["b", "a"])
    #expect(sortWarnings([decomposed, precomposed]).map(\.message) == ["b", "a"])
}

/// The same pair with identical messages. Under the old guard both directions
/// compared `false`, leaving the order to whatever `sorted(by:)` happened to do.
/// This asserts on the code units rather than on `Warning ==`, which compares
/// its Strings canonically and would call either order correct.
@Test func ordersCanonicallyEqualCheckIdsDeterministicallyWhenMessagesMatch() {
    let precomposed = Warning(check: "caf\u{e9}", message: "same")
    let decomposed = Warning(check: "caf\u{65}\u{301}", message: "same")
    func spellings(_ warnings: [Warning]) -> [[UInt16]] {
        warnings.map { Array($0.check.utf16) }
    }
    let expected = [Array(decomposed.check.utf16), Array(precomposed.check.utf16)]
    #expect(spellings(sortWarnings([precomposed, decomposed])) == expected)
    #expect(spellings(sortWarnings([decomposed, precomposed])) == expected)
}

@Test func sortsByCodeUnitOrderSoUppercaseComesFirst() {
    let mixed = [Warning(check: "x", message: "alpha"), Warning(check: "x", message: "Alpha")]
    #expect(sortWarnings(mixed).map(\.message) == ["Alpha", "alpha"])
}

@Test func theOrderOfTheInputDoesNotChangeTheHash() {
    let a = Situation(
        repo: "/r", branch: "b", base: "d", head: "c", title: "t", commitMessage: "m",
        warnings: [Warning(check: "untracked-files", message: "u"),
                   Warning(check: "base-mismatch", message: "b")]
    )
    let b = Situation(
        repo: "/r", branch: "b", base: "d", head: "c", title: "t", commitMessage: "m",
        warnings: [Warning(check: "base-mismatch", message: "b"),
                   Warning(check: "untracked-files", message: "u")]
    )
    #expect(fingerprint(a) == fingerprint(b))
}

@Test func aRequestExposesTheSituationItClaims() throws {
    let line = Data("""
    {"protocol":1,"fingerprint":"f","repo":"/r","branch":"b","base":"d",\
    "head":"c","title":"t","commitMessage":"m","diffstat":"x",\
    "warnings":[{"check":"x","message":"w"}]}
    """.utf8)
    let request = try decodeRequest(line)
    #expect(request.situation.repo == "/r")
    #expect(request.situation.branch == "b")
    #expect(request.situation.base == "d")
    #expect(request.situation.head == "c")
    #expect(request.situation.title == "t")
    #expect(request.situation.commitMessage == "m")
    #expect(request.situation.warnings == [Warning(check: "x", message: "w")])
}
