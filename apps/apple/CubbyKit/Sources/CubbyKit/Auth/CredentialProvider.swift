import Foundation

/// The single owner of "which credential goes on the next request" for one base URL.
///
/// Reads through to the `SessionTokenStore` once, then serves the cached value; `set` and
/// `invalidate` write through. `CubbyAuthMiddleware` calls `invalidate()` on a 401 so the app
/// falls back to LoginView, and `AuthFlow` calls `set` after sign-in.
public actor CredentialProvider {
    public let host: String
    private let store: any SessionTokenStore
    private var cached: CubbyAuthState??

    /// - Parameter host: the Keychain key. Use `CubbyBaseURL.host(of:)` so dev and prod tokens
    ///   never collide.
    public init(host: String, store: any SessionTokenStore) {
        self.host = host
        self.store = store
    }

    public func current() -> CubbyCredential? {
        currentState()?.credential
    }

    func currentState() -> CubbyAuthState? {
        if let cached { return cached }
        let loaded = try? store.loadState(for: host)
        cached = .some(loaded)
        return loaded
    }

    public func set(_ credential: CubbyCredential) throws {
        let state = CubbyAuthState(credential: credential)
        try store.saveState(state, for: host)
        cached = .some(state)
    }

    func updateSessionDataCookies(from setCookieHeaders: [String]) {
        guard var state = currentState(), case .bearer = state.credential else { return }
        let cookies = Self.sessionDataCookies(from: setCookieHeaders)
        guard cookies.sawSessionDataCookie else { return }
        state.sessionDataCookies = cookies.values
        try? store.saveState(state, for: host)
        cached = .some(state)
    }

    private static func sessionDataCookies(from headers: [String]) -> (
        sawSessionDataCookie: Bool, values: [String: String]
    ) {
        var sawSessionDataCookie = false
        var values: [String: String] = [:]
        for header in headers {
            let pair = header.split(separator: ";", maxSplits: 1)[0]
            let parts = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            guard parts.count == 2 else { continue }
            let name = String(parts[0]).trimmingCharacters(in: .whitespaces)
            guard isSessionDataCookieName(name) else { continue }
            sawSessionDataCookie = true
            let deleting = header.range(of: "max-age=0", options: .caseInsensitive) != nil
            if !deleting && !parts[1].isEmpty { values[name] = String(parts[1]) }
        }
        return (sawSessionDataCookie, values)
    }

    private static func isSessionDataCookieName(_ name: String) -> Bool {
        let normalized = name.hasPrefix("__Secure-") ? String(name.dropFirst(9)) : name
        let base = "better-auth.session_data"
        guard normalized == base || normalized.hasPrefix("\(base).") else { return false }
        guard normalized.count > base.count else { return true }
        return normalized.dropFirst(base.count + 1).allSatisfy(\.isNumber)
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
