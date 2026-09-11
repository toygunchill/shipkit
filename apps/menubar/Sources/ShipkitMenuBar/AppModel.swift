import Foundation
import ShipkitKit

/// Owns the listener and the requests waiting for a decision, if any.
///
/// A FIFO of pending requests rather than a single slot: a second request
/// arriving while one is on screen is not a situation the panel is asked to
/// pick a winner for, but it must not strand the first caller either — that
/// caller would otherwise wait until its own timeout with nobody able to
/// answer it, ever. The panel still shows one request at a time; a second
/// caller simply waits its turn instead of being silently denied.
@MainActor
final class AppModel: ObservableObject {
    @Published private(set) var pending: PendingRequest?
    @Published var tokenDraft: String = ""
    @Published private(set) var tokenSaved: Bool = false
    @Published private(set) var tokenError: String?
    @Published private(set) var listenerError: String?

    private let keychain = Keychain()
    private let journal = Journal()
    private var listener: Listener?
    private var queue: [(request: PendingRequest, continuation: (Decision) -> Void)] = []

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
        tokenSaved = (try? keychain.read(account: "jira")) != nil
    }

    /// Puts the request on screen and suspends until a button is pressed. If
    /// another request is already waiting, this one queues behind it rather
    /// than replacing it.
    private func show(_ request: PendingRequest) async -> Decision {
        await withCheckedContinuation { continuation in
            Task { @MainActor in
                self.queue.append((request, { decision in continuation.resume(returning: decision) }))
                if self.queue.count == 1 {
                    self.pending = request
                }
            }
        }
    }

    func decide(_ decision: Decision) {
        guard queue.isEmpty == false else { return }
        let head = queue.removeFirst()
        pending = queue.first?.request
        head.continuation(decision)
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
}
