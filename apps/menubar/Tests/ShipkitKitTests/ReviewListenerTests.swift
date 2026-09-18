import Foundation
import Testing
@testable import ShipkitKit

// Run these with `scripts/swift-test.sh`, which passes `--no-parallel`.
// `ListenerTests` has a test that deliberately saturates the thread pool, and
// any socket test running beside it starves in both directions — see that
// script for the measurement.

/// The same scratch-socket recipe `ListenerTests` uses, for the same measured
/// reason: a per-session temporary directory overflows `sun_path`.
private func reviewScratchSocket() -> String {
    var template: [CChar] = Array("/tmp/shipkit-review-XXXXXX".utf8CString)
    let directory: String = template.withUnsafeMutableBufferPointer { buffer in
        guard let base = buffer.baseAddress, mkdtemp(base) != nil else {
            fatalError("mkdtemp failed: \(String(cString: strerror(errno)))")
        }
        return String(cString: base)
    }
    return directory + "/approvals.sock"
}

private func removeScratch(_ socketPath: String) {
    try? FileManager.default.removeItem(atPath: (socketPath as NSString).deletingLastPathComponent)
}

private func connectTo(_ path: String) -> Int32 {
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
    return fd
}

private func send(_ fd: Int32, _ line: String) {
    _ = line.withCString { send(fd, $0, strlen($0), 0) }
}

/// Reads one line, or gives up. Returns `nil` when the peer closed without
/// sending one — which is how this listener refuses a review.
private func readLine(_ fd: Int32, seconds: Int) -> String? {
    var timeout = timeval(tv_sec: seconds, tv_usec: 0)
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
    var buffer = [UInt8](repeating: 0, count: 8192)
    let read = recv(fd, &buffer, buffer.count, 0)
    guard read > 0 else { return nil }
    return String(decoding: buffer[0..<read], as: UTF8.self)
}

private let offerSituation = ReviewSituation(
    repo: "example-app", root: "/r", url: "http://127.0.0.1:1/?token=x", branch: "b", base: "develop",
    commitMessage: "fix(x): y", diffstat: " 1 file changed",
    items: [OfferedItem(kind: "warning", id: "untracked-files", message: "m", severity: "warns")],
    files: [OfferedFile(path: "A.swift", status: "modified", line: 3)]
)

private func offerLine(fingerprintOverride: String? = nil, protocolOverride: Int? = nil) -> String {
    let fp = fingerprintOverride ?? reviewFingerprint(offerSituation)
    let request = ReviewRequest(
        protocolVersion: protocolOverride ?? protocolVersion,
        kind: "review",
        fingerprint: fp,
        repo: offerSituation.repo, root: offerSituation.root, url: offerSituation.url,
        branch: offerSituation.branch, base: offerSituation.base,
        commitMessage: offerSituation.commitMessage, diffstat: offerSituation.diffstat,
        items: offerSituation.items, files: offerSituation.files
    )
    let data = try! JSONEncoder().encode(request)
    return String(decoding: data, as: UTF8.self) + "\n"
}

@Test func presentsAReviewAndSendsBackWhatWasTicked() async throws {
    let path = reviewScratchSocket()
    defer { removeScratch(path) }
    let listener = Listener(
        socketPath: path,
        journal: Journal(),
        present: { _ in .denied },
        presentReview: { offer in
            ReviewOutcome(
                answer: .selected,
                items: [SelectedItem(kind: "warning", id: offer.request.items[0].id, message: "m", note: "fix it")]
            )
        }
    )
    try await listener.start()

    let fd = connectTo(path)
    defer { close(fd) }
    send(fd, offerLine())
    let line = try #require(readLine(fd, seconds: 5))
    let response = try JSONDecoder().decode(ReviewResponse.self, from: Data(line.utf8))

    #expect(response.answer == .selected)
    #expect(response.items.first?.note == "fix it")
    #expect(response.fingerprint == reviewFingerprint(offerSituation))
    await listener.stop()
}

/// What the person will see must be what was hashed. An offer whose fields do
/// not produce its own fingerprint is refused by closing — never shown.
@Test func refusesAnOfferWhoseFingerprintDoesNotMatchItsOwnFields() async throws {
    let path = reviewScratchSocket()
    defer { removeScratch(path) }
    let shown = LockedFlag()
    let listener = Listener(
        socketPath: path,
        journal: Journal(),
        present: { _ in .denied },
        presentReview: { _ in
            shown.set()
            return ReviewOutcome(answer: .nothing, items: [])
        }
    )
    try await listener.start()

    let fd = connectTo(path)
    defer { close(fd) }
    send(fd, offerLine(fingerprintOverride: String(repeating: "0", count: 64)))

    #expect(readLine(fd, seconds: 2) == nil)
    #expect(shown.value == false)
    await listener.stop()
}

@Test func refusesAnOfferFromAShipkitSpeakingAnotherProtocol() async throws {
    let path = reviewScratchSocket()
    defer { removeScratch(path) }
    let shown = LockedFlag()
    let listener = Listener(
        socketPath: path,
        journal: Journal(),
        present: { _ in .denied },
        presentReview: { _ in
            shown.set()
            return ReviewOutcome(answer: .nothing, items: [])
        }
    )
    try await listener.start()

    let fd = connectTo(path)
    defer { close(fd) }
    send(fd, offerLine(protocolOverride: protocolVersion + 1))

    #expect(readLine(fd, seconds: 2) == nil)
    #expect(shown.value == false)
    await listener.stop()
}

/// A review offer must never reach the approval presenter. An approval request
/// carries no `kind`; routing on the value is what keeps the two apart.
@Test func aReviewOfferIsNeverShownAsAnApproval() async throws {
    let path = reviewScratchSocket()
    defer { removeScratch(path) }
    let approvals = LockedFlag()
    let listener = Listener(
        socketPath: path,
        journal: Journal(),
        present: { _ in
            approvals.set()
            return .approved
        },
        presentReview: { _ in ReviewOutcome(answer: .nothing, items: []) }
    )
    try await listener.start()

    let fd = connectTo(path)
    defer { close(fd) }
    send(fd, offerLine())
    _ = readLine(fd, seconds: 5)

    #expect(approvals.value == false)
    await listener.stop()
}

/// The run that offered the review went away — answered on its page, or
/// stopped. Nothing is sent, and the panel is told to take it down.
@Test func withdrawsTheReviewWhenTheRunThatOfferedItGoesAway() async throws {
    let path = reviewScratchSocket()
    defer { removeScratch(path) }
    let withdrawn = LockedFlag()
    let presented = LockedFlag()
    let gate = Gate()
    let listener = Listener(
        socketPath: path,
        journal: Journal(),
        present: { _ in .denied },
        presentReview: { _ in
            presented.set()
            // Suspends until the withdrawal resumes it, rather than sleeping for
            // a fixed stretch. A sleep long enough to be safe is also long enough
            // to slow the whole suite down — measured: it pushed the timing-
            // sensitive tests in ListenerTests and GhCommandTests past their
            // budgets, which looked like this change breaking them.
            await gate.wait()
            return nil
        },
        withdrawReview: { _ in
            withdrawn.set()
            gate.open()
        }
    )
    try await listener.start()

    let fd = connectTo(path)
    send(fd, offerLine())
    // Long enough for the offer to reach the presenter before the peer goes.
    while presented.value == false { try await Task.sleep(for: .milliseconds(20)) }
    close(fd)

    var waited = 0
    while withdrawn.value == false && waited < 200 {
        try await Task.sleep(for: .milliseconds(25))
        waited += 1
    }
    #expect(withdrawn.value)
    await listener.stop()
}

/// The same hole, on the path that had it before reviews existed: a `shipkit
/// submit` that hit its own timeout and exited used to leave its request on the
/// panel, where a person could read it, click Approve, and reach nobody.
@Test func withdrawsAnApprovalWhenTheRunThatAskedGoesAway() async throws {
    let path = reviewScratchSocket()
    defer { removeScratch(path) }
    let withdrawn = LockedFlag()
    let presented = LockedFlag()
    let gate = Gate()
    let listener = Listener(
        socketPath: path,
        journal: Journal(),
        present: { _ in
            presented.set()
            await gate.wait()
            return .denied
        },
        withdrawApproval: { _ in
            withdrawn.set()
            gate.open()
        }
    )
    try await listener.start()

    let situation = Situation(
        repo: "/r", branch: "b", base: "d", head: "c", title: "t",
        commitMessage: "m", diffstat: "1 file", warnings: []
    )
    let line = """
    {"protocol":\(protocolVersion),"fingerprint":"\(fingerprint(situation))","repo":"/r","branch":"b",\
    "base":"d","head":"c","title":"t","commitMessage":"m","diffstat":"1 file","warnings":[]}
    """ + "\n"

    let fd = connectTo(path)
    send(fd, line)
    while presented.value == false { try await Task.sleep(for: .milliseconds(20)) }
    close(fd)

    var waited = 0
    while withdrawn.value == false && waited < 200 {
        try await Task.sleep(for: .milliseconds(25))
        waited += 1
    }
    #expect(withdrawn.value)
    await listener.stop()
}

/// A flag two concurrency domains can set and read. `nonisolated(unsafe)` on a
/// `Bool` would be a data race; this is the smallest thing that is not.
private final class LockedFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var flag = false

    func set() {
        lock.lock()
        flag = true
        lock.unlock()
    }

    var value: Bool {
        lock.lock()
        defer { lock.unlock() }
        return flag
    }
}

/// A withdrawal is not a decision, so it is not recorded.
///
/// The journal answers a repeated request from its record without asking
/// anyone. A recorded `pending` would therefore answer the next ten minutes of
/// identical requests with a refusal nobody ever made — and the person would
/// never see the panel to disagree.
@Test func aWithdrawnApprovalIsNotRememberedAsADecision() async throws {
    let path = reviewScratchSocket()
    defer { removeScratch(path) }
    let asked = LockedCounter()
    let listener = Listener(
        socketPath: path,
        journal: Journal(),
        present: { _ in
            // First caller is withdrawn; the second is a real decision. Both
            // must reach here, which is the whole point.
            asked.increment()
            return asked.value == 1 ? .pending : .approved
        }
    )
    try await listener.start()

    let situation = Situation(
        repo: "/r", branch: "b", base: "d", head: "c", title: "t",
        commitMessage: "m", diffstat: "1 file", warnings: []
    )
    let line = """
    {"protocol":\(protocolVersion),"fingerprint":"\(fingerprint(situation))","repo":"/r","branch":"b",\
    "base":"d","head":"c","title":"t","commitMessage":"m","diffstat":"1 file","warnings":[]}
    """ + "\n"

    let first = connectTo(path)
    send(first, line)
    _ = readLine(first, seconds: 5)
    close(first)

    let second = connectTo(path)
    defer { close(second) }
    send(second, line)
    let answer = try #require(readLine(second, seconds: 5))

    #expect(asked.value == 2, "the second request was answered from the journal")
    #expect(answer.contains("\"decision\":\"approved\""))
    await listener.stop()
}

/// The opposite, so the test above cannot pass by the journal being broken:
/// a real decision *is* remembered, and the second request never reaches the
/// presenter.
@Test func arealDecisionIsStillRememberedForTheNextIdenticalRequest() async throws {
    let path = reviewScratchSocket()
    defer { removeScratch(path) }
    let asked = LockedCounter()
    let listener = Listener(
        socketPath: path,
        journal: Journal(),
        present: { _ in
            asked.increment()
            return .denied
        }
    )
    try await listener.start()

    let situation = Situation(
        repo: "/r", branch: "b", base: "d", head: "c", title: "t",
        commitMessage: "m", diffstat: "1 file", warnings: []
    )
    let line = """
    {"protocol":\(protocolVersion),"fingerprint":"\(fingerprint(situation))","repo":"/r","branch":"b",\
    "base":"d","head":"c","title":"t","commitMessage":"m","diffstat":"1 file","warnings":[]}
    """ + "\n"

    for _ in 0..<2 {
        let fd = connectTo(path)
        send(fd, line)
        _ = readLine(fd, seconds: 5)
        close(fd)
    }

    #expect(asked.value == 1)
    await listener.stop()
}

private final class LockedCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0

    func increment() {
        lock.lock()
        count += 1
        lock.unlock()
    }

    var value: Int {
        lock.lock()
        defer { lock.unlock() }
        return count
    }
}

/// A one-shot gate: a presenter waits on it, and the withdrawal opens it.
///
/// Stands in for a person who never presses a button, without a sleep that
/// would have to be long enough to be safe and would therefore be long enough
/// to slow every other test sharing the machine.
private actor Gate {
    private var opened = false
    private var waiting: [CheckedContinuation<Void, Never>] = []

    func wait() async {
        if opened { return }
        await withCheckedContinuation { waiting.append($0) }
    }

    nonisolated func open() {
        Task { await self.release() }
    }

    private func release() {
        opened = true
        for continuation in waiting { continuation.resume() }
        waiting = []
    }
}
