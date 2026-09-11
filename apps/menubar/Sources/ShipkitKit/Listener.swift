import Foundation

public enum ListenerError: Error {
    case bind(String)
}

public struct PendingRequest: Sendable, Identifiable {
    /// The fingerprint. Two requests about the same situation are the same question.
    public let id: String
    public let request: ApprovalRequest

    public init(request: ApprovalRequest) {
        self.id = request.fingerprint
        self.request = request
    }
}

/// A second kind of request, alongside an approval. An item this application
/// writes through `SecItemAdd` cannot be read back by `/usr/bin/security` —
/// see `Keychain.swift` — so the token travels over the socket that already
/// exists instead. An approval request has no `kind` field; that is what
/// tells the two apart on the wire.
private struct TokenRequest: Decodable {
    let protocolVersion: Int
    let kind: String
    let account: String

    enum CodingKeys: String, CodingKey {
        case protocolVersion = "protocol"
        case kind, account
    }
}

private struct TokenResponse: Encodable {
    let protocolVersion: Int
    let kind = "token"
    let secret: String?

    enum CodingKeys: String, CodingKey {
        case protocolVersion = "protocol"
        case kind, secret
    }

    /// Not the synthesized conformance: that uses `encodeIfPresent` for an
    /// `Optional` property and so omits `secret` entirely when it is `nil`.
    /// The wire format calls for the key to stay present with a `null` value —
    /// the caller's answer to "is there one", not its absence.
    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(protocolVersion, forKey: .protocolVersion)
        try container.encode(kind, forKey: .kind)
        try container.encode(secret, forKey: .secret)
    }
}

/// True when the line carries a `kind` field at all, regardless of its value
/// or whether the rest of the line parses. An approval request never has one;
/// routing on presence, rather than on successful decoding, keeps a malformed
/// token request from being mistaken for an approval request (and so from
/// ever reaching the presenter).
private func hasKind(_ line: Data) -> Bool {
    guard let object = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else {
        return false
    }
    return object["kind"] != nil
}

/// Runs a blocking call on a GCD queue that overcommits threads, rather
/// than on Swift's cooperative pool. That pool is sized to the core count
/// and never overcommitted: a `Task` that makes a blocking `recv` or `send`
/// call directly ties up one of only a handful of threads for as long as
/// the call takes -- up to the receive timeout, for a silent client -- and
/// enough of them stop every `await` in the process, not just their own
/// connection's handling. `withCheckedContinuation` suspends the awaiting
/// task, releasing its cooperative thread, while the blocking work runs on
/// a disposable GCD thread instead.
private func runBlocking<T: Sendable>(_ work: @escaping @Sendable () -> T) async -> T {
    await withCheckedContinuation { continuation in
        DispatchQueue.global().async {
            continuation.resume(returning: work())
        }
    }
}

/// `send` is the other blocking call `serve` makes; routed through the same
/// queue as `recv`; for the same reason.
private func sendAll(_ client: Int32, _ data: Data) async {
    await runBlocking {
        _ = data.withUnsafeBytes { send(client, $0.baseAddress, data.count, 0) }
    }
}

public actor Listener {
    private let socketPath: String
    private let journal: Journal
    private let present: @Sendable (PendingRequest) async -> Decision
    private let readSecret: @Sendable (String) -> String?
    private var descriptor: Int32 = -1
    private var source: DispatchSourceRead?

    public init(
        socketPath: String,
        journal: Journal,
        present: @escaping @Sendable (PendingRequest) async -> Decision,
        readSecret: @escaping @Sendable (String) -> String? = { _ in nil }
    ) {
        self.socketPath = socketPath
        self.journal = journal
        self.present = present
        self.readSecret = readSecret
    }

    public static func defaultSocketPath() -> String {
        let base = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/shipkit")
        return base.appendingPathComponent("approvals.sock").path
    }

    /// Seconds a client is given to send its one line. `accept` runs on a
    /// DispatchSource's own GCD queue, which overcommits threads freely --
    /// but `serve`'s `recv` runs inside a `Task`, on Swift's cooperative
    /// pool, which is sized to the core count and never overcommitted. This
    /// timeout bounds how long a silent client can be waited on at all;
    /// `runBlocking` (below) is what keeps that wait off the cooperative
    /// pool, so a silent client ties up a disposable GCD thread rather than
    /// one of the few threads every other `await` in the process depends on.
    private static let receiveTimeoutSeconds: Int = 5

    public func start() throws {
        let directory = (socketPath as NSString).deletingLastPathComponent
        try FileManager.default.createDirectory(
            atPath: directory,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        // `createDirectory(attributes:)` applies its attributes only when it
        // creates the directory; on one that already exists -- left over
        // from an earlier run, or from something else entirely, at whatever
        // mode a looser umask gave it -- those attributes are silently
        // ignored. This directory is the real access control (the socket's
        // own mode is the second lock), so it is worth re-asserting on every
        // start, not just on first creation.
        guard chmod(directory, 0o700) == 0 else {
            throw ListenerError.bind("chmod on directory failed: \(errno)")
        }
        // A crashed run leaves the file behind; bind would fail with EADDRINUSE.
        try? FileManager.default.removeItem(atPath: socketPath)

        let newDescriptor = socket(AF_UNIX, SOCK_STREAM, 0)
        guard newDescriptor >= 0 else { throw ListenerError.bind("socket() failed") }
        // Every throw from here on must close `newDescriptor`: `start()`
        // failing must not leak a file descriptor for the life of the
        // process, and a caller retrying `start()` after a failure must not
        // silently overwrite the only reference to the previous one.
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let capacity = MemoryLayout.size(ofValue: address.sun_path)
        guard socketPath.utf8.count < capacity else {
            close(newDescriptor)
            throw ListenerError.bind("socket path is too long: \(socketPath)")
        }
        withUnsafeMutablePointer(to: &address.sun_path) { pointer in
            socketPath.withCString { source in
                _ = strncpy(
                    UnsafeMutableRawPointer(pointer).assumingMemoryBound(to: CChar.self),
                    source, capacity - 1
                )
            }
        }

        let size = socklen_t(MemoryLayout<sockaddr_un>.size)
        let bound = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(newDescriptor, $0, size) }
        }
        guard bound == 0 else {
            close(newDescriptor)
            throw ListenerError.bind("bind() failed: \(errno)")
        }

        // bind honours the umask, so the file lands 0755. The 0700 directory is
        // the real control; this is the second lock. A failed chmod here would
        // leave the socket at 0755 with nothing noticing, so it is checked like
        // any other step that can fail.
        guard chmod(socketPath, 0o600) == 0 else {
            close(newDescriptor)
            throw ListenerError.bind("chmod on socket failed: \(errno)")
        }

        guard listen(newDescriptor, 8) == 0 else {
            close(newDescriptor)
            throw ListenerError.bind("listen() failed")
        }

        descriptor = newDescriptor

        let source = DispatchSource.makeReadSource(fileDescriptor: newDescriptor, queue: .global())
        // Typed explicitly as `@Sendable`: `setEventHandler` takes a plain,
        // non-Sendable `() -> Void`, and a closure literal written inline here
        // would be inferred as isolated to this actor — the compiler's ordinary
        // convenience for a closure lexically inside an actor method. GCD then
        // runs it on an arbitrary global-queue thread, not this actor's
        // executor, and that mismatch is a runtime trap
        // ("Incorrect actor executor assumption"), not just a race in theory.
        // Spelling out `@Sendable` here opts back out of that inference so the
        // only actor hop is the explicit `await` inside `Task`.
        let onReadable: @Sendable () -> Void = { [newDescriptor] in
            let client = accept(newDescriptor, nil, nil)
            guard client >= 0 else { return }
            var timeout = timeval(tv_sec: Listener.receiveTimeoutSeconds, tv_usec: 0)
            guard setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size)) == 0 else {
                // A connection this listener cannot bound with a receive
                // timeout is exactly the one a silent client would otherwise
                // ride forever -- the failure this timeout exists to prevent.
                // The event handler cannot throw, so failing closed here
                // means refusing the connection outright rather than serving
                // it without the protection the rest of `serve` assumes is
                // in place.
                close(client)
                return
            }
            // The Node client waits with its own timeout and closes when it
            // fires; a person can still take a minute to click Approve after
            // that. `serve`'s later `send` then lands on a vanished peer,
            // and the default disposition for SIGPIPE kills the process --
            // same reasoning as SO_RCVTIMEO above, so it fails closed the
            // same way.
            var noSigPipe: Int32 = 1
            guard setsockopt(client, SOL_SOCKET, SO_NOSIGPIPE, &noSigPipe, socklen_t(MemoryLayout<Int32>.size)) == 0 else {
                close(client)
                return
            }
            Task { await Listener.serve(client: client, on: self) }
        }
        source.setEventHandler(handler: onReadable)
        source.resume()
        self.source = source
    }

    public func stop() {
        source?.cancel()
        source = nil
        if descriptor >= 0 { close(descriptor) }
        descriptor = -1
        try? FileManager.default.removeItem(atPath: socketPath)
    }

    /// Reads one line, answers it, closes. Everything it cannot verify is denied:
    /// a decision is permission to push, and a request it cannot make sense of is
    /// not something anyone agreed to.
    private static func serve(client: Int32, on listener: Listener) async {
        defer { close(client) }

        var collected = Data()
        // Allocated once, outside the loop, and reused for every `recv`: a
        // trickling client can drive this loop on the order of a million
        // iterations before hitting the newline or the 1 MB cap below, and a
        // fresh 64KB allocate-and-zero on every one of them is the kind of
        // amplification a per-iteration `Array` buffer costs but a pointer
        // allocated once does not. The compiler still refuses to treat
        // `UnsafeMutablePointer` as `Sendable` on its own -- it has no way
        // to know the pointee isn't concurrently touched elsewhere -- so
        // `nonisolated(unsafe)` is the explicit assertion that it is safe
        // here: this pointer is allocated fresh for this one connection,
        // touched only inside the single `recv` call each loop iteration
        // makes, and never shared beyond this function, unlike a mutable
        // Swift `Array` that a `@Sendable` closure cannot capture at all.
        let bufferSize = 65536
        nonisolated(unsafe) let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: bufferSize)
        defer { buffer.deallocate() }
        while true {
            // Off the cooperative pool: see `runBlocking`. Only the byte
            // count crosses back out of the closure; the bytes themselves
            // are already in `buffer`, read directly from the calling side.
            let read: Int = await runBlocking {
                recv(client, buffer, bufferSize, 0)
            }
            if read <= 0 { break }
            collected.append(UnsafeBufferPointer(start: buffer, count: read))
            if collected.contains(0x0A) { break }
            if collected.count > 1_048_576 { return }
        }
        guard let newline = collected.firstIndex(of: 0x0A) else { return }
        let line = Data(collected[collected.startIndex..<newline])

        if hasKind(line) {
            guard let data = await listener.tokenResponseData(line: line) else { return }
            await sendAll(client, data)
            return
        }

        let decision = await listener.decide(line: line)
        let fingerprintOfRequest = (try? decodeRequest(line))?.fingerprint ?? ""
        let response = ApprovalResponse(
            protocolVersion: protocolVersion,
            fingerprint: fingerprintOfRequest,
            decision: decision
        )
        if let data = try? encodeResponse(response) {
            await sendAll(client, data)
        }
    }

    fileprivate func decide(line: Data) async -> Decision {
        guard let request = try? decodeRequest(line) else { return .denied }
        guard request.protocolVersion == protocolVersion else { return .denied }

        // What the person will see must be what was hashed. A request whose
        // fingerprint does not match its own fields is refused without asking.
        guard fingerprint(request.situation) == request.fingerprint else { return .denied }

        if let known = await journal.decision(for: request.fingerprint) { return known }

        let decision = await present(PendingRequest(request: request))
        await journal.record(decision, for: request.fingerprint)
        return decision
    }

    /// Never touches the presenter or the journal: a token is not a decision,
    /// and nothing about asking for one belongs in the approval record.
    fileprivate func tokenResponseData(line: Data) async -> Data? {
        guard let request = try? JSONDecoder().decode(TokenRequest.self, from: line) else { return nil }
        guard request.protocolVersion == protocolVersion else { return nil }
        // `hasKind` only routed on the field's presence, not its value: a
        // line with `"kind":"anything"` reaches here too. A shape this
        // listener does not recognize is refused the same way an absent
        // secret is -- a `null` -- and never by asking `readSecret` about it.
        guard request.kind == "token" else {
            return Self.encodeToken(TokenResponse(protocolVersion: protocolVersion, secret: nil))
        }
        let secret = readSecret(request.account)
        return Self.encodeToken(TokenResponse(protocolVersion: protocolVersion, secret: secret))
    }

    private static func encodeToken(_ response: TokenResponse) -> Data? {
        guard var data = try? JSONEncoder().encode(response) else { return nil }
        data.append(0x0A)
        return data
    }
}
