import Foundation
import Testing
@testable import ShipkitKit

@Test func decodesTheRequestTheNodeClientSends() throws {
    // Copied from src/approval/protocol.ts's own shape. If this drifts, the two
    // halves stop speaking and nothing else in this package can be trusted.
    let line = Data("""
    {"protocol":1,"fingerprint":"abc","repo":"/r","branch":"b","base":"d",\
    "head":"c","title":"t","commitMessage":"m","diffstat":"1 file",\
    "warnings":[{"check":"blocking-label","message":"in test"}]}
    """.utf8)

    let request = try decodeRequest(line)

    #expect(request.protocolVersion == 1)
    #expect(request.fingerprint == "abc")
    #expect(request.title == "t")
    #expect(request.commitMessage == "m")
    #expect(request.diffstat == "1 file")
    #expect(request.warnings.map(\.check) == ["blocking-label"])
}

@Test func rejectsARequestMissingAField() {
    let line = Data(#"{"protocol":1,"fingerprint":"abc"}"#.utf8)
    #expect(throws: (any Error).self) { try decodeRequest(line) }
}

@Test func encodesAResponseAsOneNewlineTerminatedLine() throws {
    let data = try encodeResponse(
        ApprovalResponse(protocolVersion: 1, fingerprint: "abc", decision: .approved)
    )
    let text = String(decoding: data, as: UTF8.self)

    #expect(text.hasSuffix("\n"))
    #expect(text.dropLast().contains("\n") == false)
    // The Node side reads the key `protocol`, not `protocolVersion`.
    #expect(text.contains("\"protocol\":1"))
    #expect(text.contains("\"decision\":\"approved\""))
}

@Test func roundTripsEveryDecision() throws {
    for decision in [Decision.approved, .denied, .pending] {
        let data = try encodeResponse(
            ApprovalResponse(protocolVersion: 1, fingerprint: "f", decision: decision)
        )
        #expect(String(decoding: data, as: UTF8.self).contains(decision.rawValue))
    }
}
