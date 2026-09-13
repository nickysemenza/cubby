import Foundation

/// A `SessionTokenStore` backed by one JSON file with owner-only permissions.
///
/// Used by the `cubby` CLI harness instead of the Keychain: `swift run` rebuilds produce an
/// ad-hoc-signed binary whose code hash changes every time, and the login keychain treats each
/// hash as a new application, so every rebuild re-prompts and "Always Allow" never sticks. The
/// apps are signed with a stable team identity and keep using `KeychainSessionTokenStore`.
public final class FileSessionTokenStore: SessionTokenStore, Sendable {
    public let fileURL: URL

    public init(fileURL: URL) {
        self.fileURL = fileURL
    }

    /// `~/Library/Application Support/Cubby/credentials.json`.
    public static func standard() -> FileSessionTokenStore {
        FileSessionTokenStore(
            fileURL: URL.applicationSupportDirectory.appending(path: "Cubby/credentials.json"))
    }

    public func load(for host: String) throws -> CubbyCredential? {
        try read()[host]
    }

    public func save(_ credential: CubbyCredential, for host: String) throws {
        var all = try read()
        all[host] = credential
        try write(all)
    }

    public func clear(for host: String) throws {
        var all = try read()
        all.removeValue(forKey: host)
        try write(all)
    }

    private func read() throws -> [String: CubbyCredential] {
        guard FileManager.default.fileExists(atPath: fileURL.path(percentEncoded: false)) else { return [:] }
        return try JSONDecoder().decode([String: CubbyCredential].self, from: Data(contentsOf: fileURL))
    }

    private func write(_ all: [String: CubbyCredential]) throws {
        let directory = fileURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(
            at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let data = try JSONEncoder().encode(all)
        try data.write(to: fileURL, options: .atomic)
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o600], ofItemAtPath: fileURL.path(percentEncoded: false))
    }
}
