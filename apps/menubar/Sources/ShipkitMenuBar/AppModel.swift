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
    @Published var tokenDraft: String = ""
    @Published private(set) var tokenSaved: Bool = false
    @Published private(set) var tokenError: String?
    @Published private(set) var listenerError: String?

    private let keychain = Keychain()
    private let journal = Journal()
    private let queue = ApprovalQueue()
    private var listener: Listener?

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
        }
    }

    func decide(_ decision: Decision) {
        pending = queue.decide(decision)
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
