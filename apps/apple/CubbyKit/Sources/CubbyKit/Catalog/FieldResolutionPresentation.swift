import Foundation

/// Presentation of the server's assignment result. Values, provenance and reset permission are never inferred on device.
public struct FieldResolutionPresentation: Sendable {
    public let resolution: FieldResolution
    public let effectiveValue: JSONValue
    public let storedValue: JSONValue
    public let fallbackValue: JSONValue

    public init?(raw: JSONValue, field: FieldDescriptor) {
        guard let projected = raw["fieldResolutions"]?[field.key],
            let data = try? JSONEncoder.cubby().encode(projected),
            let resolution = try? JSONDecoder.cubby().decode(FieldResolution.self, from: data)
        else { return nil }
        self.resolution = resolution
        effectiveValue = projected["value"] ?? .null
        storedValue = projected["storedValue"] ?? .null
        fallbackValue = projected["fallbackValue"] ?? .null
    }

    public var sourceEntity: FieldResolutionSource? { resolution.sourceEntity }

    public var sourceText: String {
        let mode: String
        switch resolution.mode {
        case .inherit: mode = "Inherited"
        case .explicit: mode = "Explicit"
        case .none: mode = "No value"
        case .allocated: mode = "Allocated"
        }
        return "\(mode) · \(resolution.source)"
    }

    public var resetLabel: String { fallbackValue == .null ? "Clear override" : "Use inherited value" }

    public func resetPayload(field: FieldDescriptor) -> [String: JSONValue]? {
        guard resolution.canReset else { return nil }
        return field.resolution?.reset
    }

    /// A declared display projection wins when present; older rows keep their own stored field.
    public static func readValue(in raw: JSONValue, field: FieldDescriptor, surface: String) -> JSONValue? {
        if let path = field.explanation?.projections[surface], let projected = value(at: path, in: raw) {
            return projected
        }
        return FieldResolutionPresentation(raw: raw, field: field)?.effectiveValue ?? raw[field.key]
    }

    /// Projected names may belong to a stored target. Never attach that name to a different effective id.
    public static func referenceName(in raw: JSONValue, field: FieldDescriptor, effectiveID: String)
        -> String?
    {
        let stem = field.key.hasSuffix("Id") ? String(field.key.dropLast(2)) : field.key
        if raw[field.key]?.stringValue == effectiveID {
            if let name = raw["\(stem)Name"]?.stringValue { return name }
            if raw[stem]?["id"]?.stringValue == effectiveID { return raw[stem]?["name"]?.stringValue }
        }
        if raw[stem]?["id"]?.stringValue == effectiveID { return raw[stem]?["name"]?.stringValue }
        if let source = FieldResolutionPresentation(raw: raw, field: field)?.sourceEntity,
            source.entityId == effectiveID, source.entityKind.rawValue == field.reference?.entity.rawValue
        {
            return source.name
        }
        return nil
    }

    private static func value(at path: String, in raw: JSONValue) -> JSONValue? {
        path.split(separator: ".").reduce(Optional(raw)) { current, key in current?[String(key)] }
    }
}
