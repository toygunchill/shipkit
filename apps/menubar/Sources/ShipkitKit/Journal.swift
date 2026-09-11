import Foundation

/// One decision per fingerprint, for ten minutes.
///
/// Its only purpose is to let a timed-out call resume: the agent calls again
/// with the same situation and finds the answer waiting. Keyed by fingerprint
/// rather than by a request id, so a resumed call is satisfied only by a
/// decision made about the identical situation — and two agents racing on the
/// same branch cannot pick up each other's answers unless the situation is
/// genuinely identical, in which case they should.
///
/// This is not a memory of preference. There is no "approve all", no
/// per-repository trust, and nothing outlives the window.
public actor Journal {
    private struct Entry {
        let decision: Decision
        let recorded: Date
    }

    private var entries: [String: Entry] = [:]
    private let ttl: TimeInterval
    private let now: @Sendable () -> Date

    public init(ttl: TimeInterval = 600, now: @escaping @Sendable () -> Date = Date.init) {
        self.ttl = ttl
        self.now = now
    }

    public func record(_ decision: Decision, for fingerprint: String) {
        entries[fingerprint] = Entry(decision: decision, recorded: now())
    }

    public func decision(for fingerprint: String) -> Decision? {
        guard let entry = entries[fingerprint] else { return nil }
        if now().timeIntervalSince(entry.recorded) > ttl {
            // Evict rather than hide: this process runs for weeks.
            entries.removeValue(forKey: fingerprint)
            return nil
        }
        return entry.decision
    }

    public func count() -> Int {
        entries.count
    }
}
