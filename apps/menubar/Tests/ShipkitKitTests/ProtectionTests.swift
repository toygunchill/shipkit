import Foundation
import Testing
@testable import ShipkitKit

/// Every pair below is a real row from the list this was built for. The direction took two
/// wrong turns to settle, so both wrong answers are kept as cases: marking by base looked
/// right because `feature/… → protected/…` is the most common shape in the list, and it is
/// exactly the shape that must *not* be marked.
@Suite("Marking the pull requests that merge a shared branch")
struct ProtectionTests {
    // `protected/flyhigh/20104-brand-identity → develop`
    @Test func mergingAProtectedBranchIsMarked() {
        let reason = Protection.reason(head: "protected/flyhigh/20104-brand-identity", base: "develop")

        #expect(reason?.contains("protected/flyhigh/20104-brand-identity") == true)
        #expect(reason?.contains("develop") == true)
    }

    // `release/3.77.0 → main`
    @Test func mergingAReleaseBranchIsMarked() {
        #expect(Protection.reason(head: "release/3.77.0", base: "main") != nil)
    }

    @Test func mergingAHotfixBranchIsMarked() {
        #expect(Protection.reason(head: "hotfix/3.76.1", base: "main") != nil)
    }

    // The wrong answer the second version gave. These are people adding work *to* a shared
    // branch, which is routine — marking them marked half the list.
    @Test func addingWorkToAProtectedBranchIsNotMarked() {
        #expect(Protection.reason(head: "feature/skystones/20104-brand-develop",
                                  base: "protected/flyhigh/20104-brand-identity") == nil)
        #expect(Protection.reason(head: "feature/pegachu/20104-baggage",
                                  base: "protected/flyhigh/20104-brand-identity") == nil)
    }

    @Test func anOrdinaryFeatureBranchIsNotMarked() {
        #expect(Protection.reason(head: "livebug/skystones/32516-inapp-extra-crash", base: "develop") == nil)
        #expect(Protection.reason(head: "bugfix/moneypoly/34663-campaign-radio-brand", base: "develop") == nil)
    }

    // A prefix, not a substring: matching loosely would mark rows that are not shared.
    @Test func awordInTheMiddleDoesNotCount() {
        #expect(Protection.reason(head: "feature/x/1-protected-route", base: "develop") == nil)
        #expect(Protection.reason(head: "pre-release/3.77.0", base: "main") == nil)
    }

    // The base is for the sentence, not the decision.
    @Test func itStillSaysSomethingWithNoBase() {
        #expect(Protection.reason(head: "protected/x/1-y")?.contains("shared branch") == true)
    }

    // A row whose refs did not come back is not marked: a shield on a guess is worse than
    // no shield.
    @Test func unknownRefsAreNotMarked() {
        #expect(Protection.reason(head: nil, base: "develop") == nil)
        #expect(Protection.reason(head: "   ", base: "develop") == nil)
    }
}
