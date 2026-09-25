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

/// A review offered while `shipkit review` is also serving its page, waiting
/// for this person to answer it here instead of in the browser.
public struct PendingReview: Sendable, Identifiable {
    /// The fingerprint. Two offers about the same review are the same question.
    public let id: String
    public let request: ReviewRequest

    public init(request: ReviewRequest) {
        self.id = request.fingerprint
        self.request = request
    }
}

/// What the person said about a review here, as opposed to on the page.
public struct ReviewOutcome: Sendable, Equatable {
    public let answer: ReviewAnswer
    public let items: [SelectedItem]

    public init(answer: ReviewAnswer, items: [SelectedItem]) {
        self.answer = answer
        self.items = items
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

/// The line's `kind`, or `nil` when it has none.
///
/// An approval request never carries one, so `nil` *is* the approval route.
/// Read straight off the JSON rather than by decoding the whole request, and
/// for the reason the presence check had before a third kind existed: a
/// malformed request of any kind must not be mistaken for an approval request,
/// and so must never reach the presenter.
///
/// `kindPresent` and this are two questions: a `kind` whose value is not one
/// this application knows is still not an approval, and answering it as one
/// would present a person with a request assembled from a line nobody parsed.
private func kindOf(_ line: Data) -> String? {
    guard let object = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else {
        return nil
    }
    return object["kind"] as? String
}

/// True when the line carries a `kind` field at all, whatever its value and
/// whether or not it is a string. Routes everything that is not an approval
/// away from the approval path, including a `kind` this application does not
/// recognise and a `kind` that is not even a string.
private func kindPresent(_ line: Data) -> Bool {
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

/// A flag the watcher below reads and its owner sets, across two concurrency
/// domains. `nonisolated(unsafe)` on a `Bool` would be a data race; this is the
/// smallest thing that is not one.
private final class StopFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var running = true

    var isRunning: Bool {
        lock.lock()
        defer { lock.unlock() }
        return running
    }

    func halt() {
        lock.lock()
        running = false
        lock.unlock()
    }
}

/// Runs `work` while watching `client` for its peer going away, and joins the
/// watcher before returning — so the caller may close the descriptor the moment
/// this call comes back.
///
/// `serve` reads one line and then awaits a human, and for as long as that takes
/// nothing is reading the socket. A client that vanishes — `shipkit submit`
/// hitting its own timeout, a person pressing Ctrl-C, or `shipkit review`
/// closing this connection because its page was answered first — used to go
/// unnoticed until the eventual `send`, which fails silently because
/// `SO_NOSIGPIPE` is set. The request stayed on screen, the person decided, and
/// the decision reached nobody.
///
/// A bounded `poll` rather than a `DispatchSourceRead`. Two reasons, both
/// measured: end-of-file leaves a descriptor readable *forever*, so a
/// level-triggered source re-fires in a tight loop and saturates the global
/// queue — every other connection in the process then times out. And a source
/// must not have its descriptor closed before its cancel handler has run, which
/// is a lifetime this function would have to thread through every early return
/// in `serve`. Joining a polling task has neither problem, and costs one wakeup
/// every 200ms per connection that is actually waiting on a person.
private func whileWatchingForAVanishedPeer<T: Sendable>(
    client: Int32,
    onVanish: @escaping @Sendable () -> Void,
    _ work: () async -> T
) async -> T {
    let stop = StopFlag()
    let watcher = Task.detached {
        while stop.isRunning {
            // `poll` with a zero timeout: it answers from the kernel's own state
            // and returns at once, so this costs no thread at all. The first
            // version of this blocked in `poll` on a GCD thread for 200ms at a
            // time — measured, that exhausts the global queue's thread limit as
            // soon as a few connections are waiting on a person, and then *every*
            // other connection in the process stalls behind the parked threads.
            // The sleep below is what waits, and a sleeping `Task` holds nothing.
            let descriptor = UnsafeMutablePointer<pollfd>.allocate(capacity: 1)
            descriptor.pointee = pollfd(fd: client, events: Int16(POLLIN), revents: 0)
            let ready = poll(descriptor, 1, 0)
            descriptor.deallocate()

            guard stop.isRunning else { return }
            if ready > 0 {
                // Readable with nothing to read is end-of-file. `MSG_PEEK` leaves
                // anything else exactly where it is: this watcher must never
                // consume a byte the protocol might still want.
                var byte: UInt8 = 0
                if recv(client, &byte, 1, MSG_PEEK | MSG_DONTWAIT) == 0 { onVanish() }
                return
            }
            // Negative means the descriptor is not usable at all, which is not
            // something to keep asking about.
            if ready < 0 { return }
            try? await Task.sleep(for: .milliseconds(200))
        }
    }

    let result = await work()
    stop.halt()
    // Joined, not merely cancelled: `poll` is already in flight on a thread that
    // holds this descriptor, and returning before it finishes would let the
    // caller close a descriptor another thread is still naming.
    await watcher.value
    return result
}

public actor Listener {
    private let socketPath: String
    private let journal: Journal
    private let present: @Sendable (PendingRequest) async -> Decision
    private let readSecret: @Sendable (String) -> String?
    /// Shows a review and waits. `nil` means it was withdrawn rather than
    /// answered — the person never decided, so there is nothing to send.
    private let presentReview: @Sendable (PendingReview) async -> ReviewOutcome?
    /// Takes a review off the panel because the run that offered it has gone.
    /// Must resume whatever `presentReview` is suspended on, or this connection
    /// never finishes.
    private let withdrawReview: @Sendable (String) -> Void
    /// Takes an approval off the panel because the run that asked for it has
    /// gone. Resumes whatever `present` is suspended on with `.pending`.
    private let withdrawApproval: @Sendable (String) -> Void
    /// Agents currently holding a connection open. See `AgentPresence`: this is
    /// how the menu bar answers "is there anything to hand work to" with a fact
    /// rather than a guess.
    public let presence = AgentPresence()
    private var descriptor: Int32 = -1
    private var source: DispatchSourceRead?

    public init(
        socketPath: String,
        journal: Journal,
        present: @escaping @Sendable (PendingRequest) async -> Decision,
        readSecret: @escaping @Sendable (String) -> String? = { _ in nil },
        // Defaulted so a listener built for approvals alone stays one line. A
        // presenter that answers nothing declines every review offer by closing
        // the connection, which `shipkit review` reads as "no surface here" and
        // carries on serving its page.
        presentReview: @escaping @Sendable (PendingReview) async -> ReviewOutcome? = { _ in nil },
        withdrawReview: @escaping @Sendable (String) -> Void = { _ in },
        withdrawApproval: @escaping @Sendable (String) -> Void = { _ in }
    ) {
        self.socketPath = socketPath
        self.journal = journal
        self.present = present
        self.readSecret = readSecret
        self.presentReview = presentReview
        self.withdrawReview = withdrawReview
        self.withdrawApproval = withdrawApproval
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

        if kindOf(line) == "review" {
            await serveReview(client: client, line: line, on: listener)
            return
        }

        if kindOf(line) == "attach" {
            await serveAttach(client: client, line: line, on: listener)
            return
        }

        if kindPresent(line) {
            guard let data = await listener.tokenResponseData(line: line) else { return }
            await sendAll(client, data)
            return
        }

        // An approval, and the one path that watches for its peer going away.
        // Before this, a `shipkit submit` that timed out and exited left its
        // request on the panel: the person read it, clicked Approve, and the
        // answer reached nobody, with nothing on screen to say so.
        let decision = await whileWatchingForAVanishedPeer(
            client: client,
            onVanish: { Task { await listener.abandonApproval(line: line) } }
        ) {
            await listener.decide(line: line)
        }
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

    /// Registers an agent for as long as it keeps the connection open.
    ///
    /// The connection is the registration. Nothing is polled and no heartbeat is
    /// exchanged: the process on the other end is `shipkit mcp`, which lives
    /// exactly as long as the agent hosting it, and a vanished peer arrives here
    /// as end-of-file from `recv`. Holding this one `recv` open is the whole
    /// mechanism.
    ///
    /// The `defer` matters more than it looks. Detaching has to happen however
    /// this returns -- a closed connection, a killed agent, a cancelled task --
    /// because an entry left behind would tell the menu bar an agent is there and
    /// make its button do nothing.
    private static func serveAttach(client: Int32, line: Data, on listener: Listener) async {
        let name = (try? JSONSerialization.jsonObject(with: line) as? [String: Any])
            .flatMap { $0?["name"] as? String } ?? ""
        await listener.presence.attach(id: client, name: name)
        defer { Task { await listener.presence.detach(id: client) } }

        // Clear the receive timeout. Every accepted socket gets one so that a
        // client which connects and then says nothing cannot tie a thread up
        // indefinitely while its one line is waited for. That reasoning stops
        // applying the moment the line arrives and says this connection is a
        // presence registration: staying silent is the entire job, and the
        // timeout was closing it after five seconds.
        //
        // Measured, not reasoned about: an attached agent showed as present for
        // four seconds and was gone by six, so the menu bar said "no agent is
        // running" no matter what was running.
        var forever = timeval(tv_sec: 0, tv_usec: 0)
        _ = setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, &forever, socklen_t(MemoryLayout<timeval>.size))

        // Acknowledged so the agent side knows it was heard rather than guessing
        // from a connection that merely stayed open.
        await sendAll(client, Data("{\"ok\":true}\n".utf8))

        // Blocks until the peer goes away. Nothing sent after the attach line is
        // read: this connection carries presence, not messages. The byte lives
        // inside the closure because a pointer is not `Sendable` and this one has
        // no reason to outlive the call.
        while true {
            let read: Int = await runBlockingStatic {
                var byte: UInt8 = 0
                return withUnsafeMutablePointer(to: &byte) { recv(client, $0, 1, 0) }
            }
            if read <= 0 { return }
        }
    }

    /// `runBlocking`, reachable from the static serve helpers.
    private static func runBlockingStatic<T: Sendable>(_ work: @escaping @Sendable () -> T) async -> T {
        await withCheckedContinuation { continuation in
            DispatchQueue.global().async {
                continuation.resume(returning: work())
            }
        }
    }

    /// Reads a review offer, shows it, and sends back whatever the person said.
    ///
    /// Deliberately never journalled. The journal exists so the same push is not
    /// approved twice inside ten minutes; a review is a person reading a diff,
    /// and running one again after answering is an ordinary thing to do, not a
    /// repetition to suppress.
    private static func serveReview(client: Int32, line: Data, on listener: Listener) async {
        guard let pending = await listener.review(line: line) else { return }

        let answered = await whileWatchingForAVanishedPeer(
            client: client,
            onVanish: { Task { await listener.abandonReview(pending.id) } }
        ) {
            await listener.show(pending)
        }
        guard let outcome = answered else { return }

        let response = ReviewResponse(
            protocolVersion: protocolVersion,
            fingerprint: pending.id,
            answer: outcome.answer,
            items: outcome.items
        )
        if let data = try? encodeReviewResponse(response) {
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
        // A withdrawal is not a decision, so it is not recorded. The journal
        // answers a repeated request from its record without asking anyone, and
        // a recorded `pending` would answer the next ten minutes of identical
        // requests with a refusal nobody ever made.
        if decision != .pending {
            await journal.record(decision, for: request.fingerprint)
        }
        return decision
    }

    /// The run that asked for this approval has gone. Nothing is sent and
    /// nothing is recorded; the panel simply stops showing a question whose
    /// answer could no longer reach anybody.
    fileprivate func abandonApproval(line: Data) {
        guard let request = try? decodeRequest(line) else { return }
        withdrawApproval(request.fingerprint)
    }

    /// Shows a review, or refuses it without showing it.
    ///
    /// Everything it cannot verify is refused by closing rather than by
    /// answering: a review response is a person's words about their own change,
    /// and a line this application could not make sense of is not those words.
    /// `shipkit review` reads the closed connection as "this surface could not
    /// answer" and keeps serving its page, which is the right outcome — one
    /// broken surface must not end a review the other could finish.
    fileprivate func review(line: Data) -> PendingReview? {
        guard let request = try? decodeReviewRequest(line) else { return nil }
        guard request.protocolVersion == protocolVersion else { return nil }
        // What the person will see must be what was hashed.
        guard reviewFingerprint(request.situation) == request.fingerprint else { return nil }
        return PendingReview(request: request)
    }

    fileprivate func show(_ pending: PendingReview) async -> ReviewOutcome? {
        await presentReview(pending)
    }

    fileprivate func abandonReview(_ id: String) {
        withdrawReview(id)
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
