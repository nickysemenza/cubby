import CubbyAPISupport
import Foundation

public typealias JSONValue = CubbyAPISupport.JSONValue

// MARK: - Projection from typed values

extension JSONValue {
    /// Projects a decoded wire value into the dynamic tree `EntityRow.raw` exposes, using the
    /// same date spelling the client decodes, so `EntityFieldValue` still parses timestamps. A typed
    /// value's absent optionals become absent keys (the wire sent `null`; consumers treat the
    /// two alike).
    public init<T: Encodable>(encoding value: T) throws {
        self = try JSONValueCoders.plainDecoder.decode(
            JSONValue.self, from: JSONValueCoders.encoder.encode(value))
    }

    /// The dynamic tree read back as a typed value, with the client's date spelling. Rows,
    /// field resolutions and request bodies cross this boundary per rendered field, so the
    /// coders are shared rather than built per call.
    public func decoded<T: Decodable>(_ type: T.Type = T.self) throws -> T {
        try JSONValueCoders.decoder.decode(T.self, from: JSONValueCoders.encoder.encode(self))
    }
}

/// Coders configured once: `JSONEncoder`/`JSONDecoder` are `Sendable` and hold no per-call state.
private enum JSONValueCoders {
    static let encoder = JSONEncoder.cubby()
    static let decoder = JSONDecoder.cubby()
    static let plainDecoder = JSONDecoder()
}
