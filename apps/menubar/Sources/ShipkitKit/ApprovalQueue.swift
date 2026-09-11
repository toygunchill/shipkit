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

    /// Resumes the head's continuation with `decision` and removes it,
    /// returning whatever is now at the head — `nil` once nobody is left
    /// waiting. Does nothing, rather than trapping, when the queue is
    /// already empty: there is nobody to have decided about.
    @discardableResult
    public func decide(_ decision: Decision) -> PendingRequest? {
        guard entries.isEmpty == false else { return nil }
        let head = entries.removeFirst()
        head.continuation(decision)
        return entries.first?.request
    }
}
