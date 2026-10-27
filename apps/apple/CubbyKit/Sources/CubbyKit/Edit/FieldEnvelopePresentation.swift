import Foundation

/// One declared assignment action, as the ordinary update patch it stages. Availability comes
/// from the envelope's current controls; native never derives permission from values.
public struct FieldAssignmentAction: Sendable, Hashable, Identifiable {
    public enum Kind: String, Sendable, Hashable {
        /// Removes the record's own intent; the field follows its source again.
        case useInherited
        /// Turns the current value into the record's own explicit intent.
        case keepValue
        case setNone
    }

    public let kind: Kind
    public let label: String
    public let payload: [String: JSONValue]
    public var id: Kind { kind }
}

/// The state marker beside a value, in the one vocabulary the web popover uses.
public struct FieldValueState: Sendable, Equatable {
    public enum Tone: Sendable, Equatable {
        case set, automatic, redundant, none, inherit, fallback, allocated, computed, missing, unsupported
    }

    /// The shared marker for a value inherited rather than set here (web `InheritedMarker`).
    public static let inheritedSymbol = "list.bullet.indent"

    public let tone: Tone
    public let label: String
    public let systemImage: String
}

extension FieldEnvelope {
    /// The current stored intent and controls are understood, so actions may act on them.
    public var currentIsUnderstood: Bool {
        switch assignment {
        case .unsupported?, .value(_, .unsupported)?: return false
        default: break
        }
        switch controls {
        case .unsupported, .readonly(.unsupported), .editable(_, _, .unsupported): return false
        default: return true
        }
    }

    /// Mirrors `recordValue`: a missing or empty result reads `.null`, an unknown one `nil`.
    public var readableValue: JSONValue? {
        switch result {
        case .missing: return .null
        case .unsupported: return nil
        case .live(let decision), .cached(let decision, _, _):
            switch decision.outcome {
            case .value(let value): return value
            case .empty: return .null
            case .unsupported: return nil
            }
        }
    }

    /// The ready reset preview's result: what the field would read after Use inherited.
    public var resetPreview: Result? {
        if case .editable(_, _, .available(.ready(let preview))) = controls { return preview }
        return nil
    }

    public var resetIsAvailable: Bool {
        if case .editable(_, _, .available) = controls { return true }
        return false
    }

    /// Actions the current controls permit, in web order (Use inherited, Keep this value, Set to
    /// none). A usable cached value can be kept explicitly while its refresh is pending.
    public func actions(field: FieldDescriptor) -> [FieldAssignmentAction] {
        guard let policy = field.resolution, currentIsUnderstood,
            case .editable(let canSetNone, let canConfirm, let reset) = controls
        else { return [] }
        var actions: [FieldAssignmentAction] = []
        if case .available = reset, !policy.reset.isEmpty {
            actions.append(.init(kind: .useInherited, label: "Use inherited", payload: policy.reset))
        }
        if canConfirm, var payload = policy.confirm, let value = effectiveValue {
            payload[field.key] = value
            actions.append(.init(kind: .keepValue, label: "Keep this value", payload: payload))
        }
        if canSetNone, let none = policy.none, assignment != .explicitNone {
            actions.append(
                .init(kind: .setNone, label: "Set to \(policy.labels?.none ?? "none")", payload: none))
        }
        return actions
    }

    /// The editor's draft for the governed key and its declared companions (`…Mode`), from the
    /// stored intent S — never the inherited or cached effective value V. `nil` when the stored
    /// intent is unknown to this client.
    public func storedDraft(field: FieldDescriptor) -> (value: JSONValue, companions: [String: JSONValue])? {
        let policy = field.resolution
        func split(_ payload: [String: JSONValue]?) -> (JSONValue, [String: JSONValue]) {
            var companions = payload ?? [:]
            let value = companions.removeValue(forKey: field.key) ?? .null
            return (value, companions)
        }
        switch assignment {
        case nil: return (.null, [:])
        case .inherit?: return split(policy?.reset)
        case .explicitNone?: return split(policy?.none)
        case .value(let value, _)?:
            return (value, split(policy?.none ?? policy?.confirm).1)
        case .unsupported?: return nil
        }
    }

    /// The marker for the result's provenance. An own value equal to the ready reset preview is
    /// redundant unless the declaration pins matching values on purpose.
    public func state(field: FieldDescriptor) -> FieldValueState {
        if let kind = unsupportedKinds.first {
            return .init(
                tone: .unsupported, label: "Unsupported: \(kind)", systemImage: "exclamationmark.triangle")
        }
        if isMissing {
            return failure == nil
                ? .init(tone: .missing, label: "Updating", systemImage: "clock")
                : .init(tone: .missing, label: "Unavailable", systemImage: "exclamationmark.triangle")
        }
        if case .empty(.explicitNone) = decision?.outcome {
            return .init(tone: .none, label: field.resolution?.labels?.none ?? "None", systemImage: "nosign")
        }
        switch decision?.provenance {
        case .inherited?:
            return .init(tone: .inherit, label: "Inherited", systemImage: FieldValueState.inheritedSymbol)
        case .default?:
            return .init(tone: .fallback, label: "Default", systemImage: FieldValueState.inheritedSymbol)
        case .allocated?:
            return .init(tone: .allocated, label: "Allocated", systemImage: "chart.pie")
        case .computed?:
            return .init(tone: .computed, label: "Calculated", systemImage: "function")
        case .own?:
            if isAutomatic {
                return .init(tone: .automatic, label: "Automatic", systemImage: "sparkles")
            }
            if field.resolution?.redundancy == "eligible", case .value(let stored, _) = assignment,
                resetPreview?.value == stored
            {
                return .init(tone: .redundant, label: "Redundant", systemImage: "exclamationmark.triangle")
            }
            return .init(tone: .set, label: "Set here", systemImage: "circle.fill")
        case .unsupported?, nil:
            return .init(tone: .none, label: emptyLabel(field: field), systemImage: "nosign")
        }
    }

    /// The words a surface shows in place of an absent value, or `nil` when an unset field with
    /// no declared wording should simply be left out. Missing reads Updating/Unavailable.
    public func visibleEmptyLabel(field: FieldDescriptor) -> String? {
        if effectiveValue != nil { return nil }
        if case .empty(.unset) = decision?.outcome, field.resolution?.labels?.unresolved == nil {
            return nil
        }
        return emptyLabel(field: field)
    }

    /// What a result without a value reads as. Missing is never a successful empty result.
    public func emptyLabel(field: FieldDescriptor) -> String {
        Self.label(for: result, field: field, failure: failure)
    }

    public static func label(for result: Result, field: FieldDescriptor, failure: String? = nil) -> String {
        let labels = field.resolution?.labels
        switch result {
        case .missing: return failure == nil ? "Updating…" : "Unavailable"
        case .unsupported(let kind): return "Unsupported result: \(kind)"
        case .live(let decision), .cached(let decision, _, _):
            switch decision.outcome {
            case .value: return ""
            case .unsupported(let kind): return "Unsupported result: \(kind)"
            case .empty(let reason):
                switch reason {
                case .explicitNone: return labels?.none ?? "None"
                case .unset: return labels?.unresolved ?? "Not set"
                case .blocked: return "Blocked"
                case .mixed: return "Mixed"
                case .notApplicable: return "Not applicable"
                case .unsupported(let kind): return "Unsupported result: \(kind)"
                }
            }
        }
    }
}

/// Read helpers shared by detail, list and editor surfaces.
public enum FieldEnvelopePresentation {
    /// A declared display projection wins when present; otherwise the canonical record value.
    public static func readValue(in raw: JSONValue, field: FieldDescriptor, surface: String) -> JSONValue? {
        if let envelope = FieldEnvelope.of(raw, field: field) { return envelope.readableValue }
        if let path = field.explanation?.projections[surface],
            let projected = raw.pathValue(path, preservingNull: true)
        {
            return projected
        }
        return raw.recordValue(field.key)
    }

    /// Projected names describe the stored target. Never attach one to a different effective id.
    public static func referenceName(in raw: JSONValue, field: FieldDescriptor, effectiveID: String)
        -> String?
    {
        let stem = field.key.hasSuffix("Id") ? String(field.key.dropLast(2)) : field.key
        if let allocation = raw["\(stem)Allocations"]?.arrayValue?.first(where: {
            $0["\(stem)Id"]?.stringValue == effectiveID
        }), let name = allocation["\(stem)Name"]?.stringValue {
            return name
        }
        // A declared label whose record carries its own id names exactly that record.
        if let path = field.labelPath, path.hasSuffix(".name"),
            raw.pathValue(String(path.dropLast(5)) + ".id")?.stringValue == effectiveID,
            let name = raw.pathText(path)
        {
            return name
        }
        let envelope = FieldEnvelope.of(raw, field: field)
        let storedID: String?
        if let envelope {
            if case .value(let value, _)? = envelope.assignment {
                storedID = value.stringValue
            } else {
                storedID = nil
            }
        } else {
            storedID = raw[field.key]?.stringValue
        }
        if storedID == effectiveID {
            if let path = field.labelPath, let name = raw.pathText(path) { return name }
            if let name = raw["\(stem)Name"]?.stringValue { return name }
        }
        if raw[stem]?["id"]?.stringValue == effectiveID { return raw[stem]?["name"]?.stringValue }
        switch envelope?.decision?.provenance {
        case .inherited(let source)?, .default(let source?)?:
            if source.entityID == effectiveID, source.entityKind == field.reference?.entity.rawValue {
                return source.name
            }
        default: break
        }
        return nil
    }

    /// Allocated references can be complete even when there is no singular target.
    public static func allocatedReferenceLabel(in raw: JSONValue, field: FieldDescriptor) -> String? {
        guard field.reference != nil, FieldEnvelope.of(raw, field: field)?.isAllocated == true else {
            return nil
        }
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
}
