import CubbyAPI
import Foundation

/// A tree list's scope (`list.tree`), the server's `ListNesting`: the roots, one parent's
/// children, or one batch's members (`parentID` nil for a batch of roots). `batches` asks a roots
/// or children page to fold `list.tree.batch` siblings into `meta.batches`.
public enum ListNestingRequest: Sendable, Hashable {
    case roots(batches: Bool)
    case children(parentID: String, batches: Bool)
    case batch(parentID: String?, value: String)

    var json: JSONValue {
        switch self {
        case .roots(let batches):
            batches ? ["scope": "roots", "batches": true] : ["scope": "roots"]
        case .children(let parentID, let batches):
            batches
                ? ["scope": "children", "parentId": .string(parentID), "batches": true]
                : ["scope": "children", "parentId": .string(parentID)]
        case .batch(let parentID, let value):
            ["scope": "batch", "parentId": parentID.map(JSONValue.string) ?? .null, "value": .string(value)]
        }
    }
}

/// One visible line of a nested list, in reading order: a record, a batch of folded automatic
/// siblings, or a branch's paging and load state under its parent.
public struct EntityTreeNode: Identifiable, Sendable, Hashable {
    public enum Content: Sendable, Hashable {
        case record(EntityRow)
        case batch(ListBatch)
        case more(parentID: String)
        case loading(parentID: String)
        case failed(parentID: String, message: String)
    }

    public let id: String
    public let content: Content
    public let depth: Int
    public let expandable: Bool
    public let expanded: Bool

    /// The node id a batch row and its member branch share.
    public static func batchID(_ batch: ListBatch) -> String {
        "batch:\(batch.parentId ?? ""):\(batch.value)"
    }
}

/// One expanded node's loaded children: records and, for a record parent, its folded batches.
struct EntityTreeBranch: Sendable {
    var rows: [EntityRow] = []
    var batches: [ListBatch] = []
    var page = 0
    var hasMore = false
    var loading = false
    var error: String?
}

extension EntityRow {
    /// A roots or children page row's `childCount`: how many matching children it holds.
    public var treeChildCount: Int { raw["childCount"]?.doubleValue.map(Int.init) ?? 0 }
}

extension GenericEntityListModel {
    /// The phase a batch files under when grouped by phase: its most urgent member phase.
    static let batchPhaseOrder = ["needs", "active", "finished", "older"]

    /// The declared root batches a section shows: every root batch ungrouped, else those whose
    /// most urgent member phase (grouped by phase) or batch value (grouped by `batch.by`) is the
    /// section's key.
    public func rootBatches(in section: EntityListSection?) -> [ListBatch] {
        guard nests else { return [] }
        guard let section, let dimension = groupDimensions.first else { return rootBatches }
        return rootBatches.filter { batchSectionKey($0, dimension: dimension) == section.id }
    }

    func batchSectionKey(_ batch: ListBatch, dimension: ListGroupDimension) -> String? {
        if dimension.key == Self.phaseGroupingKey {
            return Self.batchPhaseOrder.first { (batch.phases[$0] ?? 0) > 0 }
        }
        return dimension.key == descriptor.presentation.listTree?.batchBy ? batch.value : nil
    }

    /// The visible lines under `roots` and `batches`, expanded branches inline at their depth.
    public func treeNodes(roots: [EntityRow], batches: [ListBatch]) -> [EntityTreeNode] {
        var nodes: [EntityTreeNode] = []
        appendNodes(rows: roots, batches: batches, depth: 0, into: &nodes)
        return nodes
    }

    private func appendNodes(
        rows: [EntityRow], batches: [ListBatch], depth: Int, into nodes: inout [EntityTreeNode]
    ) {
        for batch in batches {
            let id = EntityTreeNode.batchID(batch)
            let expanded = expandedNodes.contains(id)
            nodes.append(
                EntityTreeNode(id: id, content: .batch(batch), depth: depth, expandable: true, expanded: expanded))
            if expanded { appendBranch(id, depth: depth + 1, into: &nodes) }
        }
        for row in rows {
            let expanded = expandedNodes.contains(row.id)
            nodes.append(
                EntityTreeNode(
                    id: row.id, content: .record(row), depth: depth, expandable: row.treeChildCount > 0,
                    expanded: expanded))
            if expanded { appendBranch(row.id, depth: depth + 1, into: &nodes) }
        }
    }

    private func appendBranch(_ id: String, depth: Int, into nodes: inout [EntityTreeNode]) {
        guard let branch = branches[id] else { return }
        appendNodes(rows: branch.rows, batches: branch.batches, depth: depth, into: &nodes)
        if branch.loading {
            nodes.append(.init(id: "\(id)#loading", content: .loading(parentID: id), depth: depth, expandable: false, expanded: false))
        } else if let error = branch.error {
            nodes.append(
                .init(
                    id: "\(id)#failed", content: .failed(parentID: id, message: error), depth: depth,
                    expandable: false, expanded: false))
        } else if branch.hasMore {
            nodes.append(.init(id: "\(id)#more", content: .more(parentID: id), depth: depth, expandable: false, expanded: false))
        }
    }

    /// Expands or collapses a record or batch node; the first expansion loads its first page.
    public func toggle(node id: String) async {
        if expandedNodes.contains(id) {
            expandedNodes.remove(id)
            return
        }
        expandedNodes.insert(id)
        if branches[id] == nil { await loadBranch(id) }
    }

    /// The next page of an expanded node's children (also its Retry after a failure).
    public func loadMoreChildren(of id: String) async {
        guard let branch = branches[id], !branch.loading else { return }
        await loadBranch(id)
    }

    /// The scope a node's children read: a batch's members, else a record's children.
    private func nesting(for id: String) -> ListNestingRequest? {
        let batch =
            rootBatches.first { EntityTreeNode.batchID($0) == id }
            ?? branches.values.lazy.flatMap(\.batches).first { EntityTreeNode.batchID($0) == id }
        if let batch { return .batch(parentID: batch.parentId, value: batch.value) }
        return .children(parentID: id, batches: descriptor.presentation.listTree?.batchBy != nil)
    }

    func loadBranch(_ id: String) async {
        guard let nesting = nesting(for: id) else { return }
        var branch = branches[id] ?? EntityTreeBranch()
        if branch.error != nil, branch.page == 0 { branch.rows = [] }
        branch.loading = true
        branch.error = nil
        branches[id] = branch
        let generation = treeGeneration
        let page = branch.page + 1
        do {
            let result = try await treeLoader(nesting)(page)
            guard generation == treeGeneration, var current = branches[id] else { return }
            var ids = Set(current.rows.map(\.id))
            current.rows += result.items.filter { ids.insert($0.id).inserted }
            if page == 1 { current.batches = result.meta.batches ?? [] }
            current.page = page
            current.hasMore = result.meta.hasNextPage
            current.loading = false
            branches[id] = current
        } catch {
            guard generation == treeGeneration, var current = branches[id] else { return }
            current.loading = false
            if !(error is CancellationError) { current.error = error.userMessage }
            branches[id] = current
        }
    }

    /// After a fresh roots page, reloads the branches that stay expanded so a refresh keeps the
    /// reader's place; nodes that no longer exist collapse.
    func reloadExpandedBranches() async {
        treeGeneration += 1
        branches = [:]
        let wanted = expandedNodes
        var reachable = Set(rows.map(\.id)).union(rootBatches.map(EntityTreeNode.batchID))
        var pending = wanted.intersection(reachable)
        while let id = pending.first {
            pending.remove(id)
            await loadBranch(id)
            guard let branch = branches[id] else { continue }
            let children = Set(branch.rows.map(\.id)).union(branch.batches.map(EntityTreeNode.batchID))
            reachable.formUnion(children)
            pending.formUnion(wanted.intersection(children).subtracting(branches.keys))
        }
        expandedNodes = expandedNodes.intersection(reachable)
    }
}
