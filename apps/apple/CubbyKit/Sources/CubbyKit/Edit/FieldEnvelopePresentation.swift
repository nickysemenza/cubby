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

    public static func setNoneLabel(_ policy: FieldResolutionDescriptor) -> String {
        "Set to \(policy.labels?.none ?? "none")"
    }
}

/// The state marker beside a value, in the one vocabulary the web popover uses.
public struct FieldValueState: Sendable, Equatable {
    public enum Tone: Sendable, Equatable {
        case set, redundant, none, inherit, fallback, allocated, computed, missing, unsupported
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

    /// The ready reset preview's result: what the field would read after Let Cubby decide.
    public var resetPreview: Result? {
        if case .editable(_, _, .available(.ready(let preview))) = controls { return preview }
        return nil
    }

    public var resetIsAvailable: Bool {
        if case .editable(_, _, .available) = controls { return true }
        return false
    }

    /// Actions the current controls permit, in web order (Let Cubby decide, Keep this value, Set to
    /// none). A usable cached value can be kept explicitly while its refresh is pending.
    public func actions(field: FieldDescriptor) -> [FieldAssignmentAction] {
        guard let policy = field.resolution, currentIsUnderstood,
            case .editable(let canSetNone, let canConfirm, let reset) = controls
        else { return [] }
        var actions: [FieldAssignmentAction] = []
        if case .available = reset, !policy.reset.isEmpty {
            actions.append(.init(kind: .useInherited, label: FieldEnvelopePresentation.resetLabel, payload: policy.reset))
        }
        if canConfirm, var payload = policy.confirm, let value = effectiveValue {
            payload[field.key] = value
            actions.append(.init(kind: .keepValue, label: "Keep this value", payload: payload))
        }
        if canSetNone, let none = policy.none, assignment != .explicitNone {
            actions.append(
                .init(kind: .setNone, label: FieldAssignmentAction.setNoneLabel(policy), payload: none))
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
            return .init(tone: .missing, label: Self.missingLabel, systemImage: "clock")
        }
        if case .empty(.explicitNone) = decision?.outcome {
            return .init(tone: .none, label: Self.noneLabel(field: field), systemImage: "nosign")
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
        Self.label(for: result, field: field)
    }

    public static let missingLabel = "Waiting for Cubby"

    public static func noneLabel(field: FieldDescriptor) -> String {
        field.resolution?.labels?.none ?? "None"
    }

    public static func label(for result: Result, field: FieldDescriptor) -> String {
        let labels = field.resolution?.labels
        switch result {
        case .missing: return missingLabel
        case .unsupported(let kind): return "Unsupported result: \(kind)"
        case .live(let decision), .cached(let decision, _, _):
            switch decision.outcome {
            case .value: return ""
            case .unsupported(let kind): return "Unsupported result: \(kind)"
            case .empty(let reason):
                switch reason {
                case .explicitNone: return noneLabel(field: field)
                case .unset:
                    if case .allocated = decision.provenance { return "Allocated" }
                    return labels?.unresolved ?? "Not set"
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
    public static let unavailableLabel = "Unavailable"

    /// What a surface shows for an absent value. A read that carried no envelope for the field
    /// is unavailable, never empty.
    public static func emptyLabel(_ envelope: FieldEnvelope?, field: FieldDescriptor) -> String {
        envelope?.emptyLabel(field: field) ?? unavailableLabel
    }

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


extension FieldEnvelopePresentation {
    public static let waitingLabel = "Waiting for Cubby"
    public static let staleLabel = "out of date"
    public static let resetLabel = "Let Cubby decide"
    public static let vetoLabel = "Wrong, clear it"
    public static let releasedLabel = "Cubby decides this"
    public static let unknownCallNote = "Cubby won't send this paid call again on its own. If you say it was not sent, Cubby may send it again and you may be charged again."
    public static let decidedNote = "Recorded. Cubby reworks this next; the stage shows its progress."
    public static let noGapLabel = "Nothing is waiting on this."
    public static let emptyMachineryLabel = "Cubby has recorded no work on this yet."

    public static func stageLabel(_ stage: String) -> String {
        switch stage {
        case "ended": "Ended"
        case "stuck": "Stuck"
        case "working": "Working"
        case "needs_you": "Needs you"
        case "waiting": "Waiting"
        case "done": "Done"
        default: "Unsupported stage: \(stage)"
        }
    }

    public static func actorLabel(_ actor: String) -> String {
        switch actor {
        case "you": "you"
        case "cubby": "Cubby"
        case "agent": "an agent"
        case "time": "time"
        default: actor.hasPrefix("source:") ? String(actor.dropFirst(7)) : "Unsupported actor: \(actor)"
        }
    }

    public static func stageLine(_ read: Machinery) -> String {
        let stage = stageLabel(read.stage.rawValue)
        guard let gap = read.gaps.items.first, let actor = read.nextActor else { return stage }
        let mode = read.stage == .working ? "working" : "waiting"
        let base = "\(stage) · \(mode) for \(gap.input) from \(actorLabel(actor))"
        guard let queue = gap.queue else { return base }
        let position = "\(queue.position) of \(queue.of) in line"
        return queue.eta.map { "\(base) · \(position) · \(etaLabel(instant($0)))" } ?? "\(base) · \(position)"
    }

    public static func rowStatusLabel(_ status: String) -> String {
        switch status {
        case "used": "Used"
        case "skipped": "Skipped"
        case "gap": "Gap"
        case "blocked": "Blocked"
        case "failed": "Failed"
        default: "Unsupported status: \(status)"
        }
    }

    public static func inputRowStatus(_ input: MachineryInputsItemsItem) -> String {
        if input.status == .decided { return "used" }
        if let error = input.answer?.rawError, !error.isEmpty, input.answer?.model == nil { return "failed" }
        return input.status.rawValue
    }

    public static func inputKindLabel(_ kind: String) -> String {
        switch kind {
        case "evidence": "Evidence"
        case "answer": "Answer"
        case "decision": "Decision"
        case "default": "Default"
        default: "Unsupported input: \(kind)"
        }
    }

    public static func decisionKindLabel(_ kind: String) -> String {
        switch kind {
        case "set": "Set"
        case "none": "Set to none"
        case "release": "Released"
        case "veto": "Vetoed"
        case "same": "Same record"
        case "distinct": "Different records"
        case "reject": "Rejected"
        default: "Unsupported decision: \(kind)"
        }
    }

    public static func decisionChannelLabel(_ channel: String) -> String {
        switch channel {
        case "assignment": "Assignment"
        case "veto": "Veto"
        case "identity": "Identity"
        case "rejection": "Rejection"
        default: "Unsupported channel: \(channel)"
        }
    }

    public static func costLabel(_ micros: Int) -> String {
        if micros == 0 { return "$0" }
        let dollars = Double(micros) / 1_000_000
        if dollars >= 1 { return String(format: "$%.2f", locale: Locale(identifier: "en_US_POSIX"), dollars) }
        let rounded = Double(String(format: "%.2g", locale: Locale(identifier: "en_US_POSIX"), dollars)) ?? dollars
        return "$\(rounded)"
    }

    public static func countLine(_ read: Machinery) -> String {
        let inputs = read.inputs.items.filter { $0.kind == .evidence || $0.kind == .default }.count
        let asks = read.inputs.items.filter { $0.kind == .answer }.count
        let decisions = read.inputs.items.filter { $0.kind == .decision }.count
        let more = read.inputs.total > read.inputs.shown ? "+" : ""
        return "\(plural(inputs, "input", "inputs"))\(more) · \(plural(asks, "ask", "asks")) · \(plural(decisions, "decision", "decisions")) · \(costLabel(read.totalCostMicros))"
    }

    public static func gapSentence(_ gap: MachineryGapsItemsItem) -> String {
        "Waiting for \(gap.input) from \(actorLabel(gap.actor))."
    }
    public static func etaLabel(_ formatted: String?) -> String {
        formatted.map { "expected by \($0)" } ?? "ETA unknown"
    }
    public static func attemptsLabel(n: Int, max: Int, nextAt: String?) -> String {
        let base = "Attempt \(n) of \(max)"
        return nextAt.map { "\(base) · next try \($0)" } ?? base
    }
    public static func coverageLabel(shown: Int, total: Int) -> String? {
        total > shown ? "Showing \(shown) of \(total)" : nil
    }
    public static func resetPendingNote(_ n: Int) -> String? {
        n == 0 ? nil : "after \(plural(n, "more answer", "more answers"))"
    }
    public static func absorbedRecordNotice(_ code: String) -> String {
        "\(code) was merged into this record."
    }
    public enum DecidingLevel {
        case source(String), set(String), none(String), cubby, waiting(input: String, actor: String)
    }
    public static func fieldDecidingLine(_ level: DecidingLevel) -> String {
        switch level {
        case .source(let source): "From \(source)"
        case .set(let by): "Set by \(by)"
        case .none(let by): "Set to none by \(by)"
        case .cubby: "Worked out by Cubby"
        case .waiting(let input, let actor): "Waiting for \(input) from \(actorLabel(actor))"
        }
    }
    public static func columnLabel(_ column: String) -> String {
        switch column {
        case "stage": "Stage"
        case "actor": "Actor"
        case "gap": "Gap"
        case "attempts": "Attempts"
        case "cost": "Cost"
        case "eta": "ETA"
        default: "Unsupported column: \(column)"
        }
    }
    public static func instant(_ date: Date) -> String {
        date.formatted(.dateTime.month(.abbreviated).day().hour().minute())
    }
    private static func plural(_ n: Int, _ one: String, _ many: String) -> String {
        "\(n) \(n == 1 ? one : many)"
    }
}
