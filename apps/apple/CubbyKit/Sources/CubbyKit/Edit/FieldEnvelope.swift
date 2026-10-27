import Foundation

/// The one native adapter for a canonical field envelope (`row.fields[key]`, or an explanation's
/// `envelope`). The current assignment and controls are authoritative independently of the
/// result, which may be an old cached decision. Unknown variants stay visible as `unsupported`
/// with their raw kind; interpretation-dependent actions treat them as unavailable.
public struct FieldEnvelope: Sendable, Hashable {
    public let raw: JSONValue
    /// The stored intent; `nil` when the record holds none.
    public let assignment: Assignment?
    public let controls: Controls
    public let result: Result
    public let work: Work

    public enum Ownership: Sendable, Hashable {
        case record
        case automatic(receiptID: String, confidence: Double)
        case unsupported(String)
    }

    public enum Assignment: Sendable, Hashable {
        case inherit
        /// A deliberate empty, distinct from following the source.
        case explicitNone
        case value(JSONValue, ownership: Ownership)
        case unsupported(String)
    }

    public enum ReadonlyReason: Sendable, Hashable {
        case computed, allocated, notAllowed
        case unsupported(String)
    }

    public enum ResetPreview: Sendable, Hashable {
        case notLoaded
        case ready(Result)
        case unsupported(String)
    }

    public enum Reset: Sendable, Hashable {
        case unavailable
        case available(ResetPreview)
        case unsupported(String)
    }

    public enum Controls: Sendable, Hashable {
        case readonly(ReadonlyReason)
        case editable(canSetNone: Bool, canConfirm: Bool, reset: Reset)
        case unsupported(String)
    }

    public enum Freshness: Sendable, Hashable {
        case fresh, stale
        case unsupported(String)
    }

    public enum EmptyReason: Sendable, Hashable {
        case explicitNone, unset, blocked, mixed, notApplicable
        case unsupported(String)
    }

    public enum Outcome: Sendable, Hashable {
        case value(JSONValue)
        case empty(EmptyReason)
        case unsupported(String)
    }

    public struct Source: Sendable, Hashable {
        public let entityKind: String
        public let entityID: String
        public let name: String?
        public var entity: EntityKey? { EntityKey(rawValue: entityKind) }
    }

    public enum Provenance: Sendable, Hashable {
        case own(Ownership)
        case inherited(Source)
        case `default`(Source?)
        case allocated
        case computed
        case unsupported(String)
    }

    public struct Decision: Sendable, Hashable {
        public let outcome: Outcome
        public let provenance: Provenance?
    }

    public enum Result: Sendable, Hashable {
        /// No usable result exists yet; never a successful empty value.
        case missing
        case live(Decision)
        case cached(Decision, computedAt: String, freshness: Freshness)
        case unsupported(String)

        public var decision: Decision? {
            switch self {
            case .live(let decision), .cached(let decision, _, _): decision
            case .missing, .unsupported: nil
            }
        }

        public var value: JSONValue? {
            if case .value(let value) = decision?.outcome { return value }
            return nil
        }
    }

    public enum Work: Sendable, Hashable {
        case idle, pending
        case waiting(reason: String)
        case failed(error: String, retryAt: String?)
        case unsupported(String)
    }

    /// `nil` when the JSON is not an envelope at all (a missing part or a non-object).
    public init?(_ raw: JSONValue) {
        guard let current = raw["current"], let controls = current["controls"],
            let assignment = current["assignment"],
            let result = raw["result"].flatMap(Self.result), let work = raw["work"].flatMap(Self.work),
            let parsedControls = Self.controls(controls)
        else { return nil }
        self.raw = raw
        self.assignment = assignment == .null ? nil : Self.assignment(assignment)
        self.controls = parsedControls
        self.result = result
        self.work = work
    }

    /// The canonical envelope a record carries for a field: its read key first, then its key.
    public static func of(_ raw: JSONValue, field: FieldDescriptor) -> FieldEnvelope? {
        of(raw, key: field.readKey ?? field.key) ?? (field.readKey == nil ? nil : of(raw, key: field.key))
    }

    public static func of(_ raw: JSONValue, key: String) -> FieldEnvelope? {
        raw["fields"]?[key].flatMap(FieldEnvelope.init)
    }

    // MARK: - Derived reads (no policy)

    public var decision: Decision? { result.decision }

    /// The value of a usable result. `nil` for missing, empty, and unknown results alike; inspect
    /// `result` to tell them apart.
    public var effectiveValue: JSONValue? { result.value }

    public var isMissing: Bool { result == .missing }

    /// The result's provenance names an inherited source (web `FieldValueMark`).
    public var isInherited: Bool {
        if case .inherited = decision?.provenance { return true }
        return false
    }

    /// The own value is a current automatic assignment, not a person's choice.
    public var isAutomatic: Bool {
        guard case .own(.automatic(let publishedReceipt, _)) = decision?.provenance,
            case .value(_, .automatic(let currentReceipt, _)) = assignment
        else { return false }
        return publishedReceipt == currentReceipt
    }

    public var isAllocated: Bool {
        if case .allocated = decision?.provenance { return true }
        return false
    }

    /// A refresh is queued, waiting, or the cached result is known stale.
    public var isUpdating: Bool {
        switch work {
        case .pending, .waiting: return true
        default: break
        }
        if case .cached(_, _, .stale) = result { return true }
        return false
    }

    public var failure: String? {
        if case .failed(let error, _) = work { return error }
        return nil
    }

    /// Raw kinds this client does not understand, for an "Unsupported" diagnostic.
    public var unsupportedKinds: [String] {
        var kinds: [String] = []
        func note(_ kind: String) { if !kinds.contains(kind) { kinds.append(kind) } }
        switch assignment {
        case .unsupported(let kind)?: note(kind)
        case .value(_, .unsupported(let kind))?: note(kind)
        default: break
        }
        switch controls {
        case .unsupported(let kind), .readonly(.unsupported(let kind)): note(kind)
        case .editable(_, _, .unsupported(let kind)), .editable(_, _, .available(.unsupported(let kind))):
            note(kind)
        case .editable(_, _, .available(.ready(let preview))):
            Self.unsupportedKinds(in: preview).forEach(note)
        default: break
        }
        Self.unsupportedKinds(in: result).forEach(note)
        if case .unsupported(let kind) = work { note(kind) }
        return kinds
    }

    private static func unsupportedKinds(in result: Result) -> [String] {
        switch result {
        case .unsupported(let kind): return [kind]
        case .missing: return []
        case .live(let decision), .cached(let decision, _, .fresh), .cached(let decision, _, .stale):
            return unsupportedKinds(in: decision)
        case .cached(let decision, _, .unsupported(let kind)):
            return [kind] + unsupportedKinds(in: decision)
        }
    }

    private static func unsupportedKinds(in decision: Decision) -> [String] {
        var kinds: [String] = []
        switch decision.outcome {
        case .unsupported(let kind), .empty(.unsupported(let kind)): kinds.append(kind)
        default: break
        }
        switch decision.provenance {
        case .unsupported(let kind)?, .own(.unsupported(let kind))?: kinds.append(kind)
        default: break
        }
        return kinds
    }

    // MARK: - Parsing

    /// Parses a bare result (an explanation's live comparison) with the envelope's rules.
    public static func parseResult(_ raw: JSONValue) -> Result? { result(raw) }

    private static func kind(_ value: JSONValue) -> String {
        value["kind"]?.stringValue ?? "missing kind"
    }

    private static func ownership(_ value: JSONValue?) -> Ownership {
        guard let value else { return .unsupported("missing ownership") }
        switch value["kind"]?.stringValue {
        case "record": return .record
        case "automatic":
            guard let receipt = value["receiptId"]?.stringValue,
                let confidence = value["confidence"]?.doubleValue
            else { return .unsupported("automatic") }
            return .automatic(receiptID: receipt, confidence: confidence)
        default: return .unsupported(kind(value))
        }
    }

    private static func assignment(_ value: JSONValue) -> Assignment {
        switch value["kind"]?.stringValue {
        case "inherit": return .inherit
        case "none": return .explicitNone
        case "value":
            guard let stored = value["value"], stored != .null else { return .unsupported("value") }
            return .value(stored, ownership: ownership(value["ownership"]))
        default: return .unsupported(kind(value))
        }
    }

    private static func controls(_ value: JSONValue) -> Controls? {
        switch value["kind"]?.stringValue {
        case "readonly":
            switch value["reason"]?.stringValue {
            case "computed": return .readonly(.computed)
            case "allocated": return .readonly(.allocated)
            case "not_allowed": return .readonly(.notAllowed)
            case let reason: return .readonly(.unsupported(reason ?? "missing reason"))
            }
        case "editable":
            guard let canSetNone = value["canSetNone"]?.boolValue,
                let canConfirm = value["canConfirm"]?.boolValue, let reset = value["reset"]
            else { return .unsupported("editable") }
            return .editable(canSetNone: canSetNone, canConfirm: canConfirm, reset: Self.reset(reset))
        case nil: return nil
        default: return .unsupported(kind(value))
        }
    }

    private static func reset(_ value: JSONValue) -> Reset {
        switch value["kind"]?.stringValue {
        case "unavailable": return .unavailable
        case "available":
            guard let preview = value["preview"] else { return .unsupported("available") }
            switch preview["kind"]?.stringValue {
            case "not_loaded": return .available(.notLoaded)
            case "ready":
                guard let result = preview["result"].flatMap(Self.result) else {
                    return .available(.unsupported("ready"))
                }
                return .available(.ready(result))
            default: return .available(.unsupported(kind(preview)))
            }
        default: return .unsupported(kind(value))
        }
    }

    private static func result(_ value: JSONValue) -> Result? {
        switch value["kind"]?.stringValue {
        case "missing": return .missing
        case "live":
            return .live(decision(value["decision"]))
        case "cached":
            let freshness: Freshness
            switch value["freshness"]?.stringValue {
            case "fresh": freshness = .fresh
            case "stale": freshness = .stale
            case let other: freshness = .unsupported(other ?? "missing freshness")
            }
            return .cached(
                decision(value["decision"]), computedAt: value["computedAt"]?.stringValue ?? "",
                freshness: freshness)
        case nil: return nil
        default: return .unsupported(kind(value))
        }
    }

    private static func decision(_ value: JSONValue?) -> Decision {
        let outcome: Outcome
        switch value?["outcome"]?["kind"]?.stringValue {
        case "value":
            if let present = value?["outcome"]?["value"], present != .null {
                outcome = .value(present)
            } else {
                outcome = .unsupported("value")
            }
        case "empty":
            switch value?["outcome"]?["reason"]?.stringValue {
            case "explicit_none": outcome = .empty(.explicitNone)
            case "unset": outcome = .empty(.unset)
            case "blocked": outcome = .empty(.blocked)
            case "mixed": outcome = .empty(.mixed)
            case "not_applicable": outcome = .empty(.notApplicable)
            case let reason: outcome = .empty(.unsupported(reason ?? "missing reason"))
            }
        case let other: outcome = .unsupported(other ?? "missing outcome")
        }
        let provenance: Provenance?
        if let raw = value?["provenance"], raw != .null {
            switch raw["kind"]?.stringValue {
            case "own": provenance = .own(ownership(raw["ownership"]))
            case "inherited":
                provenance = source(raw["source"]).map(Provenance.inherited) ?? .unsupported("inherited")
            case "default": provenance = .default(source(raw["source"]))
            case "allocated": provenance = .allocated
            case "computed": provenance = .computed
            default: provenance = .unsupported(kind(raw))
            }
        } else {
            provenance = nil
        }
        return Decision(outcome: outcome, provenance: provenance)
    }

    private static func source(_ value: JSONValue?) -> Source? {
        guard let value, let kind = value["entityKind"]?.stringValue, let id = value["entityId"]?.stringValue
        else { return nil }
        return Source(entityKind: kind, entityID: id, name: value["name"]?.stringValue)
    }

    private static func work(_ value: JSONValue) -> Work? {
        switch value["kind"]?.stringValue {
        case "idle": return .idle
        case "pending": return .pending
        case "waiting": return .waiting(reason: value["reason"]?.stringValue ?? "")
        case "failed":
            return .failed(error: value["error"]?.stringValue ?? "", retryAt: value["retryAt"]?.stringValue)
        case nil: return nil
        default: return .unsupported(kind(value))
        }
    }
}
