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
/// - `cubby://activity` opens Activity; `cubby://activity/<IPR-…|RUN-…>` opens that Image job or
///   Run beside it (both are catalog entities; the prefix chooses the detail).
/// - `cubby://activity/local/<id>` opens one running device-local activity.
/// - `cubby://cli-auth?port=<port>&nonce=<nonce>` asks the app to hand its session to a waiting
///   `cubby auth login` loopback listener. The nonce authenticates that listener; the app
///   confirms with the user before sending anything.
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
    case activity(run: String?)
    case localActivity(String)
    case cliAuth(port: UInt16, nonce: String)

    public static let scheme = AppleAppIdentity.current.callbackScheme

    public init?(url: URL, appIdentity: AppleAppIdentity = .current) {
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

        guard scheme == appIdentity.callbackScheme, let host = components.host?.lowercased() else {
            return nil
        }
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
        case ("activity", 0):
            self = .activity(run: nil)
        case ("activity", 1):
            guard let run = Self.activityRunID(segments[0]) else { return nil }
            self = .activity(run: run)
        case ("activity", 2):
            guard segments[0] == "local", let id = Self.localActivityID(segments[1]) else { return nil }
            self = .localActivity(id)
        case ("cli-auth", 0):
            guard let request = Self.cliAuthRequest(queryItems: components.queryItems) else { return nil }
            self = .cliAuth(port: request.port, nonce: request.nonce)
        default:
            return nil
        }
    }

    /// An Image job (`IPR-…`) or Run (`RUN-…`) shortcode, uppercased; the Activity link accepts
    /// only these two entities, so it validates their prefixes directly.
    private static func activityRunID(_ raw: String) -> String? {
        let value = raw.trimmingCharacters(in: .whitespaces).uppercased()
        for prefix in ["IPR-", "RUN-"] {
            guard value.hasPrefix(prefix) else { continue }
            let body = value.dropFirst(prefix.count)
            guard !body.isEmpty, body.allSatisfy({ $0.isASCII && ($0.isNumber || $0.isUppercase) })
            else { return nil }
            return value
        }
        return nil
    }

    private static func localActivityID(_ raw: String) -> String? {
        guard !raw.isEmpty, raw.count <= 100,
            raw.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-") })
        else { return nil }
        return raw
    }

    /// A `cli-auth` link carries exactly one numeric port and one nonce. Anything else is a
    /// malformed link, not a partial handoff request.
    static func cliAuthRequest(queryItems: [URLQueryItem]?) -> CliAuthRequest? {
        func singleValue(_ name: String) -> String? {
            let matches = (queryItems ?? []).filter { $0.name == name }
            return matches.count == 1 ? matches[0].value : nil
        }
        guard let portRaw = singleValue("port"), let port = UInt16(portRaw), port != 0,
            let nonce = singleValue("nonce"), CliAuthRequest.isValidNonce(nonce)
        else { return nil }
        return CliAuthRequest(port: port, nonce: nonce)
    }

    public var url: URL {
        url(appIdentity: .current)
    }

    public func url(appIdentity: AppleAppIdentity) -> URL {
        var components = URLComponents()
        components.scheme = appIdentity.callbackScheme
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
        case .activity(let run):
            components.host = "activity"
            components.path = run.map { "/\($0)" } ?? ""
        case .localActivity(let id):
            components.host = "activity"
            components.path = "/local/\(id)"
        case .cliAuth(let port, let nonce):
            components.host = "cli-auth"
            components.queryItems = [
                URLQueryItem(name: "port", value: String(port)),
                URLQueryItem(name: "nonce", value: nonce),
            ]
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
