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
    #expect(vectors.count >= 9)

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
    "head":"c","title":"t","commitMessage":"m","diffstat":"x","warnings":[]}
    """.utf8)
    let request = try decodeRequest(line)
    #expect(request.situation.title == "t")
    #expect(request.situation.commitMessage == "m")
}
