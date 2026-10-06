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

    public func loadState(for host: String) throws -> CubbyAuthState? {
        try read()?[host]
    }

    public func saveState(_ state: CubbyAuthState, for host: String) throws {
        var all = try read() ?? [:]
        all[host] = state
        try write(all)
    }

    public func clear(for host: String) throws {
        guard var all = try read() else {
            try FileManager.default.removeItem(at: fileURL)
            return
        }
        all.removeValue(forKey: host)
        try write(all)
    }

    /// `nil` when the file exists but holds no current-format entry: not a JSON object, or the
    /// retired `[host: CubbyCredential]` shape (no entry carries `version`). It reads as signed
    /// out, `saveState` overwrites it, and `clear` deletes it, so a stale file costs one sign-in
    /// rather than making every load, save, and clear throw. Otherwise each host decodes on its
    /// own and only a malformed entry is dropped, so one bad host never signs out the others.
    private func read() throws -> [String: CubbyAuthState]? {
        guard FileManager.default.fileExists(atPath: fileURL.path(percentEncoded: false)) else { return [:] }
        let data = try Data(contentsOf: fileURL)
        guard let entries = try? JSONDecoder().decode([String: StoredEntry].self, from: data),
            entries.values.contains(where: \.hasVersion)
        else { return nil }
        return entries.compactMapValues(\.state)
    }

    private func write(_ all: [String: CubbyAuthState]) throws {
        let directory = fileURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(
            at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let data = try JSONEncoder().encode(all)
        try data.write(to: fileURL, options: .atomic)
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o600], ofItemAtPath: fileURL.path(percentEncoded: false))
    }
}

/// One host's entry, decoded without throwing so a malformed host cannot fail the whole file.
private struct StoredEntry: Decodable {
    private enum ProbeKey: String, CodingKey { case version }

    let hasVersion: Bool
    let state: CubbyAuthState?

    init(from decoder: any Decoder) {
        hasVersion = (try? decoder.container(keyedBy: ProbeKey.self))?.contains(.version) ?? false
        state = try? CubbyAuthState(from: decoder)
    }
}
