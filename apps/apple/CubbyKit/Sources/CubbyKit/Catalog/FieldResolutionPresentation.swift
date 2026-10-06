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

    public var resetLabel: String { fallbackValue == .null ? "Clear value" : "Use inherited value" }

    public var state: FieldResolutionState {
        FieldResolutionState(resolution, hasFallback: fallbackValue != .null)
    }

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
        if let allocation = raw["\(stem)Allocations"]?.arrayValue?.first(where: {
            $0["\(stem)Id"]?.stringValue == effectiveID
        }), let name = allocation["\(stem)Name"]?.stringValue {
            return name
        }
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

    /// Allocated references can be complete even when there is no singular target.
    public static func allocatedReferenceLabel(in raw: JSONValue, field: FieldDescriptor) -> String? {
        guard field.reference != nil,
            FieldResolutionPresentation(raw: raw, field: field)?.resolution.mode == .allocated
        else { return nil }
        let stem = field.key.hasSuffix("Id") ? String(field.key.dropLast(2)) : field.key
        let shares = raw["\(stem)Allocations"]?.arrayValue ?? []
        var labels: [String] = []
        var incomplete = shares.isEmpty
        for share in shares {
            guard let id = share["\(stem)Id"]?.stringValue else {
                incomplete = true
                continue
            }
            let label = share["\(stem)Name"]?.stringValue ?? id
            if !labels.contains(label) { labels.append(label) }
            incomplete = incomplete || share["incomplete"]?.boolValue == true
        }
        if incomplete { labels.append(labels.isEmpty ? "Unclassified" : "Partly unclassified") }
        return labels.joined(separator: ", ")
    }

    private static func value(at path: String, in raw: JSONValue) -> JSONValue? {
        path.split(separator: ".").reduce(Optional(raw)) { current, key in current?[String(key)] }
    }
}

/// One vocabulary for every resolution surface, matching the web popover. An explicit value with
/// nothing above it is "Set here", never an override: there is nothing for it to override.
public struct FieldResolutionState: Sendable, Equatable {
    public enum Tone: Sendable, Equatable { case set, override, redundant, none, inherit, allocated }

    public let tone: Tone
    public let label: String
    public let systemImage: String

    public init(_ resolution: FieldResolution, hasFallback: Bool) {
        switch resolution.mode {
        case .inherit:
            (tone, label, systemImage) = (.inherit, "Inherited", "arrow.turn.down.right")
        case .allocated:
            (tone, label, systemImage) = (.allocated, resolution.source, "chart.pie")
        case .none:
            (tone, label, systemImage) = (.none, hasFallback ? "Blocks inherited" : "None", "nosign")
        case .explicit:
            if resolution.matchesFallback {
                (tone, label, systemImage) = (.redundant, "Redundant", "exclamationmark.triangle")
            } else if hasFallback {
                (tone, label, systemImage) = (.override, "Overrides inherited", "arrow.counterclockwise")
            } else {
                (tone, label, systemImage) = (.set, "Set here", "circle.fill")
            }
        }
    }
}
