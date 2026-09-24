import CubbyKit
import Foundation
import Security

protocol InstallationIDStore {
    func load() throws -> UUID?
    func save(_ id: UUID) throws
}

/// Keeps this physical device's app identity through an uninstall when the system preserves its
/// Keychain item. Device-only accessibility prevents a restored backup from cloning that identity
/// onto another phone or Mac.
private struct KeychainInstallationIDStore: InstallationIDStore {
    private let service = "com.nickysemenza.cubby.installation"
    private let account = "device-id"

    func load() throws -> UUID? {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        switch status {
        case errSecItemNotFound:
            return nil
        case errSecSuccess:
            guard let data = result as? Data,
                let value = String(data: data, encoding: .utf8),
                let id = UUID(uuidString: value)
            else {
                throw InstallationIDError.invalidKeychainValue
            }
            return id
        default:
            throw KeychainError(status: status)
        }
    }

    func save(_ id: UUID) throws {
        let data = Data(id.uuidString.lowercased().utf8)
        let query = baseQuery
        let update = [kSecValueData as String: data]
        let updateStatus = SecItemUpdate(query as CFDictionary, update as CFDictionary)
        if updateStatus == errSecSuccess { return }
        guard updateStatus == errSecItemNotFound else {
            throw KeychainError(status: updateStatus)
        }

        var attributes = baseQuery
        attributes[kSecValueData as String] = data
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(attributes as CFDictionary, nil)
        guard status == errSecSuccess else { throw KeychainError(status: status) }
    }

    private var baseQuery: [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        #if os(macOS)
            query[kSecUseDataProtectionKeychain as String] = true
        #endif
        return query
    }
}

private enum InstallationIDError: Error {
    case invalidKeychainValue
}

/// One app identity joins browser-import and image-processing activity for this device.
/// Existing browser installations win migration so server history keeps its established device.
enum AppInstallationID {
    private static let key = "cubby.installation.deviceID"
    private static let browserKey = "purchaseImport.browserBridge.deviceID"
    private static let imageWorkerKey = "cubby.companionImageProcessing.deviceID"

    static let current = current(in: .standard, store: KeychainInstallationIDStore())

    static func current(in defaults: UserDefaults, store: any InstallationIDStore) -> UUID {
        let keychainID: UUID?
        do {
            keychainID = try store.load()
        } catch {
            Diagnostics.report(error, context: "installation-id.keychain.load")
            keychainID = nil
        }
        let value =
            id(for: browserKey, in: defaults)
            ?? id(for: key, in: defaults)
            ?? id(for: imageWorkerKey, in: defaults)
            ?? keychainID
            ?? UUID()
        if keychainID != value {
            do {
                try store.save(value)
            } catch {
                Diagnostics.report(error, context: "installation-id.keychain.save")
            }
        }
        let encoded = value.uuidString.lowercased()
        defaults.set(encoded, forKey: key)
        defaults.set(encoded, forKey: browserKey)
        defaults.set(encoded, forKey: imageWorkerKey)
        return value
    }

    private static func id(for key: String, in defaults: UserDefaults) -> UUID? {
        defaults.string(forKey: key).flatMap(UUID.init(uuidString:))
    }
}
