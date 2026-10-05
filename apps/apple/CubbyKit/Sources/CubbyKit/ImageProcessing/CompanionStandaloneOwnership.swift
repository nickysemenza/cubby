import Foundation

#if canImport(Darwin)
    import Darwin
#endif

/// One standalone companion process per outbox. `CompanionResultOutbox` caches and rewrites its
/// whole file, so two processes sharing one would let either erase the other's unacknowledged
/// result. The `flock` is released when the descriptor closes, including when the process dies.
public final class CompanionOwnerLock: Sendable {
    public enum Failure: Error, CustomStringConvertible {
        case held(path: String)
        case open(path: String, errno: Int32)

        public var description: String {
            switch self {
            case .held(let path): "another companion process holds \(path)"
            case .open(let path, let code): "cannot open \(path): \(String(cString: strerror(code)))"
            }
        }
    }

    private let descriptor: Int32

    private init(descriptor: Int32) { self.descriptor = descriptor }

    deinit { close(descriptor) }

    public static func acquire(at url: URL) throws -> CompanionOwnerLock {
        let path = url.path(percentEncoded: false)
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let descriptor = open(path, O_RDWR | O_CREAT | O_CLOEXEC, 0o600)
        guard descriptor >= 0 else { throw Failure.open(path: path, errno: errno) }
        guard flock(descriptor, LOCK_EX | LOCK_NB) == 0 else {
            close(descriptor)
            throw Failure.held(path: path)
        }
        return CompanionOwnerLock(descriptor: descriptor)
    }

    /// Releases the lock before deinit (the descriptor still closes then).
    public func release() { flock(descriptor, LOCK_UN) }
}

/// A standalone companion's stable device id, minted once per file. Creation is exclusive: the
/// complete id is written to a private temporary file and hard-linked into place, which fails if
/// another process won, so every starter reads the same id. A file that exists but is unreadable
/// or not a UUID is an error, never silently replaced (that would register a new device).
public enum CompanionDeviceIdentity {
    public static func loadOrCreate(at url: URL) throws -> UUID {
        if let existing = try load(url) { return existing }
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let candidate = UUID()
        let staging = url.deletingLastPathComponent().appendingPathComponent(
            ".\(url.lastPathComponent).\(UUID().uuidString)")
        try Data(candidate.uuidString.lowercased().utf8).write(to: staging, options: .withoutOverwriting)
        defer { try? FileManager.default.removeItem(at: staging) }
        if link(staging.path(percentEncoded: false), url.path(percentEncoded: false)) == 0 {
            return candidate
        }
        let code = errno
        guard code == EEXIST, let winner = try load(url) else {
            throw CocoaError(
                .fileWriteUnknown, userInfo: [NSUnderlyingErrorKey: POSIXError(.init(rawValue: code) ?? .EIO)]
            )
        }
        return winner
    }

    private static func load(_ url: URL) throws -> UUID? {
        let text: String
        do {
            text = try String(contentsOf: url, encoding: .utf8)
        } catch CocoaError.fileReadNoSuchFile {
            return nil
        }
        guard let id = UUID(uuidString: text.trimmingCharacters(in: .whitespacesAndNewlines)) else {
            throw CocoaError(
                .fileReadCorruptFile,
                userInfo: [NSFilePathErrorKey: url.path(percentEncoded: false)])
        }
        return id
    }
}
