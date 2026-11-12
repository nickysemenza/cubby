import CubbyAPI
import Foundation

/// A record's `presentation.state` read off one row: the declared state option, its phase, the
/// role that picks the badge treatment, and the muted text after the label (the declared
/// reason, else the wait). Mirrors web `readRecordState` and `StateBadge`'s role rule.
public struct RecordState: Sendable, Hashable {
    /// The badge treatment. Needs-you, stalled and failed are filled; the rest are a mark and a
    /// label. A wait refines an active state into queued or paused; a finished option is done only
    /// when its declared colour is positive.
    public enum Role: String, Sendable, Hashable {
        case needs, stalled, failed, running, queued, paused, done, ended
    }

    public let option: LabeledOption
    public let phase: EntityPhase
    public let role: Role
    /// The badge text: "Stalled" for a stalled record, else the option label.
    public let label: String
    /// Muted text after the label: the declared reason, else the wait's server-worded line.
    public let trailing: String?
    /// The wait's live Job breakdown ("36 backing off · 1 in progress"), for the detail header.
    public let jobs: String?

    public init(option: LabeledOption, reason: String?, waitReason: String?, waitLabel: String?, jobs: String?, stalled: Bool) {
        self.option = option
        phase = option.statePhase
        let failed = option.isFailure
        role =
            if failed { .failed }
            else if stalled { .stalled }
            else if phase == .needs { .needs }
            else if phase == .finished { option.isPositive ? .done : .ended }
            else if waitReason == "paused" { .paused }
            else if let waitReason, waitReason != "in_progress" { .queued }
            else { .running }
        label = role == .stalled ? "Stalled" : option.label
        trailing = reason ?? waitLabel.map { Self.withoutLabel($0, label: option.label) }
        self.jobs = jobs
    }

    /// Drops a leading repeat of the label so "Queued" is not followed by "Queued ·".
    private static func withoutLabel(_ text: String, label: String) -> String {
        let head = "\(label) · "
        return text.lowercased().hasPrefix(head.lowercased()) ? String(text.dropFirst(head.count)) : text
    }
}

extension LabeledOption {
    /// `optionPhase`: the declared phase, else finished for a closed option and active otherwise.
    public var statePhase: EntityPhase { phase ?? (closed == true ? .finished : .active) }
    /// A destructive option is a failure outcome.
    public var isFailure: Bool { color == "var(--destructive)" || color == "var(--brand-destructive)" }
    var isPositive: Bool { color == "var(--positive)" || color == "var(--brand-positive)" }
}

extension FieldDescriptor {
    /// The field's option roster: its select options, else its display options.
    public var optionRoster: [LabeledOption]? { controlOptions ?? valueOptions }
}

extension EntityDescriptor {
    /// The declared `presentation.state` of `raw`, nil without a declaration or a value.
    public func recordState(in raw: JSONValue) -> RecordState? {
        guard let spec = presentation.recordState, let field = field(spec.field),
            let value = field.surfaceValue(in: raw, surface: "list")?.stringValue, !value.isEmpty
        else { return nil }
        let option =
            field.optionRoster?.first { $0.value == value } ?? LabeledOption(value: value, label: value)
        let wait = spec.wait.flatMap { raw.recordValue($0) }.flatMap { $0 == .null ? nil : $0 }
        let reason = spec.reason.flatMap { key in
            self.field(key).flatMap { $0.labelPath.flatMap(raw.pathText) } ?? raw.recordValue(key)?.stringValue
        }
        return RecordState(
            option: option, reason: reason.flatMap { $0.isEmpty ? nil : $0 },
            waitReason: wait?["reason"]?.stringValue, waitLabel: wait?["label"]?.stringValue,
            jobs: wait?["jobs"]?.stringValue,
            stalled: spec.stalled.flatMap { raw.recordValue($0)?.boolValue } ?? false)
    }

    /// The declared `presentation.progress` of `raw`; nil without a declaration or a value.
    public func recordProgress(in raw: JSONValue) -> ProgressValue? {
        guard let spec = presentation.recordProgress, let value = raw.recordValue(spec.field),
            value != .null
        else { return nil }
        return try? ProgressValue(value)
    }

    /// The `presentation.kind` option `raw` holds: what kind of record it is.
    public func recordKind(in raw: JSONValue) -> LabeledOption? {
        guard let key = presentation.recordKind, let field = field(key),
            let value = field.surfaceValue(in: raw, surface: "detail")?.stringValue
        else { return nil }
        return field.optionRoster?.first { $0.value == value }
    }

    /// Every field the record header already shows (state and its inputs, progress, kind, the
    /// declared lines, the AI summary and the needs list), which later detail sections omit.
    public var headerFieldKeys: Set<String> {
        var keys = Set<String>()
        if let state = presentation.recordState {
            keys.formUnion([state.field, state.reason, state.wait, state.stalled].compactMap { $0 })
        }
        if let progress = presentation.recordProgress {
            keys.formUnion([progress.field, progress.note].compactMap { $0 })
        }
        if let kind = presentation.recordKind { keys.insert(kind) }
        keys.formUnion(presentation.detailLines.map(\.field))
        keys.formUnion([presentation.detailAISummary, presentation.detailNeeds].compactMap { $0 })
        return keys
    }
}

/// How far a piece of work has come, as counts of `unit` (the server's `ProgressValue`). Pinned
/// at the schema boundary: a renamed or missing count fails to decode rather than drawing zero.
public struct ProgressValue: Sendable, Hashable {
    public enum UnitState: String, Sendable, Hashable { case done, active, failed, stalled, queued }

    public struct Part: Sendable, Hashable {
        public let label: String
        public let state: UnitState
    }

    public let done: Int
    public let failed: Int
    public let active: Int
    public let stalled: Int
    public let queued: Int
    /// Nil when the total is unknown: an indeterminate track.
    public let total: Int?
    public let unit: String
    public let parts: [Part]?

    public init(
        done: Int, failed: Int = 0, active: Int = 0, stalled: Int = 0, queued: Int = 0, total: Int?,
        unit: String, parts: [Part]? = nil
    ) {
        self.done = done
        self.failed = failed
        self.active = active
        self.stalled = stalled
        self.queued = queued
        self.total = total
        self.unit = unit
        self.parts = parts
    }

    public init(_ value: JSONValue) throws {
        let reader = JSONRead(value: value, context: "ProgressValue")
        func count(_ key: String) throws -> Int {
            guard let number = value[key]?.doubleValue, number >= 0, number == number.rounded() else {
                throw reader.malformed(key, expected: "a non-negative integer")
            }
            return Int(number)
        }
        let total: Int?
        if value["total"] == .null { total = nil } else { total = try count("total") }
        self.init(
            done: try count("done"), failed: try count("failed"), active: try count("active"),
            stalled: try count("stalled"), queued: try count("queued"), total: total,
            unit: try reader.string("unit"),
            parts: try value["parts"]?.arrayValue?.map { part in
                guard let label = part["label"]?.stringValue,
                    let state = part["state"]?.stringValue.flatMap(UnitState.init(rawValue:))
                else { throw reader.malformed("parts", expected: "labelled part states") }
                return Part(label: label, state: state)
            })
    }

    /// A total of this many units or fewer draws one segment per unit.
    public static let segmentLimit = 12

    public struct Segment: Sendable, Hashable {
        public let state: UnitState
        public let label: String?
    }

    public struct Run: Sendable, Hashable {
        public let state: UnitState
        public let fraction: Double
    }

    public enum Track: Sendable, Hashable {
        /// One segment per unit, in draw order, each with its part label when declared.
        case segments([Segment])
        /// Proportional runs of a larger total, as fractions of the whole.
        case bar([Run])
        case indeterminate
    }

    /// The track every client draws from the counts alone; whatever is unaccounted for is queued.
    public var track: Track {
        guard let total else { return .indeterminate }
        if total <= Self.segmentLimit {
            if let parts { return .segments(parts.map { Segment(state: $0.state, label: $0.label) }) }
            var units: [Segment] = []
            let counts: [(UnitState, Int)] = [
                (.done, done), (.failed, failed), (.active, active), (.stalled, stalled), (.queued, total),
            ]
            for (state, count) in counts {
                for _ in 0..<count where units.count < total { units.append(Segment(state: state, label: nil)) }
            }
            return .segments(units)
        }
        let counts: [(UnitState, Int)] = [
            (.done, done), (.failed, failed), (.active, active), (.stalled, stalled), (.queued, queued),
        ]
        return .bar(
            counts.filter { $0.1 > 0 }.map { Run(state: $0.0, fraction: Double($0.1) / Double(total)) })
    }

    /// "3 of 12 orders", or "3 orders" when the total is unknown.
    public var label: String {
        guard let total else { return "\(ValueFormat.count(done)) \(unit)" }
        return "\(ValueFormat.count(done)) of \(ValueFormat.count(total)) \(unit)"
    }
}

/// A `list.tree.batch` row's words: "16 Email imports", its members by state with the most urgent
/// phase first, and the lead state the row's badge draws. Mirrors web `batchSummary`.
public struct ListBatchSummary: Sendable, Hashable {
    public let title: String
    public let rollup: String
    public let lead: RecordState?
    public let progress: ProgressValue

    public init(batch: ListBatch, descriptor: EntityDescriptor) {
        let kind = descriptor.presentation.listTree?.batchBy.flatMap(descriptor.field)?.optionRoster?
            .first { $0.value == batch.value }
        let noun = kind?.label ?? descriptor.singular
        title = String(AttributedString(localized: "^[\(batch.count) \(noun)](inflect: true)").characters)
        let options = descriptor.presentation.recordState.flatMap { descriptor.field($0.field) }?.optionRoster ?? []
        let order: [EntityPhase] = [.needs, .active, .finished]
        let counted = batch.states.filter { $0.value > 0 }
            .map { value, count in
                (option: options.first { $0.value == value } ?? LabeledOption(value: value, label: value), count: count)
            }
            .sorted {
                (order.firstIndex(of: $0.option.statePhase) ?? 0, $0.option.value)
                    < (order.firstIndex(of: $1.option.statePhase) ?? 0, $1.option.value)
            }
        rollup = counted.map { "\($0.count) \($0.option.label.lowercased())" }.joined(separator: ", ")
        lead = counted.first.map {
            RecordState(option: $0.option, reason: nil, waitReason: nil, waitLabel: nil, jobs: nil, stalled: false)
        }
        progress = ProgressValue(
            done: batch.phases["finished"] ?? 0,
            failed: counted.filter { $0.option.isFailure }.reduce(0) { $0 + $1.count },
            active: batch.phases["active"] ?? 0, total: batch.count,
            unit: descriptor.plural.lowercased())
    }
}
