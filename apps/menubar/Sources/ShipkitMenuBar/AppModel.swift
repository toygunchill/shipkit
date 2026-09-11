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
    private static let promotionGuardDuration: Duration = .milliseconds(500)

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
    private func show(_ request: PendingRequest) async -> Decision {
        await queue.wait(for: request) { [weak self] head in
            self?.pending = head
            self?.queuedBehind = self?.queue.waitingCount ?? 0
        }
    }

    /// Applies `decision` to the head (and, per `ApprovalQueue.decide`, to
    /// every other queued entry asking the same question) and puts whatever
    /// is now at the head on screen.
    ///
    /// When that promotes a *different* request into the same panel, the
    /// buttons are briefly disabled: `ApprovalQueue`'s own guarantee is that
    /// a decision can only ever resolve the request actually at the head, so
    /// the risk here is not the queue misrouting a decision — it is a second
    /// physical click landing on the newly promoted panel before the person
    /// has read it.
    func decide(_ decision: Decision) {
        let previous = pending?.id
        let next = queue.decide(decision)
        pending = next
        queuedBehind = queue.waitingCount

        guard let next, next.id != previous else { return }
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
