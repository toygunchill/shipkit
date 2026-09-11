import Foundation
import Testing
@testable import ShipkitKit

// A service name nothing else uses, so a failed run cannot collide with the
// real "shipkit" item or with another test run.
private let testService = "shipkit-test-\(UUID().uuidString)"

// Swift Testing runs tests in a suite concurrently by default. Four tests
// sharing one account raced on the same keychain item -- duplicate-item
// errors on `swift test`, and once a hang on a live SecurityAgent prompt. A
// fresh UUID account per test function makes them genuinely independent
// rather than dependent on `--no-parallel` to serialize them.

@Test func readsNilWhenTheItemIsAbsent() throws {
    let keychain = Keychain(service: testService)
    #expect(try keychain.read(account: UUID().uuidString) == nil)
}

@Test func writesThenReadsBackTheSameSecret() throws {
    let keychain = Keychain(service: testService)
    let account = UUID().uuidString
    defer { try? keychain.delete(account: account) }

    try keychain.write("s3cret", account: account)
    #expect(try keychain.read(account: account) == "s3cret")
}

@Test func replacesAnExistingSecret() throws {
    let keychain = Keychain(service: testService)
    let account = UUID().uuidString
    defer { try? keychain.delete(account: account) }

    try keychain.write("first", account: account)
    try keychain.write("second", account: account)
    #expect(try keychain.read(account: account) == "second")
}

@Test func deletingAnAbsentItemIsNotAnError() throws {
    let keychain = Keychain(service: testService)
    #expect(throws: Never.self) { try keychain.delete(account: UUID().uuidString) }
}

@Test func deleteRemovesIt() throws {
    let keychain = Keychain(service: testService)
    let account = UUID().uuidString
    try keychain.write("gone-soon", account: account)
    try keychain.delete(account: account)
    #expect(try keychain.read(account: account) == nil)
}

@Test func handlesANonAsciiSecret() throws {
    let keychain = Keychain(service: testService)
    let account = UUID().uuidString
    defer { try? keychain.delete(account: account) }

    try keychain.write("şifre-🎉", account: account)
    #expect(try keychain.read(account: account) == "şifre-🎉")
}