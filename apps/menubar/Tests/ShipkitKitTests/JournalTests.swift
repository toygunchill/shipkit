import Foundation
import Testing
@testable import ShipkitKit

/// A clock the test moves by hand.
private final class Clock: @unchecked Sendable {
    private var instant = Date(timeIntervalSince1970: 1_000_000)
    func now() -> Date { instant }
    func advance(_ seconds: TimeInterval) { instant = instant.addingTimeInterval(seconds) }
}

@Test func remembersADecisionForItsFingerprint() async {
    let journal = Journal()
    await journal.record(.approved, for: "abc")
    #expect(await journal.decision(for: "abc") == .approved)
}

@Test func knowsNothingAboutAnotherFingerprint() async {
    let journal = Journal()
    await journal.record(.approved, for: "abc")
    #expect(await journal.decision(for: "def") == nil)
}

@Test func forgetsAfterTheTimeToLive() async {
    let clock = Clock()
    let journal = Journal(ttl: 600, now: clock.now)
    await journal.record(.approved, for: "abc")

    clock.advance(599)
    #expect(await journal.decision(for: "abc") == .approved)

    clock.advance(2)
    #expect(await journal.decision(for: "abc") == nil)
}

// Hiding an expired entry from the reader while keeping it in memory is a slow
// leak in a process that runs for weeks.
@Test func expiryEvictsRatherThanHides() async {
    let clock = Clock()
    let journal = Journal(ttl: 600, now: clock.now)
    await journal.record(.approved, for: "abc")
    #expect(await journal.count() == 1)

    clock.advance(601)
    _ = await journal.decision(for: "abc")
    #expect(await journal.count() == 0)
}

@Test func remembersADenialTheSameWay() async {
    let journal = Journal()
    await journal.record(.denied, for: "abc")
    #expect(await journal.decision(for: "abc") == .denied)
}

// The later decision wins: a person who changes their mind within the window
// should not be overruled by what they said first.
@Test func aSecondDecisionReplacesTheFirst() async {
    let journal = Journal()
    await journal.record(.denied, for: "abc")
    await journal.record(.approved, for: "abc")
    #expect(await journal.decision(for: "abc") == .approved)
}

@Test func keepsDistinctFingerprintsApart() async {
    let journal = Journal()
    await journal.record(.approved, for: "a")
    await journal.record(.denied, for: "b")
    #expect(await journal.decision(for: "a") == .approved)
    #expect(await journal.decision(for: "b") == .denied)
    #expect(await journal.count() == 2)
}

// A decision that is never looked up again -- the ordinary case whenever an
// approval does not need to resume -- must not sit in memory forever. `record`
// has to sweep expired entries itself rather than waiting for a `decision`
// call that may never come.
@Test func recordSweepsExpiredEntriesEvenWhenNeverQueriedAgain() async {
    let clock = Clock()
    let journal = Journal(ttl: 600, now: clock.now)
    await journal.record(.approved, for: "a")
    await journal.record(.denied, for: "b")
    await journal.record(.approved, for: "c")
    #expect(await journal.count() == 3)

    clock.advance(601)
    await journal.record(.approved, for: "d")
    #expect(await journal.count() == 1)
    #expect(await journal.decision(for: "d") == .approved)
}
