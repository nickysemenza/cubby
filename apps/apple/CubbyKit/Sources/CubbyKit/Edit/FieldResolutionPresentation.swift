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

    /// The caption beside a resolved value, in the one vocabulary (Inherited / Set here / None).
    public var sourceText: String {
        switch resolution.mode {
        case .inherit: "Inherited · \(resolution.source)"
        case .allocated: "Allocated · \(resolution.source)"
        case .explicit: "Set here"
        case .none: "None"
        }
    }

    /// Inherited and not confirmed or set here: the values the shared marker flags.
    public var isInherited: Bool { resolution.mode == .inherit && effectiveValue != .null }

    /// What a null effective value reads as: the declaration's words for a deliberate empty
    /// (`labels.none`, "Household") or an inherit with nothing to inherit (`labels.unresolved`).
    public func emptyLabel(field: FieldDescriptor) -> String {
        Self.emptyLabel(resolution, field: field)
    }

    public static func emptyLabel(_ resolution: FieldResolution, field: FieldDescriptor) -> String {
        let labels = field.resolution?.labels
        switch resolution.mode {
        case .inherit: return labels?.unresolved ?? "None"
        case .explicit, .none: return labels?.none ?? "None"
        case .allocated: return "None"
        }
    }

    public func state(field: FieldDescriptor) -> FieldResolutionState {
        FieldResolutionState(
            resolution, hasFallback: fallbackValue != .null,
            intentional: field.resolution?.redundancy == "intentional")
    }

    public func resetPayload(field: FieldDescriptor) -> [String: JSONValue]? {
        guard resolution.canReset else { return nil }
        return field.resolution?.reset
    }

    /// The declaration's resolution links in web order: Use inherited (reset), Confirm (pin the
    /// inherited value: `confirm` plus the field set to it), and Set to <none label>.
    public func actions(field: FieldDescriptor) -> [FieldResolutionAction] {
        guard let policy = field.resolution else { return [] }
        var actions: [FieldResolutionAction] = []
        if resolution.canReset {
            actions.append(
                .init(
                    kind: .useInherited,
                    label: fallbackValue == .null && policy.labels?.unresolved == nil
                        ? "Clear value" : "Use inherited",
                    payload: policy.reset))
        }
        if let confirm = policy.confirm, isInherited {
            var payload = confirm
            payload[field.key] = effectiveValue
            actions.append(.init(kind: .confirm, label: "Confirm", payload: payload))
        }
        if let none = policy.none, resolution.mode == .inherit,
            effectiveValue != .null || policy.labels?.none != nil
        {
            actions.append(
                .init(kind: .setNone, label: "Set to \(policy.labels?.none ?? "none")", payload: none))
        }
        return actions
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
            if let path = field.labelPath, let name = raw.pathText(path) { return name }
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

/// One resolution link a declaration offers, as the update patch it stages.
public struct FieldResolutionAction: Sendable, Hashable, Identifiable {
    public enum Kind: String, Sendable, Hashable { case useInherited, confirm, setNone }

    public let kind: Kind
    public let label: String
    public let payload: [String: JSONValue]
    public var id: Kind { kind }
}

/// One vocabulary for every resolution surface, matching the web popover. An explicit value with
/// nothing above it is "Set here", never an override: there is nothing for it to override. A
/// field whose declaration pins a matching value on purpose (`redundancy: "intentional"`, the
/// Confirm action) reads "Set here", never redundant.
public struct FieldResolutionState: Sendable, Equatable {
    public enum Tone: Sendable, Equatable { case set, override, redundant, none, inherit, allocated }

    /// The shared marker for a value inherited rather than set here (web `InheritedMarker`).
    public static let inheritedSymbol = "list.bullet.indent"

    public let tone: Tone
    public let label: String
    public let systemImage: String

    public init(_ resolution: FieldResolution, hasFallback: Bool, intentional: Bool = false) {
        switch resolution.mode {
        case .inherit:
            (tone, label, systemImage) = (.inherit, "Inherited", Self.inheritedSymbol)
        case .allocated:
            (tone, label, systemImage) = (.allocated, resolution.source, "chart.pie")
        case .none:
            (tone, label, systemImage) = (.none, "None", "nosign")
        case .explicit:
            if resolution.matchesFallback && !intentional {
                (tone, label, systemImage) = (.redundant, "Redundant", "exclamationmark.triangle")
            } else if hasFallback && !resolution.matchesFallback {
                (tone, label, systemImage) = (.override, "Set here", "arrow.counterclockwise")
            } else {
                (tone, label, systemImage) = (.set, "Set here", "circle.fill")
            }
        }
    }
}
