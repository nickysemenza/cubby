import Foundation

/// One section of a list grouped by a declared `model.grouping` choice: the server's group
/// summary (`meta.groups`) over the whole filtered set, and the loaded rows that belong to it.
public struct EntityListSection: Identifiable, Sendable, Hashable {
    /// The no-value section's key (`FILTER_NONE`); it is always the last section.
    public static let noValueKey = "__none__"

    /// The section's value: a related record's public id, an enum value, or `noValueKey`.
    public let id: String
    public let path: [String]
    public let label: String
    /// The section's rows in the whole filtered set, loaded or not.
    public let count: Int
    /// The section holds rows under its key's descendants (a list grouped at a hierarchy level),
    /// so its filter keeps "Include sub-…" on.
    public let subtree: Bool
    public let rows: [EntityRow]

    public init(
        id: String, label: String, count: Int, subtree: Bool = false, path: [String]? = nil, rows: [EntityRow]
    ) {
        self.id = id
        self.path = path ?? [id]
        self.label = label
        self.count = count
        self.subtree = subtree
        self.rows = rows
    }

    /// Leaf paths are explicit; roots remain unique while an overlapping row
    /// appears once in each section that contains its membership.
    public static func sections(
        rows: [EntityRow], groups: [(key: String, path: [String], label: String, count: Int, subtree: Bool)],
        memberships: [(id: String, path: [String])]
    ) -> [EntityListSection] {
        let byID = Dictionary(rows.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        return groups.compactMap { group in
            guard
                !groups.contains(where: {
                    $0.path.count > group.path.count && $0.path.starts(with: group.path)
                })
            else { return nil }
            var seen = Set<String>()
            let loaded = memberships.filter { $0.path == group.path }.compactMap { membership -> EntityRow? in
                guard seen.insert(membership.id).inserted else { return nil }
                return byID[membership.id]
            }
            guard !loaded.isEmpty else { return nil }
            let labels = (1...group.path.count).compactMap { length in
                groups.first(where: { $0.path == Array(group.path.prefix(length)) })?.label
            }
            return .init(
                id: group.key, label: labels.joined(separator: " / "), count: group.count,
                subtree: group.subtree, path: group.path, rows: loaded)
        }
    }

}

extension EntityDescriptor {
    /// The choice the list can group by now: declared, and without a reason it cannot group.
    public func groupChoice(_ key: String?) -> GroupChoice? {
        guard let key else { return nil }
        return grouping.first { $0.id == key && $0.reason == nil }
    }

    /// "Filter to this" on `section`: the section's value as the choice's include filter, so the
    /// filtered list keeps one section: an "Include sub-…" toggle stays on only for a level
    /// section that holds its key's descendants. Nil when the choice declares no filter, or for
    /// the no-value section of a filter without No value.
    public func filtering(
        _ state: EntityFilterState, to section: EntityListSection, of choice: GroupChoice
    ) -> EntityFilterState? {
        guard let binding = choice.filter,
            let filter = filters.first(where: { $0.columnId == binding.columnId }),
            case .param(let name) = filter.wire
        else { return nil }
        var next = state
        if section.path.last == EntityListSection.noValueKey {
            guard binding.noValue, let presence = filter.presenceParam else { return nil }
            next.remove(name)
            if let subtree = filter.subtreeParam { next.remove(subtree) }
            next.set(["none"], for: presence)
        } else {
            next.set([section.path.last ?? section.id], for: name)
            if let presence = filter.presenceParam { next.remove(presence) }
            if let subtree = filter.subtreeParam {
                next.set([section.subtree ? "true" : "false"], for: subtree)
            }
        }
        return next
    }

    /// "Hide" on `section`: the list keeps its grouping and drops the section. A value section
    /// joins the filter's excluded values (`excludeParam`), leaving its include values alone; a
    /// level section also turns "Include sub-…" on so its key's descendants go with it. The
    /// no-value section narrows presence instead: picked values alone drop their "or no value",
    /// otherwise the list keeps only rows with a value. Nil when the filter declares no
    /// `excludeParam` or, for the no-value section, no No value.
    public func hiding(
        _ state: EntityFilterState, section: EntityListSection, of choice: GroupChoice
    ) -> EntityFilterState? {
        guard let binding = choice.filter,
            let filter = filters.first(where: { $0.columnId == binding.columnId }),
            case .param(let name) = filter.wire
        else { return nil }
        var next = state
        if section.path.last == EntityListSection.noValueKey {
            guard binding.noValue, let presence = filter.presenceParam else { return nil }
            if state[name]?.isEmpty == false {
                next.remove(presence)
            } else {
                next.set(["has"], for: presence)
            }
            return next
        }
        guard let exclude = filter.excludeParam else { return nil }
        let excluded = state[exclude] ?? []
        if !excluded.contains(section.path.last ?? section.id) {
            next.set(excluded + [section.path.last ?? section.id], for: exclude)
        }
        if section.subtree, let subtree = filter.subtreeParam { next.remove(subtree) }
        return next
    }
}
