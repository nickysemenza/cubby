import Foundation

/// One section of a list grouped by a declared `model.grouping` choice: the server's group
/// summary (`meta.groups`) over the whole filtered set, and the loaded rows that belong to it.
public struct EntityListSection: Identifiable, Sendable, Hashable {
    /// The no-value section's key (`FILTER_NONE`); it is always the last section.
    public static let noValueKey = "__none__"

    /// The section's value: a related record's public id, an enum value, or `noValueKey`.
    public let id: String
    public let label: String
    /// The section's rows in the whole filtered set, loaded or not.
    public let count: Int
    public let rows: [EntityRow]

    public init(id: String, label: String, count: Int, rows: [EntityRow]) {
        self.id = id
        self.label = label
        self.count = count
        self.rows = rows
    }

    /// The loaded rows split into the server's sections. The page and summary queries share one
    /// total order, so loaded rows are a prefix of the sections: each section takes its next
    /// `count` rows. A section with no loaded row yet is omitted.
    public static func sections(rows: [EntityRow], groups: [(key: String, label: String, count: Int)])
        -> [EntityListSection]
    {
        var sections: [EntityListSection] = []
        var remaining = rows[...]
        for group in groups where !remaining.isEmpty {
            let taken = remaining.prefix(group.count)
            remaining = remaining.dropFirst(taken.count)
            sections.append(.init(id: group.key, label: group.label, count: group.count, rows: Array(taken)))
        }
        return sections
    }
}

extension EntityDescriptor {
    /// The choice the list can group by now: declared, and without a reason it cannot group.
    public func groupChoice(_ key: String?) -> GroupChoice? {
        guard let key else { return nil }
        return grouping.first { $0.id == key && $0.reason == nil }
    }

    /// "Filter to this" on `section`: the section's value as the choice's include filter, with
    /// an "Include sub-…" toggle off so the filtered list keeps one section. Nil when the choice
    /// declares no filter, or for the no-value section of a filter without No value.
    public func filtering(
        _ state: EntityFilterState, to section: EntityListSection, of choice: GroupChoice
    ) -> EntityFilterState? {
        guard let binding = choice.filter,
            let filter = filters.first(where: { $0.columnId == binding.columnId }),
            case .param(let name) = filter.wire
        else { return nil }
        var next = state
        if section.id == EntityListSection.noValueKey {
            guard binding.noValue, let presence = filter.presenceParam else { return nil }
            next.remove(name)
            if let subtree = filter.subtreeParam { next.remove(subtree) }
            next.set(["none"], for: presence)
        } else {
            next.set([section.id], for: name)
            if let presence = filter.presenceParam { next.remove(presence) }
            if let subtree = filter.subtreeParam { next.set(["false"], for: subtree) }
        }
        return next
    }
}
