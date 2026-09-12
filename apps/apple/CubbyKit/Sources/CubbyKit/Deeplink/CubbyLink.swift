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
public enum CubbyLink: Sendable, Hashable {
    case entity(EntityKey, id: String)
    case capture(location: LocationCode?)
    case audit(location: LocationCode?)
    case today

    public static let scheme = "cubby"

    public init?(url: URL) {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
            components.scheme?.lowercased() == Self.scheme,
            let host = components.host?.lowercased()
        else { return nil }
        let segments = components.path.split(separator: "/").map(String.init)
        let location = components.queryItems?.first { $0.name == "location" }?.value
        switch (host, segments.count) {
        case ("entity", 1):
            guard let parsed = Shortcode.parse(segments[0]) else { return nil }
            self = .entity(parsed.key, id: parsed.code)
        case ("capture", 0):
            guard let scope = Self.locationScope(location) else { return nil }
            self = .capture(location: scope)
        case ("audit", 0):
            guard let scope = Self.locationScope(location) else { return nil }
            self = .audit(location: scope)
        case ("today", 0):
            self = .today
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
        case .today:
            components.host = "today"
        }
        // Every component above is scheme-safe ASCII, so this cannot fail.
        return components.url!
    }

    /// Absent → `.some(nil)` (unscoped); a location shortcode → `.some(code)`; anything else →
    /// `nil`, so the whole link is rejected rather than silently dropping the scope.
    private static func locationScope(_ raw: String?) -> LocationCode?? {
        guard let raw else { return .some(nil) }
        guard let parsed = Shortcode.parse(raw), parsed.key == .location else { return nil }
        return .some(LocationCode(parsed.code))
    }
}
