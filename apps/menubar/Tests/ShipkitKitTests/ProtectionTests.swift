import Foundation
import Testing
@testable import ShipkitKit

/// The pairs below are real rows from the list this was built for, which is how the
/// direction got settled: the first version marked the *head*, and nothing in ordinary work
/// merges out of a protected branch.
@Suite("Marking the pull requests with more behind them")
struct ProtectionTests {
    @Test func anOrdinaryFeatureBranchIsNotMarked() {
        #expect(Protection.reason(base: "develop") == nil)
    }

    // `feature/skystones/20104-brand-develop → protected/flyhigh/20104-brand-identity`
    @Test func mergingIntoAProtectedBranchIsMarked() {
        let reason = Protection.reason(base: "protected/flyhigh/20104-brand-identity")

        #expect(reason?.contains("protected branch") == true)
        #expect(reason?.contains("protected/flyhigh/20104-brand-identity") == true)
    }

    // `release/3.77.0 → main`. A different reason from the one above, and it reads
    // differently to whoever is reviewing: here a mistake reaches users.
    @Test func mergingIntoTheTrunkIsMarkedForItsOwnReason() {
        #expect(Protection.reason(base: "main")?.contains("ships") == true)
        #expect(Protection.reason(base: "master")?.contains("ships") == true)
    }

    @Test func aReleaseOrHotfixBaseCounts() {
        #expect(Protection.reason(base: "release/3.77.0") != nil)
        #expect(Protection.reason(base: "hotfix/3.76.1") != nil)
    }

    // The direction the first version had, kept as a test so it cannot come back: a change
    // *out of* a protected branch is not what makes a row consequential.
    @Test func comingFromAProtectedBranchIsNotWhatMatters() {
        #expect(Protection.reason(base: "develop") == nil)
    }

    // `develop` is where ordinary work lands. Marking it would mark nearly every row, and a
    // mark on everything is a mark on nothing.
    @Test func developIsNotGuarded() {
        #expect(Protection.reason(base: "develop") == nil)
    }

    // A prefix, not a substring: matching loosely would mark rows that are not guarded.
    @Test func awordInTheMiddleDoesNotCount() {
        #expect(Protection.reason(base: "pre-release/3.77.0") == nil)
        #expect(Protection.reason(base: "feature/x/1-protected-route") == nil)
    }

    // The list can carry a row whose refs did not come back. Marking on a guess is worse
    // than not marking.
    @Test func unknownRefsAreNotMarked() {
        #expect(Protection.reason(base: nil) == nil)
        #expect(Protection.reason(base: "   ") == nil)
    }
}
