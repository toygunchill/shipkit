import Foundation
import Testing
@testable import ShipkitKit

private func pendingRequest(fingerprint: String) -> PendingRequest {
    let json = """
    {"protocol":1,"fingerprint":"\(fingerprint)","repo":"/r","branch":"b","base":"d",\
    "head":"c","title":"t","commitMessage":"m","diffstat":"1 file","warnings":[]}
    """
    let request = try! decodeRequest(Data(json.utf8))
    return PendingRequest(request: request)
}

@Test @MainActor func decidingWithNobodyWaitingDoesNothing() {
    let queue = ApprovalQueue()
    // Must not trap. There is no waiter to have an opinion about.
    queue.decide(.approved)
}

@Test @MainActor func aSecondWaiterQueuesBehindTheFirstRatherThanBecomingTheHead() async {
    let queue = ApprovalQueue()
    let first = pendingRequest(fingerprint: "first")
    let second = pendingRequest(fingerprint: "second")

    var headAfterFirst: String?
    var headAfterSecond: String?

    let firstTask = Task { await queue.wait(for: first) { headAfterFirst = $0.id } }
    // `wait`'s synchronous prefix -- the append and the `onQueued` call --
    // has already run by the time its only suspension point is reached.
    // Yielding here hands control to that task until it hits that
    // suspension, then returns it to this one; nothing else is runnable in
    // between, so there is nothing for the scheduler to reorder.
    await Task.yield()

    let secondTask = Task { await queue.wait(for: second) { headAfterSecond = $0.id } }
    await Task.yield()

    #expect(headAfterFirst == "first")
    #expect(headAfterSecond == "first", "the second request must not jump ahead of the first")

    queue.decide(.approved)
    queue.decide(.denied)

    #expect(await firstTask.value == .approved)
    #expect(await secondTask.value == .denied)
}

@Test @MainActor func decidingTwiceForOneWaiterResumesItOnlyOnce() async {
    let queue = ApprovalQueue()
    let only = pendingRequest(fingerprint: "only")

    let task = Task { await queue.wait(for: only) { _ in } }
    await Task.yield()

    queue.decide(.approved)
    // The queue is empty now. If `decide` failed to remove the head before
    // resuming it, this second call would resume the same continuation
    // twice -- a Swift runtime trap ("SWIFT TASK CONTINUATION MISUSE"), not
    // merely a wrong value -- rather than the no-op this asserts.
    queue.decide(.denied)

    #expect(await task.value == .approved)
}

@Test @MainActor func promotesTheNextWaiterAfterDeciding() async {
    let queue = ApprovalQueue()
    let first = pendingRequest(fingerprint: "first")
    let second = pendingRequest(fingerprint: "second")

    let firstTask = Task { await queue.wait(for: first) { _ in } }
    await Task.yield()
    let secondTask = Task { await queue.wait(for: second) { _ in } }
    await Task.yield()

    let nextHead = queue.decide(.approved)
    #expect(nextHead?.id == "second")
    #expect(queue.decide(.denied) == nil, "nobody is left waiting")

    #expect(await firstTask.value == .approved)
    #expect(await secondTask.value == .denied)
}
