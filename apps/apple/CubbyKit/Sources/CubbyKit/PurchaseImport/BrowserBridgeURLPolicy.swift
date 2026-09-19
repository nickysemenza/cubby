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
