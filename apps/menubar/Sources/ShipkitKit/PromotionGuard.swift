/// Whether swapping the displayed request from `previous` to `next` (each
/// identified by `PendingRequest.id`) is a promotion the click guard must
/// arm for.
///
/// Lives here, not in `AppModel`, for the same reason `ApprovalQueue` does:
/// this is the one piece of "should the guard arm?" that has nothing to do
/// with SwiftUI or timing, so it can be tested directly rather than only
/// through a GUI nobody here can drive by hand.
///
/// A promotion is any change to a *different* request -- including one that
/// passes through displaying nothing at all on the way. That matters because
/// a decision that empties the queue and an arrival that immediately refills
/// it are two separate mutations (one in `AppModel.decide`, one in the
/// `ApprovalQueue.wait` callback inside `AppModel.show`), and SwiftUI can
/// coalesce both into a single render pass -- the person may never see the
/// panel actually go empty in between. Checking `nil -> next` on the second
/// mutation, in addition to `previous -> nil` on the first, is what catches
/// that case even though the view layer never shows it as two steps.
///
/// Two cases are deliberately excluded, both because nobody was ever placed
/// at risk of clicking through to something unseen:
/// - `nil` to `nil`: nothing was on screen and nothing arrived.
/// - the same id to itself: a second or third request arriving while the
///   current head is unchanged still triggers `ApprovalQueue`'s `onQueued`
///   callback, but redisplaying the request already on screen is not a
///   promotion -- the person is still looking at what they were looking at.
public func isPromotion(from previous: String?, to next: String?) -> Bool {
    next != previous
}
