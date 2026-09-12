import Foundation

/// The single owner of "which credential goes on the next request" for one base URL.
///
/// Reads through to the `SessionTokenStore` once, then serves the cached value; `set` and
/// `invalidate` write through. `CubbyAuthMiddleware` calls `invalidate()` on a 401 so the app
/// falls back to LoginView, and `AuthFlow` calls `set` after sign-in.
public actor CredentialProvider {
    public let host: String
    private let store: any SessionTokenStore
    private var cached: CubbyCredential??

    /// - Parameter host: the Keychain key. Use `CubbyBaseURL.host(of:)` so dev and prod tokens
    ///   never collide.
    public init(host: String, store: any SessionTokenStore) {
        self.host = host
        self.store = store
    }

    public func current() -> CubbyCredential? {
        if let cached { return cached }
        let loaded = try? store.load(for: host)
        cached = .some(loaded)
        return loaded
    }

    public func set(_ credential: CubbyCredential) throws {
        try store.save(credential, for: host)
        cached = .some(credential)
    }

    public func invalidate() {
        try? store.clear(for: host)
        cached = .some(nil)
    }
}

public enum CubbyBaseURL {
    /// `host:port` when a port is present, so `localhost:3000` and `localhost:8787` stay distinct.
    public static func host(of url: URL) -> String {
        let host = url.host() ?? "unknown"
        if let port = url.port { return "\(host):\(port)" }
        return host
    }
}
