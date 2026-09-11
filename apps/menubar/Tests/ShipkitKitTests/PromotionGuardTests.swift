import Testing
@testable import ShipkitKit

@Test func nothingDisplayedAndNothingArrivingIsNotAPromotion() {
    #expect(isPromotion(from: nil, to: nil) == false)
}

@Test func theSameRequestRedisplayedIsNotAPromotion() {
    // Mirrors a second or third arrival queuing behind an unchanged head:
    // `ApprovalQueue`'s `onQueued` fires again with the same id.
    #expect(isPromotion(from: "same", to: "same") == false)
}

@Test func aDifferentRequestReplacingTheCurrentOneIsAPromotion() {
    #expect(isPromotion(from: "first", to: "second") == true)
}

@Test func theQueueEmptyingIsAPromotion() {
    // `AppModel.decide` when nothing is left behind: the guard must still
    // arm even though nothing is displayed afterward, so it is already armed
    // if an arrival immediately follows.
    #expect(isPromotion(from: "first", to: nil) == true)
}

@Test func somethingArrivingWhereNothingWasDisplayedIsAPromotion() {
    // The other half of the queue-empties-and-refills window: the arrival
    // that lands on the nil left behind by a decision (or the very first
    // request the app ever shows).
    #expect(isPromotion(from: nil, to: "second") == true)
}
