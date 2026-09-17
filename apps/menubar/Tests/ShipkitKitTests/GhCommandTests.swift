import Foundation
import Testing
@testable import ShipkitKit

// Never `gh`, never the network: the child here is /bin/sh, and what is under
// test is only what the runner does to a process that will not die politely.
@Test func aChildThatIgnoresSigtermIsKilledAndItsReadersReleased() async {
    let marker = "shipkit-test-sigterm-\(UInt32.random(in: 0..<UInt32.max))"
    let command = GhCommand(executablePath: "/bin/sh", timeoutSeconds: 1)
    let started = Date()
    let outcome = await command.run(["-c", "trap '' TERM; sleep 120 # \(marker)"])

    // The call must come back as a timeout, bounded by timeout + graces.
    #expect(outcome == .failure(.timedOut(seconds: 1)))
    #expect(Date().timeIntervalSince(started) < 10)

    // And the child must actually be gone. Before the SIGKILL escalation it
    // survived, held the pipe write ends open, and each timeout leaked two
    // permanently blocked reader threads on the same global pool the approval
    // listener's recv/send hop to — measured at +2 per timeout, none reclaimed.
    // Give SIGKILL's asynchronous delivery a moment before asserting.
    try? await Task.sleep(nanoseconds: 500_000_000)
    let check = Process()
    check.executableURL = URL(fileURLWithPath: "/usr/bin/pgrep")
    check.arguments = ["-f", marker]
    let out = Pipe()
    check.standardOutput = out
    try? check.run()
    check.waitUntilExit()
    let survivors = String(decoding: out.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        .trimmingCharacters(in: .whitespacesAndNewlines)
    #expect(survivors.isEmpty, "child outlived SIGKILL escalation: \(survivors)")
}
