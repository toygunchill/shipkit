import Foundation
import Testing
@testable import ShipkitKit

// A service name nothing else uses, so a failed run cannot collide with the
// real "shipkit" item or with another test run.
private let testService = "shipkit-test-\(UUID().uuidString)"

@Test func readsNilWhenTheItemIsAbsent() throws {
    let keychain = Keychain(service: testService)
    #expect(try keychain.read(account: "jira") == nil)
}

@Test func writesThenReadsBackTheSameSecret() throws {
    let keychain = Keychain(service: testService)
    defer { try? keychain.delete(account: "jira") }

    try keychain.write("s3cret", account: "jira")
    #expect(try keychain.read(account: "jira") == "s3cret")
}

@Test func replacesAnExistingSecret() throws {
    let keychain = Keychain(service: testService)
    defer { try? keychain.delete(account: "jira") }

    try keychain.write("first", account: "jira")
    try keychain.write("second", account: "jira")
    #expect(try keychain.read(account: "jira") == "second")
}

@Test func deletingAnAbsentItemIsNotAnError() throws {
    let keychain = Keychain(service: testService)
    #expect(throws: Never.self) { try keychain.delete(account: "jira") }
}

@Test func deleteRemovesIt() throws {
    let keychain = Keychain(service: testService)
    try keychain.write("gone-soon", account: "jira")
    try keychain.delete(account: "jira")
    #expect(try keychain.read(account: "jira") == nil)
}

@Test func handlesANonAsciiSecret() throws {
    let keychain = Keychain(service: testService)
    defer { try? keychain.delete(account: "jira") }

    try keychain.write("şifre-🎉", account: "jira")
    #expect(try keychain.read(account: "jira") == "şifre-🎉")
}