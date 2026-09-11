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
    let account: String

    enum CodingKeys: String, CodingKey {
        case protocolVersion = "protocol"
        case account
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

    public func start() throws {
        let directory = (socketPath as NSString).deletingLastPathComponent
        try FileManager.default.createDirectory(
            atPath: directory,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        // A crashed run leaves the file behind; bind would fail with EADDRINUSE.
        try? FileManager.default.removeItem(atPath: socketPath)

        descriptor = socket(AF_UNIX, SOCK_STREAM, 0)
        guard descriptor >= 0 else { throw ListenerError.bind("socket() failed") }

        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let capacity = MemoryLayout.size(ofValue: address.sun_path)
        guard socketPath.utf8.count < capacity else {
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
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(descriptor, $0, size) }
        }
        guard bound == 0 else { throw ListenerError.bind("bind() failed: \(errno)") }

        // bind honours the umask, so the file lands 0755. The 0700 directory is
        // the real control; this is the second lock.
        chmod(socketPath, 0o600)

        guard listen(descriptor, 8) == 0 else { throw ListenerError.bind("listen() failed") }

        // Hoisted into a local `let` before the closure captures it: `descriptor`
        // is an actor-isolated `var`, and the event handler runs off the actor,
        // on a DispatchSource's own queue. Capturing the property itself would be
        // a data race waiting to happen; capturing this immutable copy is not.
        let boundDescriptor = descriptor
        let source = DispatchSource.makeReadSource(fileDescriptor: boundDescriptor, queue: .global())
        // Typed explicitly as `@Sendable`: `setEventHandler` takes a plain,
        // non-Sendable `() -> Void`, and a closure literal written inline here
        // would be inferred as isolated to this actor — the compiler's ordinary
        // convenience for a closure lexically inside an actor method. GCD then
        // runs it on an arbitrary global-queue thread, not this actor's
        // executor, and that mismatch is a runtime trap
        // ("Incorrect actor executor assumption"), not just a race in theory.
        // Spelling out `@Sendable` here opts back out of that inference so the
        // only actor hop is the explicit `await` inside `Task`.
        let onReadable: @Sendable () -> Void = { [boundDescriptor] in
            let client = accept(boundDescriptor, nil, nil)
            guard client >= 0 else { return }
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

        var buffer = [UInt8](repeating: 0, count: 65536)
        var collected = Data()
        while true {
            let read = recv(client, &buffer, buffer.count, 0)
            if read <= 0 { break }
            collected.append(contentsOf: buffer[0..<read])
            if collected.contains(0x0A) { break }
            if collected.count > 1_048_576 { return }
        }
        guard let newline = collected.firstIndex(of: 0x0A) else { return }
        let line = Data(collected[collected.startIndex..<newline])

        if hasKind(line) {
            guard let data = await listener.tokenResponseData(line: line) else { return }
            _ = data.withUnsafeBytes { send(client, $0.baseAddress, data.count, 0) }
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
            _ = data.withUnsafeBytes { send(client, $0.baseAddress, data.count, 0) }
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
        let secret = readSecret(request.account)
        let response = TokenResponse(protocolVersion: protocolVersion, secret: secret)
        guard var data = try? JSONEncoder().encode(response) else { return nil }
        data.append(0x0A)
        return data
    }
}
