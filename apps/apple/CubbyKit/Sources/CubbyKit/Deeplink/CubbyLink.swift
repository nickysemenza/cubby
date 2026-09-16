import Foundation

/// The `cubby://` URL scheme, as a value. Parsing and rendering are pure so intents, Spotlight
/// items, and the app shells all speak one dialect.
///
/// `cubby-mobile://` is a different string: it is the `Origin` Better Auth trusts for sign-in and
/// is never used as a link.
///
/// - `cubby://entity/<SHORTCODE>` opens any catalog entity; the kind comes from the prefix.
/// - `cubby://capture?location=LOC-…` opens Capture, optionally on a location.
/// - `cubby://audit?location=LOC-…` starts a walk, optionally scoped to a location.
/// - `cubby://today` opens Today.
/// - `cubby://search` opens the Search tab (home-screen quick action).
/// - `cubby://dev` opens the Dev screen.
///
/// A Universal Link also resolves: `https://<any host>/<SHORTCODE>` or
/// `https://<any host>/<anything>/<SHORTCODE>` (only the last path component is inspected) opens
/// that entity, provided the final segment is a valid shortcode. Host-agnostic because the app's
/// base URL is configurable while printed label QR codes always point at the prod host. Anything
/// else over http/https — a non-shortcode path, a bare host — returns nil.
public enum CubbyLink: Sendable, Hashable {
    case entity(EntityKey, id: String)
    case capture(location: LocationCode?)
    case audit(location: LocationCode?)
    case today
    case photos
    case identify
    case search
    case dev

    public static let scheme = "cubby"

    public init?(url: URL) {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
            let scheme = components.scheme?.lowercased()
        else { return nil }

        if scheme == "http" || scheme == "https" {
            guard let last = components.path.split(separator: "/").map(String.init).last,
                let label = CubbyLabel(last)
            else { return nil }
            self = .entity(label.key, id: label.code)
            return
        }

        guard scheme == Self.scheme, let host = components.host?.lowercased() else { return nil }
        let segments = components.path.split(separator: "/").map(String.init)
        let location = components.queryItems?.first { $0.name == "location" }?.value
        switch (host, segments.count) {
        case ("entity", 1):
            guard let label = CubbyLabel(segments[0]) else { return nil }
            self = .entity(label.key, id: label.code)
        case ("capture", 0):
            guard let scope = Self.locationScope(location) else { return nil }
            self = .capture(location: scope)
        case ("audit", 0):
            guard let scope = Self.locationScope(location) else { return nil }
            self = .audit(location: scope)
        case ("photos", 0):
            self = .photos
        case ("identify", 0):
            self = .identify
        case ("today", 0):
            self = .today
        case ("search", 0):
            self = .search
        case ("dev", 0):
            self = .dev
        default:
            return nil
        }
    }

    public var url: URL {
        var components = URLComponents()
        components.scheme = Self.scheme
        switch self {
        case .entity(_, let id):
            components.host = "entity"
            components.path = "/\(id)"
        case .capture(let location):
            components.host = "capture"
            components.queryItems = location.map { [URLQueryItem(name: "location", value: $0.rawValue)] }
        case .audit(let location):
            components.host = "audit"
            components.queryItems = location.map { [URLQueryItem(name: "location", value: $0.rawValue)] }
        case .photos:
            components.host = "photos"
        case .identify:
            components.host = "identify"
        case .today:
            components.host = "today"
        case .search:
            components.host = "search"
        case .dev:
            components.host = "dev"
        }
        // Every component above is scheme-safe ASCII, so this cannot fail.
        return components.url!
    }

    /// Absent → `.some(nil)` (unscoped); a location shortcode → `.some(code)`; anything else →
    /// `nil`, so the whole link is rejected rather than silently dropping the scope.
    private static func locationScope(_ raw: String?) -> LocationCode?? {
        guard let raw else { return .some(nil) }
        guard let label = CubbyLabel(raw), label.key == .location else { return nil }
        return .some(LocationCode(label.code))
    }
}
