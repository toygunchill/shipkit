import Foundation

/// Whether an agent is there to be handed work.
///
/// The menu bar cannot produce a review. It has no agent in it, and MCP is
/// request/response — a server cannot hand work to an agent that did not ask
/// for it. That is a property of the protocol, not something to engineer
/// around, and a button that pretended otherwise would silently do nothing.
///
/// What the application *can* know is whether an agent exists. The
/// `shipkit mcp` process runs as a child of the agent for exactly as long as
/// the agent does, so it opens a connection, says what it is, and holds the
/// connection open. Presence is that connection being alive — a fact, not a
/// guess, and one that needs no heartbeat because the kernel reports a
/// vanished peer as end-of-file.
public actor AgentPresence {
    /// One attached agent, as much of it as is worth remembering.
    public struct Attached: Sendable, Equatable {
        /// Distinguishes two agents on one machine. The connection's own identity.
        public let id: Int32
        /// What the agent called itself, for the menu to name it. May be empty.
        public let name: String
        public let since: Date

        public init(id: Int32, name: String, since: Date) {
            self.id = id
            self.name = name
            self.since = since
        }
    }

    private var attached: [Int32: Attached] = [:]

    public init() {}

    /// Records an agent as present. Replacing an id rather than refusing it:
    /// a file descriptor is reused after it closes, and a stale entry under a
    /// number the kernel has since handed out again would claim an agent that
    /// is gone.
    public func attach(id: Int32, name: String, now: Date = Date()) {
        attached[id] = Attached(id: id, name: name, since: now)
    }

    /// Records an agent as gone. Called when its connection ends, however it ended.
    public func detach(id: Int32) {
        attached.removeValue(forKey: id)
    }

    public var isAttached: Bool {
        !attached.isEmpty
    }

    public var count: Int {
        attached.count
    }

    /// Attached agents, oldest first, so the menu's order does not shuffle.
    public var agents: [Attached] {
        attached.values.sorted { left, right in
            left.since == right.since ? left.id < right.id : left.since < right.since
        }
    }
}
