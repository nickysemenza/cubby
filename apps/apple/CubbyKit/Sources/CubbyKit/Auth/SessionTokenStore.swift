import Foundation

/// Persists the credential CubbyAuthMiddleware injects on outgoing requests, keyed by host so a
/// dev token (`localhost:3000`) and a prod token (`cubby.example`) can coexist without
/// clobbering each other.
public protocol SessionTokenStore: Sendable {
    func load(for host: String) throws -> CubbyCredential?
    func save(_ credential: CubbyCredential, for host: String) throws
    func clear(for host: String) throws
}

/// A `SessionTokenStore` backed by an in-memory dictionary, for tests and previews. Synchronous
/// and thread-safe: a plain `NSLock` around the dictionary is enough here — there's no I/O to
/// suspend on, so making this an actor would just add `await` at every call site for no benefit.
public final class InMemorySessionTokenStore: SessionTokenStore, @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [String: CubbyCredential] = [:]

    public init() {}

    public func load(for host: String) throws -> CubbyCredential? {
        lock.withLock { storage[host] }
    }

    public func save(_ credential: CubbyCredential, for host: String) throws {
        lock.withLock { storage[host] = credential }
    }

    public func clear(for host: String) throws {
        lock.withLock { _ = storage.removeValue(forKey: host) }
    }
}
