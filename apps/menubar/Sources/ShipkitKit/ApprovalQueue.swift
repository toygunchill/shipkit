import Foundation

/// The FIFO of requests waiting on a decision, and the promise each one made
/// its caller.
///
/// Lives here, not in the menu-bar target's `AppModel`, so its one real
/// property — that two overlapping requests are answered in the order they
/// arrived, not in whatever order a scheduler later gets around to running
/// something — can be tested directly. `AppModel` is a SwiftUI-adjacent type
/// this package does not unit test, and the GUI path that would otherwise be
/// the only way to exercise two overlapping requests is not something every
/// environment can drive by hand.
///
/// `@MainActor`, matching its one real caller (`AppModel`) rather than
/// carrying its own locking: adding thread safety here would be solving a
/// problem this type does not have, and would also be solving it twice, since
/// `AppModel` is already confined to the main actor.
@MainActor
public final class ApprovalQueue {
    private var entries: [(request: PendingRequest, continuation: (Decision) -> Void)] = []

    public init() {}

    /// Suspends until a decision is made for `request`. A second call while
    /// one is already waiting queues behind it — first call in, first
    /// continuation resumed.
    ///
    /// "First call in" is real, not incidental: the entry is appended, and
    /// `onQueued` told what is now at the head, synchronously and before this
    /// function's only suspension point. Two overlapping calls therefore land
    /// in the queue in the order they were actually made, because nothing
    /// here defers that work to a separately scheduled job that could run in
    /// either order.
    public func wait(for request: PendingRequest, onQueued: (PendingRequest) -> Void) async -> Decision {
        await withCheckedContinuation { continuation in
            entries.append((request, { decision in continuation.resume(returning: decision) }))
            onQueued(entries[0].request)
        }
    }

    /// How many requests are behind the head, still waiting their turn.
    /// Zero once the head is the only one left, or once nobody is waiting at
    /// all. Reported to the person before they decide: knowing another
    /// request is already queued behind the one on screen changes how
    /// carefully they read it.
    public var waitingCount: Int {
        max(0, entries.count - 1)
    }

    /// Resumes the head's continuation with `decision` and removes it, then
    /// does the same for every *other* queued entry sharing the head's
    /// fingerprint, removing them too.
    ///
    /// A fingerprint is the identity of the question (see `PendingRequest.id`):
    /// two connections carrying the same one both passed the journal check
    /// before either was presented, so they are the same question asked
    /// twice, not two questions. Answering the head answers them as well —
    /// none of them was ever shown to the person, and none of them should
    /// wait for a second answer to a question that has already been
    /// answered.
    ///
    /// Returns whatever is now at the head — `nil` once nobody is left
    /// waiting. Does nothing, rather than trapping, when the queue is
    /// already empty: there is nobody to have decided about.
    @discardableResult
    public func decide(_ decision: Decision) -> PendingRequest? {
        guard entries.isEmpty == false else { return nil }
        let head = entries.removeFirst()
        head.continuation(decision)

        // Removing while iterating forward would skip the entry right after
        // whichever one was just removed; walking backward keeps every
        // not-yet-visited index stable across a removal.
        for index in stride(from: entries.count - 1, through: 0, by: -1) {
            if entries[index].request.id == head.request.id {
                entries.remove(at: index).continuation(decision)
            }
        }

        return entries.first?.request
    }
}
