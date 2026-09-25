import Foundation
import Testing
@testable import ShipkitKit

/// A socket path short enough for `sockaddr_un.sun_path` — see ListenerTests for
/// why the system temporary directory will not do.
private func scratchSocket() -> String {
    var template: [CChar] = Array("/tmp/shipkit-attach-XXXXXX".utf8CString)
    let directory: String = template.withUnsafeMutableBufferPointer { buffer in
        guard let base = buffer.baseAddress, mkdtemp(base) != nil else {
            fatalError("mkdtemp failed: \(String(cString: strerror(errno)))")
        }
        return String(cString: base)
    }
    return directory + "/approvals.sock"
}

/// Opens a connection and leaves it open, as `shipkit mcp` does. The caller
/// closes it to simulate the agent going away.
private func openAttachment(to path: String, name: String) -> Int32 {
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    let capacity = MemoryLayout.size(ofValue: address.sun_path)
    _ = withUnsafeMutablePointer(to: &address.sun_path) { pointer in
        path.withCString { source in
            strncpy(UnsafeMutableRawPointer(pointer).assumingMemoryBound(to: CChar.self), source, capacity - 1)
        }
    }
    let size = socklen_t(MemoryLayout<sockaddr_un>.size)
    let connected = withUnsafePointer(to: &address) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, size) }
    }
    #expect(connected == 0)

    let line = "{\"kind\":\"attach\",\"name\":\"\(name)\"}\n"
    _ = line.withCString { send(fd, $0, strlen($0), 0) }

    // The acknowledgement, so the test waits for the attach to have been recorded
    // rather than racing it.
    var buffer = [UInt8](repeating: 0, count: 256)
    let read = recv(fd, &buffer, buffer.count, 0)
    #expect(read > 0)
    return fd
}

private func settle() async {
    try? await Task.sleep(nanoseconds: 300_000_000)
}

@Suite("An agent attaching to the menu bar")
struct AttachTests {
    private func listener(at path: String) -> Listener {
        Listener(socketPath: path, journal: Journal(), present: { _ in .denied }, readSecret: { _ in nil })
    }

    @Test func anAgentHoldingAConnectionIsSeenAsAttached() async throws {
        let path = scratchSocket()
        let subject = listener(at: path)
        try await subject.start()
        defer { try? FileManager.default.removeItem(atPath: (path as NSString).deletingLastPathComponent) }

        let fd = openAttachment(to: path, name: "claude")
        defer { close(fd) }
        await settle()

        #expect(await subject.presence.isAttached)
        #expect(await subject.presence.agents.first?.name == "claude")
    }

    // The whole mechanism. Nothing is polled and no heartbeat is exchanged: a
    // vanished peer arrives as end-of-file, and that is what detaches it. An
    // entry left behind would tell the menu bar an agent is there and make its
    // button do nothing.
    @Test func closingTheConnectionDetachesTheAgent() async throws {
        let path = scratchSocket()
        let subject = listener(at: path)
        try await subject.start()
        defer { try? FileManager.default.removeItem(atPath: (path as NSString).deletingLastPathComponent) }

        let fd = openAttachment(to: path, name: "claude")
        await settle()
        #expect(await subject.presence.isAttached)

        close(fd)
        await settle()

        #expect(await subject.presence.isAttached == false)
    }

    @Test func twoAgentsAttachIndependently() async throws {
        let path = scratchSocket()
        let subject = listener(at: path)
        try await subject.start()
        defer { try? FileManager.default.removeItem(atPath: (path as NSString).deletingLastPathComponent) }

        let first = openAttachment(to: path, name: "claude")
        let second = openAttachment(to: path, name: "codex")
        defer { close(second) }
        await settle()
        #expect(await subject.presence.count == 2)

        close(first)
        await settle()

        #expect(await subject.presence.count == 1)
        #expect(await subject.presence.agents.first?.name == "codex")
    }

    // An attach must not be mistaken for an approval request. Before the `kind`
    // check routed it away, any line reaching the approval path was presented to
    // a person as something to decide.
    @Test func anAttachIsNeverPresentedAsAnApproval() async throws {
        let path = scratchSocket()
        let presented = OSAllocatedUnfairLockBox(false)
        let subject = Listener(
            socketPath: path,
            journal: Journal(),
            present: { _ in presented.set(true); return .denied },
            readSecret: { _ in nil }
        )
        try await subject.start()
        defer { try? FileManager.default.removeItem(atPath: (path as NSString).deletingLastPathComponent) }

        let fd = openAttachment(to: path, name: "claude")
        defer { close(fd) }
        await settle()

        #expect(presented.get() == false)
    }
}

/// A `Sendable` box, so the presenter above can record that it ran.
private final class OSAllocatedUnfairLockBox: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Bool

    init(_ value: Bool) { self.value = value }

    func set(_ new: Bool) {
        lock.lock()
        defer { lock.unlock() }
        value = new
    }

    func get() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return value
    }
}
