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
        title: "t", commitMessage: "m", diffstat: "1 file",
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
        repo: "/r", branch: "b", base: "d", head: "c", title: "t", commitMessage: "m", diffstat: "1 file",
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
        repo: "/r", branch: "b", base: "d", head: "c", title: "t", commitMessage: "m", diffstat: "1 file",
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

/// Bridges `DispatchSemaphore.wait(timeout:)` -- unavailable to call
/// directly from an `async` context, since doing so would block whatever
/// thread is running this function -- onto a GCD thread via a continuation,
/// the same technique `Listener`'s own `runBlocking` uses. The `async` test
/// function suspends, releasing its cooperative thread, while the actual
/// wait happens elsewhere.
private func waitBlocking(_ semaphore: DispatchSemaphore, timeout: DispatchTime) async -> DispatchTimeoutResult {
    await withCheckedContinuation { continuation in
        DispatchQueue.global().async {
            continuation.resume(returning: semaphore.wait(timeout: timeout))
        }
    }
}

/// Opens a connection and sends nothing, returning its descriptor (or `-1`
/// on failure). No `#expect` calls in here: this must be safe to call from a
/// raw thread that Swift Testing's task-local context never reaches, which
/// is exactly where the test below calls it from.
private func openSilentConnection(_ path: String) -> Int32 {
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { return fd }
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
    guard connected == 0 else {
        close(fd)
        return -1
    }
    return fd
}

/// The same connect/send/receive as `ask`, but returning `nil` on any
/// failure instead of calling `#expect` -- because, like `openSilentConnection`,
/// this is meant to run on a raw thread with no Swift Testing task-local
/// context to record an issue against.
private func askRaw(_ path: String, _ line: String) -> String? {
    // Retries for the same reason the silent connections do: this is
    // deliberately raced against a burst of other connects, and a full
    // AF_UNIX listen backlog fails `connect` immediately rather than
    // waiting for room.
    var fd: Int32 = -1
    for _ in 0..<50 where fd < 0 {
        fd = openSilentConnection(path)
        if fd < 0 { usleep(10_000) }
    }
    guard fd >= 0 else { return nil }
    defer { close(fd) }

    _ = line.withCString { send(fd, $0, strlen($0), 0) }

    var buffer = [UInt8](repeating: 0, count: 4096)
    let read = recv(fd, &buffer, buffer.count, 0)
    guard read > 0 else { return nil }
    return String(decoding: buffer[0..<read], as: UTF8.self)
}

// The finding: `serve`'s `recv`/`send` were plain blocking calls made
// directly inside the `async` function that `Task { await Listener.serve(...) }`
// runs, and that `Task` runs on Swift's cooperative pool -- sized to the core
// count, and never overcommitted. Enough simultaneously silent clients tied
// up every thread in that pool, not just their own connections' handling:
// since `serve` is where the fingerprint check, the journal, and eventually
// `present` are all reached via `await`, a saturated pool stalls every
// `await` in the process, including a perfectly well-formed request's.
//
// Measured, and worth saying plainly rather than implying a determinism this
// test does not have: with the blocking `recv`/`send` restored (the bug
// reintroduced), this test catches the starvation on roughly a quarter to a
// third of runs, not every run -- GCD grows an overcommitted queue's thread
// count once it notices blocked work, and whether it notices in time to
// rescue the valid request is itself a race no retry count or backoff here
// makes deterministic. With the fix in place, every run passes, in about
// 16ms, because the fixed code never touches the cooperative pool for the
// blocking work at all -- there is no race to win. So this is a regression
// guard that will eventually catch a reintroduction across many CI runs, not
// a proof on any single one; the argument for the fix itself does not depend
// on this test ever failing (see the report for why the fix is correct on
// its own terms).
@Test func answersAValidRequestPromptlyDespiteManySilentConnections() async throws {
    let path = scratchSocket()
    defer { removeScratchDirectory(for: path) }
    let listener = noSecret(socketPath: path) { _ in .approved }
    try await listener.start()
    defer { Task { await listener.stop() } }

    // Enough silent connections to exceed the cooperative pool's thread
    // count, so a version of `serve` that blocks that pool would starve on
    // its own accumulated load rather than on some other test's.
    let silentCount = ProcessInfo.processInfo.activeProcessorCount + 4

    // Every bit of socket work below runs on real, GCD-scheduled threads,
    // never as `async` code: this test exists to prove the cooperative pool
    // is not what a client waits behind, so doing its own work on that same
    // pool would defeat the point -- an unfixed `serve` would then starve
    // the test harness itself instead of just failing this test cleanly.
    //
    // The silent connections and the valid request are all fired through
    // the same `concurrentPerform` call, as sibling iterations, rather than
    // two separate dispatches: two independently-submitted blocks give GCD
    // room to schedule them slightly apart, and a version of `serve` that
    // blocks the cooperative pool only needs that much of a head start to
    // recover (GCD grows an overcommitted queue's thread count once it
    // notices blocked work, just not instantly) before the valid request
    // ever has to compete for a thread.
    let finished = DispatchSemaphore(value: 0)
    let silentDescriptorsBox = SyncBox<[Int32]>([])
    let result = SyncBox<String?>(nil)

    DispatchQueue.global().async {
        let silentBoxes = (0..<silentCount).map { _ in SyncBox<Int32>(-1) }
        // Index 0 is the valid request; the rest are silent connections.
        // Together, one `concurrentPerform` call.
        DispatchQueue.concurrentPerform(iterations: silentCount + 1) { index in
            if index == 0 {
                result.set(askRaw(path, requestLine() + "\n"))
                return
            }
            let slot = index - 1
            var fd: Int32 = -1
            for _ in 0..<50 where fd < 0 {
                fd = openSilentConnection(path)
                if fd < 0 { usleep(10_000) }
            }
            silentBoxes[slot].set(fd)
        }
        silentDescriptorsBox.set(silentBoxes.map { $0.value })
        finished.signal()
    }

    // A couple of seconds is generous next to the 5-second receive timeout:
    // a listener whose cooperative pool is not blocked answers in well
    // under a second, silent connections notwithstanding.
    let arrived = await waitBlocking(finished, timeout: .now() + 2)
    let silentDescriptors = silentDescriptorsBox.value
    defer { for fd in silentDescriptors { close(fd) } }

    #expect(arrived == .success)
    #expect(result.value?.contains("\"decision\":\"approved\"") == true)
}

/// Connects and sends `line`, one byte at a time via its own `send` call,
/// rather than in a single `send`. `serve`'s read buffer moved from
/// being allocated once before its loop to once per iteration (a regression
/// this test guards against separately), but a byte-at-a-time client is also
/// the shape that actually exercises the loop's *accumulation* across many
/// `recv` calls -- a single `send`, however long, satisfies the loop in one
/// iteration and never proves the collected bytes from earlier iterations
/// survive into later ones.
private func askInChunks(_ path: String, _ line: String) throws -> String {
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    #expect(fd >= 0)
    defer { close(fd) }

    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
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

    for byte in Array(line.utf8) {
        var single = byte
        _ = withUnsafePointer(to: &single) { send(fd, $0, 1, 0) }
    }

    var buffer = [UInt8](repeating: 0, count: 4096)
    let read = recv(fd, &buffer, buffer.count, 0)
    #expect(read > 0)
    return String(decoding: buffer[0..<max(read, 0)], as: UTF8.self)
}

// The finding: moving `recv`'s buffer onto a GCD queue put `var localBuffer =
// [UInt8](repeating: 0, count: 65536)` *inside* `runBlocking`'s closure, so
// every loop iteration allocated and zero-filled a fresh 64KB buffer instead
// of reusing one allocated before the loop. The loop only ends on a newline
// or at the 1 MB cap, so a client trickling bytes one at a time can drive it
// through on the order of a million iterations -- each one now paying that
// allocation. The buffer is hoisted back out; this test pins the behaviour
// the hoist has to preserve rather than the allocation count itself, since
// nothing in this test's outcome can observe an allocation directly: a
// client sending its line in many small pieces still gets answered
// correctly, and the loop's 1 MB cap still refuses an oversized body.
@Test func answersARequestSentInManySmallChunks() async throws {
    let path = scratchSocket()
    defer { removeScratchDirectory(for: path) }
    let listener = noSecret(socketPath: path) { _ in .approved }
    try await listener.start()
    defer { Task { await listener.stop() } }

    let reply = try askInChunks(path, requestLine() + "\n")
    #expect(reply.contains("\"decision\":\"approved\""))
    #expect(reply.hasSuffix("\n"))
}

// The same trickling delivery, but past the loop's 1 MB cap: a reused buffer
// that accidentally stopped accumulating across iterations (for instance by
// only ever keeping the most recent chunk) would either never see the cap
// tripped, or would see it tripped on the wrong count. Sent as one large
// `send` rather than byte-by-byte -- a body long past the cap does not need
// slow delivery to exercise the accumulation, and this keeps the test fast.
@Test func refusesABodyThatExceedsTheOneMegabyteCapEvenWhenChunked() async throws {
    let path = scratchSocket()
    defer { removeScratchDirectory(for: path) }
    let asked = SyncBox(false)
    let listener = noSecret(socketPath: path) { _ in
        asked.set(true)
        return .approved
    }
    try await listener.start()
    defer { Task { await listener.stop() } }

    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    #expect(fd >= 0)
    defer { close(fd) }
    // The server closes its end as soon as the 1 MB cap trips -- that is the
    // behaviour under test -- and this client is still mid-`send` of a 2 MB
    // body when it does. Writing to an already-closed socket then delivers
    // SIGPIPE, whose default disposition kills the whole test process, not
    // just this connection. `SO_NOSIGPIPE` is the per-socket, macOS-specific
    // way to ask for `EPIPE` from `send` instead, scoped to this one test
    // socket rather than silencing the signal process-wide.
    var noSigPipe: Int32 = 1
    _ = setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSigPipe, socklen_t(MemoryLayout<Int32>.size))

    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
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

    // Well past the 1 MB cap, and with no newline anywhere in it: the loop
    // must hit `collected.count > 1_048_576` and `return` -- closing without
    // ever reaching the presenter -- rather than the newline path. The
    // server may close its end (and this `send` may then fail with `EPIPE`)
    // before all 2 MB are written; that is fine, and expected -- the
    // assertions below are on what the server did, not on this send
    // completing.
    let oversized = Data(repeating: 0x41, count: 2_000_000)
    _ = oversized.withUnsafeBytes { send(fd, $0.baseAddress, oversized.count, 0) }

    var probe: UInt8 = 0
    let read = recv(fd, &probe, 1, 0)
    // The server closed without answering: no bytes, and no presenter call.
    #expect(read == 0)
    #expect(asked.value == false)
}

// The finding: `serve`'s `send` runs on whatever socket `accept` handed back,
// and the listener never asked for `SO_NOSIGPIPE` on it. The ordinary
// sequence this product is built around produces exactly the situation that
// setting exists to survive: the Node client waits with its own timeout,
// gives up, and closes its end -- and only later does a person actually
// click Approve or Deny, at which point `serve`'s `send` lands on a peer
// that is already gone. Writing to a vanished peer without SO_NOSIGPIPE
// raises SIGPIPE, whose default disposition kills the whole process, not
// just the one connection. `present` here is rigged to suspend on a
// continuation the test controls, so the client's close can be made to
// happen deterministically before the decision -- and so the `send` --
// comes back.
@Test func answersACorrectlyBehavedRequestAfterAnEarlierClientVanishedBeforeItsAnswer() async throws {
    let path = scratchSocket()
    defer { removeScratchDirectory(for: path) }

    let presentStarted = DispatchSemaphore(value: 0)
    let resumeBox = SyncBox<CheckedContinuation<Decision, Never>?>(nil)
    let listener = noSecret(socketPath: path) { _ in
        await withCheckedContinuation { continuation in
            resumeBox.set(continuation)
            presentStarted.signal()
        }
    }
    try await listener.start()
    defer { Task { await listener.stop() } }

    let fd = openSilentConnection(path)
    #expect(fd >= 0)
    let line = requestLine() + "\n"
    _ = line.withCString { send(fd, $0, strlen($0), 0) }

    // Wait until the listener has actually parsed the request and reached
    // `present` -- i.e. it is now the one holding the pending decision --
    // before pulling the connection out from under it.
    let arrived = await waitBlocking(presentStarted, timeout: .now() + 2)
    #expect(arrived == .success)

    // The client vanishes before its decision comes back: the Node side of
    // this exchange giving up on its own timeout, well before the person at
    // the menu bar has actually clicked anything.
    close(fd)
    try await Task.sleep(nanoseconds: 200_000_000)

    // The slow human, finally clicking Approve.
    resumeBox.value?.resume(returning: .approved)

    // `serve`'s `send` on this now-closed connection is exactly where an
    // unfixed listener dies. There is no catching that from inside this
    // process -- SIGPIPE's default disposition is termination -- so the
    // only assertion available is that execution reaches here at all, on
    // the far side of that `send` having happened.
    try await Task.sleep(nanoseconds: 300_000_000)

    // The listener itself is unaffected: a normal request right after is
    // still answered correctly.
    let reply = try ask(path, requestLine() + "\n")
    #expect(reply.contains("\"decision\":\"approved\""))
}
