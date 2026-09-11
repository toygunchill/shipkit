import Foundation

public let protocolVersion = 1

public struct Warning: Codable, Equatable, Sendable {
    public let check: String
    public let message: String

    public init(check: String, message: String) {
        self.check = check
        self.message = message
    }
}

/// One request per connection, exactly as `src/approval/protocol.ts` emits it.
public struct ApprovalRequest: Codable, Equatable, Sendable {
    public let protocolVersion: Int
    public let fingerprint: String
    public let repo: String
    public let branch: String
    public let base: String
    public let head: String
    public let title: String
    public let commitMessage: String
    public let diffstat: String
    public let warnings: [Warning]

    // `protocol` is a Swift keyword. Without this mapping the decoder quietly
    // finds no version at all and every request looks like a version mismatch.
    enum CodingKeys: String, CodingKey {
        case protocolVersion = "protocol"
        case fingerprint, repo, branch, base, head, title, commitMessage, diffstat, warnings
    }
}

public enum Decision: String, Codable, Sendable {
    case approved, denied, pending
}

public struct ApprovalResponse: Codable, Equatable, Sendable {
    public let protocolVersion: Int
    public let fingerprint: String
    public let decision: Decision

    public init(protocolVersion: Int, fingerprint: String, decision: Decision) {
        self.protocolVersion = protocolVersion
        self.fingerprint = fingerprint
        self.decision = decision
    }

    enum CodingKeys: String, CodingKey {
        case protocolVersion = "protocol"
        case fingerprint, decision
    }
}

public func decodeRequest(_ line: Data) throws -> ApprovalRequest {
    try JSONDecoder().decode(ApprovalRequest.self, from: line)
}

public func encodeResponse(_ response: ApprovalResponse) throws -> Data {
    var data = try JSONEncoder().encode(response)
    data.append(0x0A)
    return data
}
