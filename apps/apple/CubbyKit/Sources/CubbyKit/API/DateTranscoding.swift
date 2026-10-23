import Foundation

/// Accept the API's fractional ISO-8601 timestamps and timestamps without fractions.
public struct LenientISO8601DateTranscoder: Sendable {
    private let fractional = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
    private let plain = Date.ISO8601FormatStyle(includingFractionalSeconds: false)

    public init() {}

    public func encode(_ date: Date) throws -> String {
        fractional.format(date)
    }

    public func decode(_ dateString: String) throws -> Date {
        if let date = try? fractional.parse(dateString) { return date }
        return try plain.parse(dateString)
    }
}

extension JSONDecoder {
    /// The shared native wire decoder; tests and previews use it
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

extension JSONEncoder {
    /// An encoder that emits dates exactly as the API does (`…T00:00:00.000Z`), so a typed
    /// value re-encoded into a `JSONValue` carries the same timestamp text the raw wire did.
    public static func cubby() -> JSONEncoder {
        let encoder = JSONEncoder()
        let transcoder = LenientISO8601DateTranscoder()
        encoder.dateEncodingStrategy = .custom { date, encoder in
            var container = encoder.singleValueContainer()
            try container.encode(try transcoder.encode(date))
        }
        return encoder
    }
}
