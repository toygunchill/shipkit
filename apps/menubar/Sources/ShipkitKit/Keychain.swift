import Foundation
import Security

public enum KeychainError: Error, Equatable {
    case status(OSStatus)
}

/// The generic-password item `src/secrets/keychain.ts` reads with
/// `/usr/bin/security find-generic-password -s shipkit -a jira -w`. The service
/// and account must match that command exactly or the token is written where
/// nothing looks for it.
public struct Keychain: Sendable {
    private let service: String

    public init(service: String = "shipkit") {
        self.service = service
    }

    private func query(account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    /// `nil` when the item is absent — the ordinary state of a machine where
    /// nobody has saved a token, and not a fault.
    public func read(account: String) throws -> String? {
        var request = query(account: account)
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne

        var item: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw KeychainError.status(status) }
        guard let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    public func write(_ secret: String, account: String) throws {
        let data = Data(secret.utf8)
        let update: [String: Any] = [kSecValueData as String: data]

        let updated = SecItemUpdate(query(account: account) as CFDictionary, update as CFDictionary)
        if updated == errSecSuccess { return }
        guard updated == errSecItemNotFound else { throw KeychainError.status(updated) }

        var insert = query(account: account)
        insert[kSecValueData as String] = data
        // After first unlock rather than when-unlocked: the agent that reads this
        // may be running while the screen is locked.
        insert[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock

        let added = SecItemAdd(insert as CFDictionary, nil)
        guard added == errSecSuccess else { throw KeychainError.status(added) }
    }

    public func delete(account: String) throws {
        let status = SecItemDelete(query(account: account) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainError.status(status)
        }
    }
}
