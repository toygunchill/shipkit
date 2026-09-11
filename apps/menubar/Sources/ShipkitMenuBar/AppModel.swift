import AppKit
import Foundation
import ShipkitKit

/// Owns the listener and the requests waiting for a decision, if any.
///
/// The ordering guarantee for overlapping requests lives in `ApprovalQueue`
/// (`ShipkitKit`), not here, so it can be tested. What is left here is thin
/// by design: enqueue, show whatever is now at the head, decide.
@MainActor
final class AppModel: ObservableObject {
    @Published private(set) var pending: PendingRequest?
    @Published private(set) var queuedBehind: Int = 0
    @Published private(set) var actionsEnabled: Bool = true
    @Published var tokenDraft: String = ""
    @Published private(set) var tokenSaved: Bool = false
    @Published private(set) var tokenError: String?
    @Published private(set) var listenerError: String?

    private let keychain = Keychain()
    private let journal = Journal()
    private let queue = ApprovalQueue()
    private var listener: Listener?
    private var reArmTask: Task<Void, Never>?

    /// How long the approve/deny buttons stay disabled right after a
    /// promotion swaps a new request into the panel. Defends against a
    /// doubled click, a trackpad tap that registers twice, or the pointer
    /// simply still resting on "Approve push" when the next request lands in
    /// the same panel at the same coordinates — any of which would otherwise
    /// approve a repository the person was never shown. Short enough that a
    /// deliberate, separate click after actually reading the new request is
    /// never held up by it.
    ///
    /// Derived from `NSEvent.doubleClickInterval` rather than a fixed guess,
    /// because the thing this guard defends against — the second click of a
    /// double-click — is itself governed by that same user-configurable
    /// setting (System Settings can slow it to roughly a second). A
    /// hardcoded 500ms guard lifts before the second click of a genuine slow
    /// double-click arrives, which approves whatever was just promoted into
    /// the panel — precisely the scenario this guard exists to prevent.
    /// Floored at `minimumPromotionGuardDuration` so an unusually fast
    /// setting can't shrink the guard away to something too brief to matter.
    private static var promotionGuardDuration: Duration {
        max(minimumPromotionGuardDuration, .seconds(NSEvent.doubleClickInterval))
    }

    /// Floor under `promotionGuardDuration`, equal to AppKit's own default
    /// double-click interval. A system left at its default gets exactly the
    /// guard this was originally tuned for; only a setting slower than
    /// default extends it further.
    private static let minimumPromotionGuardDuration: Duration = .milliseconds(500)

    init() {
        start()
    }

    private func start() {
        let keychain = self.keychain
        let listener = Listener(
            socketPath: Listener.defaultSocketPath(),
            journal: journal,
            present: { [weak self] request in
                await self?.show(request) ?? .denied
            },
            readSecret: { account in
                try? keychain.read(account: account)
            }
        )
        self.listener = listener
        Task { [weak self] in
            do {
                try await listener.start()
            } catch {
                await MainActor.run { self?.listenerError = "\(error)" }
            }
        }
        refreshTokenStatus()
    }

    /// Puts the request on screen and suspends until a button is pressed. If
    /// another request is already waiting, this one queues behind it rather
    /// than replacing it — `ApprovalQueue.wait` is what makes "behind it"
    /// mean arrival order rather than scheduling order.
    ///
    /// `onQueued` also fires when this arrival queues *behind* an unchanged
    /// head — `isPromotion` is what tells that apart from an actual swap, so
    /// an unrelated third request showing up doesn't needlessly re-arm the
    /// guard on a panel the person is already looking at. It is also what
    /// catches the case `decide` alone cannot: a decision that empties the
    /// queue (`pending` passes through `nil`) followed immediately by this
    /// callback refilling it, two separate mutations that SwiftUI's next
    /// render pass can coalesce into what looks like a single, unguarded
    /// swap.
    private func show(_ request: PendingRequest) async -> Decision {
        await queue.wait(for: request) { [weak self] head in
            guard let self else { return }
            if isPromotion(from: pending?.id, to: head.id) {
                armPromotionGuard()
            }
            pending = head
            queuedBehind = queue.waitingCount
        }
    }

    /// Applies `decision` to the head (and, per `ApprovalQueue.decide`, to
    /// every other queued entry asking the same question) and puts whatever
    /// is now at the head on screen.
    ///
    /// When that promotes a *different* request into the same panel — or
    /// empties it, per `isPromotion` — the buttons are briefly disabled:
    /// `ApprovalQueue`'s own guarantee is that a decision can only ever
    /// resolve the request actually at the head, so the risk here is not the
    /// queue misrouting a decision — it is a second physical click landing
    /// on the newly promoted panel before the person has read it.
    func decide(_ decision: Decision) {
        let previous = pending?.id
        let next = queue.decide(decision)
        pending = next
        queuedBehind = queue.waitingCount

        if isPromotion(from: previous, to: next?.id) {
            armPromotionGuard()
        }
    }

    /// Disables the approve/deny buttons and schedules them back on after
    /// `promotionGuardDuration`. Cancels and replaces any guard already in
    /// flight, so back-to-back promotions each get the full window measured
    /// from their own arrival rather than from whichever promotion happened
    /// first.
    private func armPromotionGuard() {
        actionsEnabled = false
        reArmTask?.cancel()
        reArmTask = Task { [weak self] in
            try? await Task.sleep(for: Self.promotionGuardDuration)
            guard Task.isCancelled == false else { return }
            self?.actionsEnabled = true
        }
    }

    func saveToken() {
        guard tokenDraft.isEmpty == false else { return }
        do {
            try keychain.write(tokenDraft, account: "jira")
            tokenDraft = ""
            tokenSaved = true
            tokenError = nil
        } catch {
            tokenError = "\(error)"
        }
    }

    func clearToken() {
        do {
            try keychain.delete(account: "jira")
            tokenSaved = false
            tokenError = nil
        } catch {
            tokenError = "\(error)"
        }
    }

    /// Re-reads whether a token is saved. `tokenSaved` is otherwise only
    /// touched by `saveToken`/`clearToken`, so anything that changes the
    /// keychain item from outside this process — Keychain Access, a second
    /// copy of this app — would leave the pane showing a stale answer
    /// forever. Called when the settings pane appears, not from within its
    /// `body`: a view's body is a description of the current state, not a
    /// place to go read one.
    func refreshTokenStatus() {
        tokenSaved = (try? keychain.read(account: "jira")) != nil
    }
}
