import Foundation

/// The single owner of "which credential goes on the next request" for one base URL.
///
/// Reads through to the `SessionTokenStore` once, then serves the cached value; `set` and
/// `invalidate` write through. Each outbound request captures a state snapshot, and a response
/// may affect authentication only while that snapshot remains current.
public actor CredentialProvider {
    public let host: String
    private let store: any SessionTokenStore
    private var cached: CubbyAuthState??
    private var revision = 0

    /// - Parameter host: the Keychain key. Use `CubbyBaseURL.host(of:)` so dev and prod tokens
    ///   never collide.
    public init(host: String, store: any SessionTokenStore) {
        self.host = host
        self.store = store
    }

    public func current() -> CubbyCredential? {
        currentState()?.credential
    }

    /// A replayable snapshot captured immediately before a request leaves the client.
    /// A response may change stored authentication only while this snapshot is current.
    struct RequestState: Sendable {
        let credential: CubbyCredential?
        let sessionDataCookies: [String: String]
        fileprivate let revision: Int
    }

    func currentState() -> CubbyAuthState? {
        if let cached { return cached }
        let loaded = try? store.loadState(for: host)
        cached = .some(loaded)
        return loaded
    }

    func requestState() -> RequestState {
        let state = currentState()
        return RequestState(
            credential: state?.credential,
            sessionDataCookies: state?.sessionDataCookies ?? [:],
            revision: revision
        )
    }

    public func set(_ credential: CubbyCredential) throws {
        let state = CubbyAuthState(credential: credential)
        try store.saveState(state, for: host)
        cached = .some(state)
        revision += 1
    }

    /// Stores a successful interactive sign-in only if nothing changed while it
    /// was in flight. A late sign-in response must not restore a signed-out or
    /// switched account.
    func completeSignIn(
        _ credential: CubbyCredential,
        for request: RequestState,
        setCookieHeaders: [String],
        responseURL: URL
    ) throws -> Bool {
        guard isCurrent(request) else { return false }
        var state = CubbyAuthState(credential: credential)
        Self.applySessionDataCookies(
            setCookieHeaders,
            responseURL: responseURL,
            to: &state
        )
        try store.saveState(state, for: host)
        cached = .some(state)
        revision += 1
        return true
    }

    /// Atomically applies one response to the credential that sent its request.
    /// Token rotation, signed session-data cookies, and 401 invalidation share
    /// this conditional so an older response cannot overwrite newer auth state.
    func processResponse(
        for request: RequestState,
        status: Int,
        setAuthToken: String?,
        setCookieHeaders: [String],
        responseURL: URL
    ) {
        guard isCurrent(request) else { return }
        if status == 401 {
            clearCurrentState()
            return
        }
        guard var state = currentState(), case .bearer = state.credential else { return }
        let previous = state

        if let setAuthToken, !setAuthToken.isEmpty {
            state.credential = .bearer(setAuthToken)
            if state.credential != previous.credential {
                state.sessionDataCookies = [:]
            }
        }
        Self.applySessionDataCookies(
            setCookieHeaders,
            responseURL: responseURL,
            to: &state
        )
        guard state != previous else { return }
        try? store.saveState(state, for: host)
        cached = .some(state)
        if state.credential != previous.credential { revision += 1 }
    }

    /// Sign-out owns its explicit clear, but only for the request's account.
    func invalidate(for request: RequestState) {
        guard isCurrent(request) else { return }
        clearCurrentState()
    }

    private func isCurrent(_ request: RequestState) -> Bool {
        revision == request.revision && currentState()?.credential == request.credential
    }

    private func clearCurrentState() {
        try? store.clear(for: host)
        cached = .some(nil)
        revision += 1
    }

    private static func applySessionDataCookies(
        _ headers: [String],
        responseURL: URL,
        to state: inout CubbyAuthState
    ) {
        let now = Date()
        for header in headers {
            let parsed = HTTPCookie.cookies(
                withResponseHeaderFields: ["Set-Cookie": header],
                for: responseURL
            )
            for cookie in parsed where isSessionDataCookieName(cookie.name) {
                if isDeletion(cookie, now: now) {
                    state.sessionDataCookies.removeValue(forKey: cookie.name)
                } else {
                    state.sessionDataCookies[cookie.name] = cookie.value
                }
            }
        }
    }

    private static func isSessionDataCookieName(_ name: String) -> Bool {
        let normalized = name.hasPrefix("__Secure-") ? String(name.dropFirst(9)) : name
        let base = "better-auth.session_data"
        guard normalized == base || normalized.hasPrefix("\(base).") else { return false }
        guard normalized.count > base.count else { return true }
        return normalized.dropFirst(base.count + 1).allSatisfy(\.isNumber)
    }

    private static func isDeletion(_ cookie: HTTPCookie, now: Date) -> Bool {
        if cookie.value.isEmpty { return true }
        if let maximumAge = cookie.properties?[.maximumAge],
            (Int(String(describing: maximumAge)) ?? 1) <= 0
        {
            return true
        }
        return cookie.expiresDate.map { $0 <= now } ?? false
    }

    public func invalidate() {
        clearCurrentState()
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
