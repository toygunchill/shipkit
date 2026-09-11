import Foundation
import os
import Testing
@testable import ShipkitKit

/// A fresh directory under `/tmp`, `mkdtemp`-style, holding one socket.
///
/// Measured, not assumed: `FileManager.default.temporaryDirectory` resolves to
/// a long per-session path under `/var/folders/.../T` on this machine — with a
/// UUID and `approvals.sock` appended, that overflows `sockaddr_un.sun_path`'s
/// 104-byte capacity (`bind` fails with "socket path is too long" before a
/// single test runs). `/tmp` plus a short `mkdtemp` suffix stays well under
/// that limit and mirrors Node's `mkdtempSync`.
private func scratchSocket() -> String {
    var template: [CChar] = Array("/tmp/shipkit-listener-XXXXXX".utf8CString)
    let directory: String = template.withUnsafeMutableBufferPointer { buffer in
        guard let base = buffer.baseAddress, mkdtemp(base) != nil else {
            fatalError("mkdtemp failed: \(String(cString: strerror(errno)))")
        }
        return String(cString: base)
    }
    return directory + "/approvals.sock"
}

/// The directory `scratchSocket()` created, recursively — the socket file
/// included, whether or not the listener has removed it yet.
private func removeScratchDirectory(for socketPath: String) {
    try? FileManager.default.removeItem(atPath: (socketPath as NSString).deletingLastPathComponent)
}

/// Connects, sends one line, reads one line. The Node client in miniature.
private func ask(_ path: String, _ line: String) throws -> String {
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    #expect(fd >= 0)
    defer { close(fd) }

    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    // Hoisted out of the closure: computing this while `&address.sun_path` is
    // exclusively borrowed below is an overlapping access, not just a style
    // choice — the compiler refuses it.
    let capacity = MemoryLayout.size(ofValue: address.sun_path)
    _ = withUnsafeMutablePointer(to: &address.sun_path) { pointer in
        path.withCString { source in
            strncpy(UnsafeMutableRawPointer(pointer).assumingMemoryBound(to: CChar.self),
                    source, capacity - 1)
        }
    }
    let size = socklen_t(MemoryLayout<sockaddr_un>.size)
    let connected = withUnsafePointer(to: &address) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, size) }
    }
    #expect(connected == 0)

    _ = line.withCString { send(fd, $0, strlen($0), 0) }

    var buffer = [UInt8](repeating: 0, count: 4096)
    let read = recv(fd, &buffer, buffer.count, 0)
    #expect(read > 0)
    return String(decoding: buffer[0..<max(read, 0)], as: UTF8.self)
}

private func requestLine(fingerprintOverride: String? = nil) -> String {
    let situation = Situation(
        repo: "/r", branch: "b", base: "d", head: "c",
        title: "t", commitMessage: "m",
        warnings: [Warning(check: "blocking-label", message: "in test")]
    )
    let fp = fingerprintOverride ?? fingerprint(situation)
    return """
    {"protocol":1,"fingerprint":"\(fp)","repo":"/r","branch":"b","base":"d",\
    "head":"c","title":"t","commitMessage":"m","diffstat":"1 file",\
    "warnings":[{"check":"blocking-label","message":"in test"}]}
    """
}

private func noSecret(socketPath: String, journal: Journal = Journal(), present: @escaping @Sendable (PendingRequest) async -> Decision) -> Listener {
    Listener(socketPath: socketPath, journal: journal, present: present) { _ in nil }
}

/// `present` runs on `Listener.serve`'s Task, off whatever thread the test body
/// runs on — and `readSecret` is a plain synchronous closure, so it cannot
/// `await` an actor either way. A bare `var asked = false` mutated from either
/// closure is a real data race the compiler is right to refuse under Swift 6
/// strict concurrency, not merely a style complaint. `OSAllocatedUnfairLock`
/// is the platform's audited primitive for exactly this — synchronous,
/// Sendable, shared mutable state — rather than an unchecked escape hatch
/// written by hand.
private final class SyncBox<Value: Sendable>: Sendable {
    private let lock: OSAllocatedUnfairLock<Value>

    init(_ initial: Value) {
        lock = OSAllocatedUnfairLock(initialState: initial)
    }

    func set(_ value: Value) {
        lock.withLock { $0 = value }
    }

    var value: Value {
        lock.withLock { $0 }
    }
}

@Test func chmodsTheSocketTo0600AfterBinding() async throws {
    let path = scratchSocket()
    defer { removeScratchDirectory(for: path) }
    let listener = noSecret(socketPath: path) { _ in .denied }
    try await listener.start()
    defer { Task { await listener.stop() } }

    let attributes = try FileManager.default.attributesOfItem(atPath: path)
    let mode = (attributes[.posixPermissions] as? NSNumber)?.intValue
    // A freshly bound socket is 0755 — bind honours the umask — so this only
    // passes if something chmods it afterwards.
    #expect(mode == 0o600)
}

@Test func answersWithTheDecisionThePresenterReturns() async throws {
    let path = scratchSocket()
    defer { removeScratchDirectory(for: path) }
    let listener = noSecret(socketPath: path) { _ in .approved }
    try await listener.start()
    defer { Task { await listener.stop() } }

    let reply = try ask(path, requestLine() + "\n")
    #expect(reply.contains("\"decision\":\"approved\""))
    #expect(reply.hasSuffix("\n"))
}

// The check that makes the facts on screen provably the facts that were hashed.
@Test func refusesARequestWhoseFingerprintDoesNotMatchItsFields() async throws {
    let path = scratchSocket()
    defer { removeScratchDirectory(for: path) }
    let asked = SyncBox(false)
    let listener = noSecret(socketPath: path) { _ in
        asked.set(true)
        return .approved
    }
    try await listener.start()
    defer { Task { await listener.stop() } }

    let reply = try ask(path, requestLine(fingerprintOverride: String(repeating: "a", count: 64)) + "\n")
    #expect(reply.contains("\"decision\":\"denied\""))
    #expect(asked.value == false)
}

@Test func answersFromTheJournalWithoutAskingAgain() async throws {
    let path = scratchSocket()
    defer { removeScratchDirectory(for: path) }
    let journal = Journal()
    let situation = Situation(
        repo: "/r", branch: "b", base: "d", head: "c", title: "t", commitMessage: "m",
        warnings: [Warning(check: "blocking-label", message: "in test")]
    )
    await journal.record(.approved, for: fingerprint(situation))

    let asked = SyncBox(false)
    let listener = noSecret(socketPath: path, journal: journal) { _ in
        asked.set(true)
        return .denied
    }
    try await listener.start()
    defer { Task { await listener.stop() } }

    let reply = try ask(path, requestLine() + "\n")
    #expect(reply.contains("\"decision\":\"approved\""))
    #expect(asked.value == false)
}

@Test func recordsTheDecisionItObtained() async throws {
    let path = scratchSocket()
    defer { removeScratchDirectory(for: path) }
    let journal = Journal()
    let listener = noSecret(socketPath: path, journal: journal) { _ in .denied }
    try await listener.start()
    defer { Task { await listener.stop() } }

    _ = try ask(path, requestLine() + "\n")

    let situation = Situation(
        repo: "/r", branch: "b", base: "d", head: "c", title: "t", commitMessage: "m",
        warnings: [Warning(check: "blocking-label", message: "in test")]
    )
    #expect(await journal.decision(for: fingerprint(situation)) == .denied)
}

// An application that crashed leaves a socket file behind. Refusing to start
// until someone deletes it by hand is a worse failure than the crash.
@Test func replacesAStaleSocketFile() async throws {
    let path = scratchSocket()
    defer { removeScratchDirectory(for: path) }
    FileManager.default.createFile(atPath: path, contents: Data())

    let listener = noSecret(socketPath: path) { _ in .approved }
    // do/catch rather than #expect(throws: Never.self): the expectation macro's
    // async throwing form is easy to get subtly wrong, and a test that fails to
    // compile teaches nothing.
    do {
        try await listener.start()
    } catch {
        Issue.record("start() threw on a stale socket file: \(error)")
    }
    await listener.stop()
}

@Test func refusesAnUnparseableLineWithoutAsking() async throws {
    let path = scratchSocket()
    defer { removeScratchDirectory(for: path) }
    let asked = SyncBox(false)
    let listener = noSecret(socketPath: path) { _ in
        asked.set(true)
        return .approved
    }
    try await listener.start()
    defer { Task { await listener.stop() } }

    let reply = try ask(path, "{\n")
    #expect(reply.contains("\"decision\":\"denied\"") || reply.isEmpty == false)
    #expect(asked.value == false)
}

// The Jira token travels over the same socket, as a second kind of request —
// distinguished from an approval request by the presence of `kind`, because an
// application-written keychain item cannot be read back by `/usr/bin/security`.
@Test func answersATokenRequestWithTheSecretReadSecretReturns() async throws {
    let path = scratchSocket()
    defer { removeScratchDirectory(for: path) }
    let askedFor = SyncBox<String?>(nil)
    let listener = Listener(socketPath: path, journal: Journal(), present: { _ in .denied }) { account in
        askedFor.set(account)
        return "s3cr3t"
    }
    try await listener.start()
    defer { Task { await listener.stop() } }

    let reply = try ask(path, "{\"protocol\":1,\"kind\":\"token\",\"account\":\"jira\"}\n")
    #expect(reply.contains("\"secret\":\"s3cr3t\""))
    #expect(reply.contains("\"kind\":\"token\""))
    #expect(askedFor.value == "jira")
}

@Test func answersATokenRequestWithNullWhenThereIsNone() async throws {
    let path = scratchSocket()
    defer { removeScratchDirectory(for: path) }
    let listener = noSecret(socketPath: path) { _ in .denied }
    try await listener.start()
    defer { Task { await listener.stop() } }

    let reply = try ask(path, "{\"protocol\":1,\"kind\":\"token\",\"account\":\"jira\"}\n")
    #expect(reply.contains("\"secret\":null"))
}

// A token request never reaches the presenter or the journal — it is not a
// decision, and nothing about it should be journalled as one.
@Test func aTokenRequestNeverAsksThePresenter() async throws {
    let path = scratchSocket()
    defer { removeScratchDirectory(for: path) }
    let asked = SyncBox(false)
    let listener = Listener(socketPath: path, journal: Journal(), present: { _ in
        asked.set(true)
        return .approved
    }) { _ in "s3cr3t" }
    try await listener.start()
    defer { Task { await listener.stop() } }

    _ = try ask(path, "{\"protocol\":1,\"kind\":\"token\",\"account\":\"jira\"}\n")
    #expect(asked.value == false)
}

/// `hasKind` only routes on the field's presence, so a shape with a `kind` it
/// doesn't recognize still reaches the token path. `readSecret` must not be
/// consulted about it, and the reply must carry no secret.
@Test func refusesATokenRequestWithAnUnknownKindWithoutReadingTheSecret() async throws {
    let path = scratchSocket()
    defer { removeScratchDirectory(for: path) }
    let calledReadSecret = SyncBox(false)
    let listener = Listener(socketPath: path, journal: Journal(), present: { _ in .denied }) { _ in
        calledReadSecret.set(true)
        return "s3cr3t"
    }
    try await listener.start()
    defer { Task { await listener.stop() } }

    let reply = try ask(path, "{\"protocol\":1,\"kind\":\"anything\",\"account\":\"jira\"}\n")
    #expect(reply.contains("\"secret\":null"))
    #expect(calledReadSecret.value == false)
}

/// The number of descriptors this process has open, via `/dev/fd`. A leaked
/// `socket()` on every failed `start()` would grow this by roughly one per
/// attempt; ordinary noise from unrelated, concurrently-running tests opening
/// and closing their own short-lived sockets does not come close to the
/// margin used below.
private func openFileDescriptorCount() -> Int {
    (try? FileManager.default.contentsOfDirectory(atPath: "/dev/fd").count) ?? -1
}

// Before the fix, `start()` assigned `descriptor = socket(...)` before any of
// the guards below could fail, and none of those guards closed it. A path
// over `sun_path`'s 104-byte capacity is a deterministic way to fail late
// enough that a leak would show up, on every one of many retries.
@Test func startDoesNotLeakTheDescriptorWhenThePathIsTooLong() async throws {
    let path = scratchSocket()
    defer { removeScratchDirectory(for: path) }
    let directory = (path as NSString).deletingLastPathComponent
    let tooLong = directory + "/" + String(repeating: "x", count: 150)
    let failing = noSecret(socketPath: tooLong) { _ in .denied }

    let before = openFileDescriptorCount()
    for _ in 0..<200 {
        do {
            try await failing.start()
            Issue.record("expected start() to throw for an over-long socket path")
        } catch {
            // expected: ListenerError.bind
        }
    }
    let after = openFileDescriptorCount()
    // A leak here shows up as ~200 (one per iteration); measured noise from
    // unrelated tests racing this one under `swift test`'s default
    // parallelism tops out around 30, so the margin below cleanly separates
    // the two rather than chasing the noise ceiling exactly.
    #expect(after - before < 60)

    // And the process is still healthy: a listener that can actually bind
    // still can, right after 200 failed attempts on another instance.
    let working = noSecret(socketPath: path) { _ in .approved }
    try await working.start()
    defer { Task { await working.stop() } }
    let reply = try ask(path, requestLine() + "\n")
    #expect(reply.contains("\"decision\":\"approved\""))
}

// `createDirectory(attributes:)` only applies its attributes when it creates
// the directory. A directory left over at a looser mode -- from an earlier
// run, or from anything else -- must not stay that way forever: the spec
// calls this directory the real access control, the socket's own mode the
// second lock.
@Test func reassertsThe0700DirectoryModeEvenIfItAlreadyExisted() async throws {
    let path = scratchSocket()
    defer { removeScratchDirectory(for: path) }
    let directory = (path as NSString).deletingLastPathComponent
    chmod(directory, 0o755)

    let listener = noSecret(socketPath: path) { _ in .denied }
    try await listener.start()
    defer { Task { await listener.stop() } }

    let attributes = try FileManager.default.attributesOfItem(atPath: directory)
    let mode = (attributes[.posixPermissions] as? NSNumber)?.intValue
    #expect(mode == 0o700)
}

// Without a receive timeout on the accepted socket, a client that connects
// and sends nothing ties up its server-side handling forever. Connects raw,
// sends nothing, and waits (bounded by `poll`, so an unfixed listener fails
// this test instead of hanging it) for the server to give up and close.
@Test func closesAConnectionThatSendsNothingInsteadOfBlockingForever() async throws {
    let path = scratchSocket()
    defer { removeScratchDirectory(for: path) }
    let listener = noSecret(socketPath: path) { _ in .approved }
    try await listener.start()
    defer { Task { await listener.stop() } }

    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    #expect(fd >= 0)
    defer { close(fd) }

    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    let capacity = MemoryLayout.size(ofValue: address.sun_path)
    withUnsafeMutablePointer(to: &address.sun_path) { pointer in
        path.withCString { source in
            _ = strncpy(UnsafeMutableRawPointer(pointer).assumingMemoryBound(to: CChar.self),
                        source, capacity - 1)
        }
    }
    let size = socklen_t(MemoryLayout<sockaddr_un>.size)
    let connected = withUnsafePointer(to: &address) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, size) }
    }
    #expect(connected == 0)

    // Send nothing. Wait, with a generous margin over the server's own
    // receive timeout, for it to close the connection on its own.
    var descriptor = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
    let waited = poll(&descriptor, 1, 8000)
    #expect(waited > 0)

    var probe: UInt8 = 0
    let read = recv(fd, &probe, 1, 0)
    // The server closed the connection once its own timeout fired -- it had
    // nothing to answer, and it did not hang.
    #expect(read == 0)

    // The listener itself is unaffected: a normal request right after is
    // answered as usual.
    let reply = try ask(path, requestLine() + "\n")
    #expect(reply.contains("\"decision\":\"approved\""))
}
