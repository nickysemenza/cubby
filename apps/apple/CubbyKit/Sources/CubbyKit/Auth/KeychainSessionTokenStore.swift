import Foundation
import Security

/// A `SessionTokenStore` backed by the platform Keychain. Not unit-tested (Keychain access needs
/// an entitled, code-signed host); `InMemorySessionTokenStore` covers the store's contract.
///
/// Stored as a generic password: service is fixed, `account` is the host (so dev/prod tokens
/// coexist), and the credential is JSON-encoded into `kSecValueData`.
/// `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` keeps the item off backups/migrations and
/// unreadable before first unlock, while still allowing background refresh after that.
public final class KeychainSessionTokenStore: SessionTokenStore, Sendable {
    private static let service = "com.nickysemenza.cubby.session"

    public init() {}

    public func load(for host: String) throws -> CubbyCredential? {
        var query = Self.baseQuery(for: host)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)

        switch status {
        case errSecSuccess:
            guard let data = result as? Data else {
                throw KeychainError(status: status)
            }
            return try JSONDecoder().decode(CubbyCredential.self, from: data)
        case errSecItemNotFound:
            return nil
        default:
            throw KeychainError(status: status)
        }
    }

    public func save(_ credential: CubbyCredential, for host: String) throws {
        let data = try JSONEncoder().encode(credential)

        if try load(for: host) != nil {
            let query = Self.baseQuery(for: host)
            let update: [String: Any] = [kSecValueData as String: data]
            let status = SecItemUpdate(query as CFDictionary, update as CFDictionary)
            guard status == errSecSuccess else { throw KeychainError(status: status) }
            return
        }

        var attributes = Self.baseQuery(for: host)
        attributes[kSecValueData as String] = data
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(attributes as CFDictionary, nil)
        guard status == errSecSuccess else { throw KeychainError(status: status) }
    }

    public func clear(for host: String) throws {
        let query = Self.baseQuery(for: host)
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainError(status: status)
        }
    }

    private static func baseQuery(for host: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: host,
        ]
    }
}

public struct KeychainError: Error, Sendable {
    public let status: OSStatus

    public init(status: OSStatus) {
        self.status = status
    }
}
