import Foundation
import OpenAPIRuntime

/// ISO-8601 transcoding that accepts both `2026-01-01T00:00:00.000Z` (what the API emits: JS
/// `Date.toISOString()` always carries milliseconds) and the plain `2026-01-01T00:00:00Z`.
/// OpenAPIRuntime's default transcoder rejects fractional seconds, and its fractional variant
/// rejects their absence, so the generated client failed on every product detail until this.
public struct LenientISO8601DateTranscoder: DateTranscoder, Sendable {
    private let fractional = ISO8601DateTranscoder(options: [.withInternetDateTime, .withFractionalSeconds])
    private let plain = ISO8601DateTranscoder(options: [.withInternetDateTime])

    public init() {}

    public func encode(_ date: Date) throws -> String {
        try fractional.encode(date)
    }

    public func decode(_ dateString: String) throws -> Date {
        if let date = try? fractional.decode(dateString) { return date }
        return try plain.decode(dateString)
    }
}

extension Configuration {
    /// The configuration every generated `Client` in CubbyKit must be built with.
    public static let cubby = Configuration(dateTranscoder: LenientISO8601DateTranscoder())
}

extension JSONDecoder {
    /// A decoder that parses dates the way the generated client does; tests and previews use it
    /// so a fixture that decodes here also decodes in production.
    public static func cubby() -> JSONDecoder {
        let decoder = JSONDecoder()
        let transcoder = LenientISO8601DateTranscoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            return try transcoder.decode(try container.decode(String.self))
        }
        return decoder
    }
}
