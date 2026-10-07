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
    ///
    /// A vendor may redirect the request (another host spelling, a sign-in page, its home page),
    /// so the page never reaches the target URL. A complete document that has held the same URL
    /// for `settledProbes` consecutive probes is where the navigation landed; the server reads
    /// the served URL and decides what that page means.
    /// `leavingPreviousDocument`: the probe read the document shown before the navigation was
    /// requested, so the navigation has not committed yet, whatever its URL and state.
    public static func isReady(
        currentURL: URL?, targetURL: URL?, documentReadyState: String, stableProbes: Int = 0,
        leavingPreviousDocument: Bool = false
    ) -> Bool {
        guard documentReadyState == "complete", !leavingPreviousDocument else { return false }
        return !shouldNavigate(currentURL: currentURL, targetURL: targetURL)
            || stableProbes >= settledProbes
    }

    /// Two seconds of probes: long enough that a navigation still starting is not mistaken for
    /// the old document settling.
    public static let settledProbes = 8
}
