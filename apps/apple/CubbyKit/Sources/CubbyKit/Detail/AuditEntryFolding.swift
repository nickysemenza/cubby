import Foundation

/// Consecutive audit entries that read as one event: a burst of updates to one record by the
/// same writer, or a single entry standing alone. Entries keep the feed's newest-first order.
public struct AuditEntryGroup: Identifiable, Sendable {
    public let entries: [AuditLogEntryOut]

    public var id: String { lead.entryKey }
    public var lead: AuditLogEntryOut { entries[0] }
    public var isFolded: Bool { entries.count > 1 }

    /// Distinct changed fields across the group, in first-seen order.
    public var changedFields: [String] {
        var seen = Set<String>()
        return entries.flatMap { ($0.changes?.additionalProperties.keys).map { $0.sorted() } ?? [] }
            .filter { seen.insert($0).inserted }
    }

    /// "3 updates · 2 fields" for a folded burst; `nil` for a single entry.
    public var foldSummary: String? {
        guard isFolded else { return nil }
        let fields = changedFields.count
        return "\(entries.count) updates · \(fields) \(fields == 1 ? "field" : "fields")"
    }
}

/// The audit feed's folding rule, shared with web (`audit-log-fold.ts`): consecutive updates to
/// one record by the same writer (person, channel, OAuth client, device and run) within ten
/// minutes of each other fold into one group. Every other entry stands alone.
public enum AuditEntryFolding {
    /// Edits further apart than this read as separate events.
    public static let window: TimeInterval = 10 * 60

    public static func fold(_ entries: [AuditLogEntryOut]) -> [AuditEntryGroup] {
        var groups: [[AuditLogEntryOut]] = []
        for entry in entries {
            if let previous = groups.last?.last, folds(entry, after: previous) {
                groups[groups.count - 1].append(entry)
            } else {
                groups.append([entry])
            }
        }
        return groups.map(AuditEntryGroup.init(entries:))
    }

    private static func folds(_ entry: AuditLogEntryOut, after previous: AuditLogEntryOut) -> Bool {
        entry.action == .update && previous.action == .update
            && entry.entityKind == previous.entityKind && entry.entityId == previous.entityId
            && entry.userId == previous.userId && entry.channel == previous.channel
            && entry.oauthClient?.id == previous.oauthClient?.id
            && entry.device?.id == previous.device?.id && entry.runId == previous.runId
            && abs(previous.createdAt.timeIntervalSince(entry.createdAt)) <= window
    }
}

/// One changed field of an audit entry, worded for a glance.
public struct AuditFieldChange: Sendable, Hashable {
    public let field: String
    public let from: String?
    public let to: String?

    /// `unitPrice` → "Unit price".
    public var label: String {
        let spaced = FieldKeyWords.spaced(field).lowercased()
        return spaced.prefix(1).uppercased() + spaced.dropFirst()
    }
}

extension AuditLogEntryOut {
    /// Full identifier effects have their own feed rendering; they never take the compact scalar path.
    public var identifierEffects: [String] {
        guard let change = changes?.additionalProperties["externalIds"] else { return [] }
        let before = change.from.flatMap { try? JSONValue(encoding: $0) }
        let after = change.to.flatMap { try? JSONValue(encoding: $0) }
        let effects = IdentifierPresentation.effects(before: before, after: after)
        if !effects.isEmpty { return effects }
        if before == nil || after == nil {
            return [
                "Identifier changes: \(Self.text(change.from) ?? "(not recorded)") → \(Self.text(change.to) ?? "(not recorded)")"
            ]
        }
        // Retain the actual diagnostic evidence when an audit row cannot be interpreted as identifiers.
        if let before, let after, before != after {
            return [
                "Identifier changes: \(Self.text(change.from) ?? "(empty)") → \(Self.text(change.to) ?? "(empty)")"
            ]
        }
        return []
    }

    /// The entry's changed fields, sorted by name for a stable order.
    public var fieldChanges: [AuditFieldChange] { fieldChanges(prefix: .max) }

    /// The first `count` changed fields in `fieldChanges` order; a feed row words only the ones it
    /// shows, since each value is a JSON round trip.
    public func fieldChanges(prefix count: Int) -> [AuditFieldChange] {
        (changes?.additionalProperties ?? [:]).sorted { $0.key < $1.key }.prefix(count).map {
            field, diff in
            AuditFieldChange(field: field, from: Self.text(diff.from), to: Self.text(diff.to))
        }
    }

    public var changedFieldCount: Int { changes?.additionalProperties.count ?? 0 }

    private static func text(_ value: JsonValue?) -> String? {
        guard let value,
            let data = try? encoder.encode(value),
            let json = try? decoder.decode(JSONValue.self, from: data)
        else { return nil }
        switch json {
        case .null: return nil
        case .string(let string): return string
        case .bool(let flag): return flag ? "Yes" : "No"
        case .number(let number): return DisplayFormat.number(number)
        default:
            // An `Amount` is the common object diff; it reads as "3 ea", not raw JSON.
            if let amount = json["value"]?.doubleValue, let unit = json["unit"]?.stringValue {
                return "\(DisplayFormat.number(amount)) \(unit)"
            }
            return String(decoding: data, as: UTF8.self)
        }
    }

    // Plain coders, shared: an audit diff holds no dates, and a feed words every shown value.
    private static let encoder = JSONEncoder()
    private static let decoder = JSONDecoder()
}
