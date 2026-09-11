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

@Test @MainActor func waitingCountReportsHowManyAreBehindTheHead() async {
    let queue = ApprovalQueue()
    #expect(queue.waitingCount == 0, "nobody waiting at all")

    let first = pendingRequest(fingerprint: "first")
    let second = pendingRequest(fingerprint: "second")
    let third = pendingRequest(fingerprint: "third")

    let firstTask = Task { await queue.wait(for: first) { _ in } }
    await Task.yield()
    #expect(queue.waitingCount == 0, "only the head itself is here")

    let secondTask = Task { await queue.wait(for: second) { _ in } }
    await Task.yield()
    #expect(queue.waitingCount == 1)

    let thirdTask = Task { await queue.wait(for: third) { _ in } }
    await Task.yield()
    #expect(queue.waitingCount == 2)

    queue.decide(.approved)
    #expect(queue.waitingCount == 1, "one fewer now that the head resolved")

    queue.decide(.approved)
    #expect(queue.waitingCount == 0)

    queue.decide(.approved)
    #expect(queue.waitingCount == 0, "still zero once nobody is left")

    _ = await (firstTask.value, secondTask.value, thirdTask.value)
}

/// The scenario the fix exists for: two connections carrying the identical
/// fingerprint both passed the journal check before either was presented
/// (see `Listener.decide`), so the person is shown one screen for what are,
/// by definition, the same question. Deciding the one that was actually
/// shown must settle its silent twin with the same answer rather than
/// leaving it to surface as a second, unexplained prompt.
@Test @MainActor func decidingTheHeadSettlesEveryMatchingFingerprintWithTheSameDecision() async {
    let queue = ApprovalQueue()
    let first = pendingRequest(fingerprint: "dup")
    let duplicate = pendingRequest(fingerprint: "dup")
    let other = pendingRequest(fingerprint: "other")

    let firstTask = Task { await queue.wait(for: first) { _ in } }
    await Task.yield()
    let duplicateTask = Task { await queue.wait(for: duplicate) { _ in } }
    await Task.yield()
    let otherTask = Task { await queue.wait(for: other) { _ in } }
    await Task.yield()

    let nextHead = queue.decide(.approved)

    #expect(nextHead?.id == "other", "the duplicate must not become the new head; it was already settled")
    #expect(queue.waitingCount == 0, "only the distinct request is left, and it is the head")

    #expect(await firstTask.value == .approved)
    #expect(await duplicateTask.value == .approved, "the duplicate never shown must still get the head's decision")

    queue.decide(.denied)
    #expect(await otherTask.value == .denied, "a genuinely different question is untouched by the first decision")
}

/// Duplicates and distinct requests interleaved, resolved across several
/// decisions. Every continuation must resume exactly once — a queue that
/// double-resumes one would trap the process (`decidingTwiceForOneWaiterResumesItOnlyOnce`
/// above already covers that failure mode) — and none may be stranded: if
/// any entry here were left without a matching removal, its `await` would
/// hang forever instead of returning a value.
@Test @MainActor func settlesDuplicatesAndDistinctRequestsInterleavedWithoutStrandingAnyContinuation() async {
    let queue = ApprovalQueue()
    let requestA1 = pendingRequest(fingerprint: "A")
    let requestB1 = pendingRequest(fingerprint: "B")
    let requestA2 = pendingRequest(fingerprint: "A") // duplicate of A1
    let requestC = pendingRequest(fingerprint: "C")
    let requestB2 = pendingRequest(fingerprint: "B") // duplicate of B1

    // Queue order: A1, B1, A2(dup), C, B2(dup)
    let taskA1 = Task { await queue.wait(for: requestA1) { _ in } }
    await Task.yield()
    let taskB1 = Task { await queue.wait(for: requestB1) { _ in } }
    await Task.yield()
    let taskA2 = Task { await queue.wait(for: requestA2) { _ in } }
    await Task.yield()
    let taskC = Task { await queue.wait(for: requestC) { _ in } }
    await Task.yield()
    let taskB2 = Task { await queue.wait(for: requestB2) { _ in } }
    await Task.yield()

    // Decide A: settles A1 (head) and A2 (queued duplicate). B1, C, B2 remain,
    // in their original relative order.
    var nextHead = queue.decide(.approved)
    #expect(nextHead?.id == "B", "B1 is now the head; C and B2 are still behind it")
    #expect(queue.waitingCount == 2)

    // Decide B: settles B1 (head) and B2 (queued duplicate). Only C remains.
    nextHead = queue.decide(.denied)
    #expect(nextHead?.id == "C")
    #expect(queue.waitingCount == 0)

    // Decide C: the last one standing.
    nextHead = queue.decide(.approved)
    #expect(nextHead == nil, "nobody is left waiting")
    #expect(queue.decide(.denied) == nil, "still nobody, and this must not trap")

    #expect(await taskA1.value == .approved)
    #expect(await taskA2.value == .approved)
    #expect(await taskB1.value == .denied)
    #expect(await taskB2.value == .denied)
    #expect(await taskC.value == .approved)
}
