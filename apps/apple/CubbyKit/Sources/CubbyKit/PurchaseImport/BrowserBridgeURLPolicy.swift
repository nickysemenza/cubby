import Foundation

public enum BrowserBridgeURLPolicy {
    public enum Failure: Error, Equatable, Sendable {
        case httpsRequired
        case credentialsForbidden
        case hostMissing
        case hostNotAllowed
        case fragmentForbidden
    }

    /// Browser commands accept only ordinary HTTPS pages on an explicitly allowed host. Host
    /// matching is exact or a subdomain boundary match; `notexample.com` never matches
    /// `example.com`. Credentials and fragments are rejected to avoid smuggling secrets or
    /// client-side commands in an otherwise valid URL.
    public static func validate(_ url: URL, allowedHosts: Set<String>) throws -> URL {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
            components.scheme?.lowercased() == "https"
        else { throw Failure.httpsRequired }
        guard components.user == nil, components.password == nil else {
            throw Failure.credentialsForbidden
        }
        guard components.fragment == nil else { throw Failure.fragmentForbidden }
        guard let host = components.host?.lowercased(), !host.isEmpty else { throw Failure.hostMissing }
        let normalized = Set(
            allowedHosts.map { $0.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: ".")) })
        guard normalized.contains(where: { host == $0 || host.hasSuffix("." + $0) }) else {
            throw Failure.hostNotAllowed
        }
        return url
    }
}

public enum BrowserCaptureNavigationPolicy {
    /// A capture target is authoritative. Reusing an already-owned window is safe only when it
    /// is still showing that exact target; navigating to an unchanged target would reload the
    /// page and can turn a replayed capture command into a refresh loop.
    public static func shouldNavigate(currentURL: URL?, targetURL: URL?) -> Bool {
        guard let targetURL else { return false }
        guard let currentURL else { return true }
        return currentURL.absoluteString != targetURL.absoluteString
    }

    /// Setting a browser tab URL returns before the new document necessarily starts loading. A
    /// stale document can therefore still report `complete`; require both the requested URL and
    /// the new document's ready state before capture associates evidence with that target.
    public static func isReady(
        currentURL: URL?, targetURL: URL?, documentReadyState: String
    ) -> Bool {
        guard documentReadyState == "complete" else { return false }
        return !shouldNavigate(currentURL: currentURL, targetURL: targetURL)
    }
}
