import Foundation

/// Versioned authentication state for one Cubby host. The signed session-data cookie is a
/// Better Auth cache, not authority: the bearer token remains the credential on every request.
public struct CubbyAuthState: Sendable, Equatable, Codable {
    public let version: Int
    public var credential: CubbyCredential
    public var sessionDataCookies: [String: String]
    public var freshReadUntil: Date?

    public init(
        credential: CubbyCredential,
        sessionDataCookies: [String: String] = [:],
        freshReadUntil: Date? = nil
    ) {
        self.version = 1
        self.credential = credential
        self.sessionDataCookies = sessionDataCookies
        self.freshReadUntil = freshReadUntil
    }
}

/// Persists the credential CubbyAuthMiddleware injects on outgoing requests, keyed by host so a
/// dev token (`localhost:3000`) and a prod token (`cubby.example`) can coexist without
/// clobbering each other.
public protocol SessionTokenStore: Sendable {
    func loadState(for host: String) throws -> CubbyAuthState?
    func saveState(_ state: CubbyAuthState, for host: String) throws
    func clear(for host: String) throws
}

extension SessionTokenStore {
    public func load(for host: String) throws -> CubbyCredential? {
        try loadState(for: host)?.credential
    }

    public func save(_ credential: CubbyCredential, for host: String) throws {
        try saveState(CubbyAuthState(credential: credential), for: host)
    }
}

/// A `SessionTokenStore` backed by an in-memory dictionary, for tests and previews. Synchronous
/// and thread-safe: a plain `NSLock` around the dictionary is enough here — there's no I/O to
/// suspend on, so making this an actor would just add `await` at every call site for no benefit.
public final class InMemorySessionTokenStore: SessionTokenStore, @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [String: CubbyAuthState] = [:]

    public init() {}

    public func loadState(for host: String) throws -> CubbyAuthState? {
        lock.withLock { storage[host] }
    }

    public func saveState(_ state: CubbyAuthState, for host: String) throws {
        lock.withLock { storage[host] = state }
    }

    public func clear(for host: String) throws {
        lock.withLock { _ = storage.removeValue(forKey: host) }
    }
}
