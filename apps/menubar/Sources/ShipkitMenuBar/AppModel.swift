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

    /// The last answer a refresh produced, or `nil` before the first one has
    /// finished. `nil` and `.undetermined` are drawn the same way — an em dash
    /// — but they are not the same thing, and conflating them would mean the
    /// panel could not tell "not asked yet" from "asked and could not find
    /// out".
    @Published private(set) var inbox: InboxOutcome?
    /// True while a refresh is in flight. The previous answer stays on screen
    /// dimmed rather than blanking: a number that disappears and comes back
    /// every five minutes is harder to read than one that fades.
    @Published private(set) var inboxRefreshing: Bool = false
    private var inboxLastCompleted: Date?

    private let keychain = Keychain()
    private let journal = Journal()
    private let queue = ApprovalQueue()
    private let pullRequests = PullRequestInbox.live()
    private var listener: Listener?
    private var reArmTask: Task<Void, Never>?
    private var inboxTask: Task<Void, Never>?
    private var inboxTimer: Task<Void, Never>?

    /// How often the inbox re-asks while the panel is open. Long enough that
    /// leaving the panel up is not a stream of `gh` processes, short enough
    /// that a review request arriving while it is open is noticed without a
    /// click. The refresh on appearance is what covers the common case; this
    /// only covers a panel left open.
    private static let inboxRefreshInterval: Duration = .seconds(300)

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
        // NOT refreshTokenStatus() here: it reads the keychain synchronously,
        // and under ad-hoc signing every rebuild makes that read block on a
        // SecurityAgent prompt -- on the main thread, at launch, before the
        // listener exists. The pane refreshes it on appear instead, where a
        // person is looking at the dialog they are being asked to answer.
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

    /// Called when the inbox becomes visible: refresh once, then keep a timer
    /// running for as long as it stays visible. The timer is cancelled on
    /// disappearance rather than left running, because every tick is two
    /// processes spawned to answer a question nobody is looking at.
    func inboxAppeared() {
        refreshInbox()
        inboxTimer?.cancel()
        inboxTimer = Task { [weak self] in
            while Task.isCancelled == false {
                try? await Task.sleep(for: Self.inboxRefreshInterval)
                guard Task.isCancelled == false else { return }
                self?.refreshInbox()
            }
        }
    }

    func inboxDisappeared() {
        inboxTimer?.cancel()
        inboxTimer = nil
    }

    /// Asks `gh` again. A second call while one is already in flight is
    /// ignored rather than queued: the manual refresh control and the timer
    /// can land together, and two overlapping refreshes would race to publish
    /// two answers to the same question.
    func refreshInbox(ignoringInterval: Bool = false) {
        guard inboxRefreshing == false else { return }
        // Also spaced against the last *completed* refresh, not only against
        // overlap: hopping inbox -> list -> inbox re-fires onAppear, and
        // without this each hop is a fresh pair of gh spawns. Fifteen seconds
        // is far under the five-minute cadence and far over a navigation.
        // The manual refresh control passes `ignoringInterval` -- a person
        // asking again explicitly is not a navigation echo.
        if !ignoringInterval, let done = inboxLastCompleted, Date().timeIntervalSince(done) < 15 {
            return
        }
        inboxRefreshing = true
        let source = pullRequests
        inboxTask = Task { [weak self] in
            let outcome = await source.load()
            guard Task.isCancelled == false else { return }
            // Replaced wholesale, including when the answer is `undetermined`:
            // keeping the previous numbers on a failed refresh would present
            // stale counts as current ones, which is the one thing this inbox
            // must never do.
            self?.inbox = outcome
            self?.inboxRefreshing = false
            self?.inboxLastCompleted = Date()
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
        // The read happens here and nowhere else -- launch must never touch
        // the keychain, because under ad-hoc signing every rebuild makes
        // `SecItemCopyMatching` block on a SecurityAgent prompt. Here a person
        // is looking at the pane the prompt belongs to. But it still cannot
        // run on the main actor: the same prompt would freeze the whole app
        // behind a dialog, which is the launch bug relocated, not fixed.
        //
        // (A review caught the previous version of this function setting
        // `tokenSaved = false` unconditionally -- the pane always said
        // "Not set" and the delete button became unreachable. The comment
        // above had deferred to a function that no longer read anything.)
        let keychain = self.keychain
        Task.detached {
            let saved = (try? keychain.read(account: "jira")) != nil
            await MainActor.run { self.tokenSaved = saved }
        }
    }
}
