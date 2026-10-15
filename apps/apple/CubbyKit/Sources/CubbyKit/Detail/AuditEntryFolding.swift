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
        let spaced = field.replacingOccurrences(
            of: "([a-z0-9])([A-Z])", with: "$1 $2", options: .regularExpression
        ).replacingOccurrences(of: "_", with: " ").lowercased()
        return spaced.prefix(1).uppercased() + spaced.dropFirst()
    }
}

extension AuditLogEntryOut {
    /// The entry's changed fields, sorted by name for a stable order.
    public var fieldChanges: [AuditFieldChange] {
        (changes?.additionalProperties ?? [:]).sorted { $0.key < $1.key }.map { field, diff in
            AuditFieldChange(field: field, from: Self.text(diff.from), to: Self.text(diff.to))
        }
    }

    private static func text(_ value: JsonValue?) -> String? {
        guard let value,
            let data = try? JSONEncoder().encode(value),
            let json = try? JSONDecoder().decode(JSONValue.self, from: data)
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
}
