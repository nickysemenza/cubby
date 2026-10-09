import Foundation

public enum BrowserBridgeURLPolicy {
    public enum Failure: Error, Equatable, Sendable {
        case httpsRequired
        case credentialsForbidden
        case hostMissing
        case hostNotAllowed
    }

    /// Browser commands accept only ordinary HTTPS pages on an explicitly allowed host. Host
    /// matching is exact or a subdomain boundary match; `notexample.com` never matches
    /// `example.com`. Credentials are rejected; fragments retain a rendered site's variant state.
    public static func validate(_ url: URL, allowedHosts: Set<String>) throws -> URL {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
            components.scheme?.lowercased() == "https"
        else { throw Failure.httpsRequired }
        guard components.user == nil, components.password == nil else {
            throw Failure.credentialsForbidden
        }
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
    /// Reads preserve the existing page, including a variant's changed URL. A recovery URL may
    /// create a missing account window; changing an existing target requires explicit navigation.
    public static func shouldNavigate(currentURL: URL?, targetURL: URL?) -> Bool {
        currentURL == nil && targetURL != nil
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
        return targetURL == nil || currentURL?.absoluteString == targetURL?.absoluteString
            || stableProbes >= settledProbes
    }

    /// Two seconds of probes: long enough that a navigation still starting is not mistaken for
    /// the old document settling.
    public static let settledProbes = 8
}
