import Foundation

/// One node of `location.makeTree`, hand-decoded because the schema is self-recursive (the
/// generator would need boxing) and because the tree never carries `parent`; the index below
/// derives parents from the nesting instead.
public struct LocationTreeNode: Sendable, Hashable, Identifiable, Decodable {
    public let id: LocationCode
    public let name: String
    public let type: String?
    public let directItemCount: Int
    public let totalItemCount: Int
    public let children: [LocationTreeNode]
    /// Kept verbatim; only displayed.
    public let lastBulkInventoryRaw: String?

    public init(
        id: LocationCode,
        name: String,
        type: String? = nil,
        directItemCount: Int = 0,
        totalItemCount: Int = 0,
        children: [LocationTreeNode] = [],
        lastBulkInventoryRaw: String? = nil
    ) {
        self.id = id
        self.name = name
        self.type = type
        self.directItemCount = directItemCount
        self.totalItemCount = totalItemCount
        self.children = children
        self.lastBulkInventoryRaw = lastBulkInventoryRaw
    }

    private enum CodingKeys: String, CodingKey {
        case id, name, type, directItemCount, totalItemCount, children, lastBulkInventory
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(LocationCode.self, forKey: .id)
        name = try container.decode(String.self, forKey: .name)
        type = try container.decodeIfPresent(String.self, forKey: .type)
        directItemCount = try container.decodeIfPresent(Int.self, forKey: .directItemCount) ?? 0
        totalItemCount = try container.decodeIfPresent(Int.self, forKey: .totalItemCount) ?? 0
        children = try container.decodeIfPresent([LocationTreeNode].self, forKey: .children) ?? []
        lastBulkInventoryRaw = try container.decodeIfPresent(String.self, forKey: .lastBulkInventory)
    }
}

/// The whole location tree with an index built once: parents, ancestors, breadcrumbs, and the
/// two derived lists the audit needs (bins to walk under a scope; scopes worth offering).
public struct LocationTree: Sendable, Hashable {
    public let roots: [LocationTreeNode]
    private let nodesByID: [LocationCode: LocationTreeNode]
    private let parentByID: [LocationCode: LocationCode]

    public init(roots: [LocationTreeNode]) {
        self.roots = roots
        var nodes: [LocationCode: LocationTreeNode] = [:]
        var parents: [LocationCode: LocationCode] = [:]
        func visit(_ node: LocationTreeNode, parent: LocationCode?) {
            nodes[node.id] = node
            if let parent { parents[node.id] = parent }
            for child in node.children { visit(child, parent: node.id) }
        }
        for root in roots { visit(root, parent: nil) }
        nodesByID = nodes
        parentByID = parents
    }

    public subscript(id: LocationCode) -> LocationTreeNode? { nodesByID[id] }

    public var count: Int { nodesByID.count }

    public func parent(of id: LocationCode) -> LocationTreeNode? {
        parentByID[id].flatMap { nodesByID[$0] }
    }

    /// Nearest first, root last. Empty for a root.
    public func ancestors(of id: LocationCode) -> [LocationTreeNode] {
        var out: [LocationTreeNode] = []
        var current = parentByID[id]
        while let id = current, let node = nodesByID[id] {
            out.append(node)
            current = parentByID[id]
        }
        return out
    }

    /// Root first, the node itself last. Empty when the id is unknown.
    public func breadcrumb(of id: LocationCode) -> [LocationTreeNode] {
        guard let node = nodesByID[id] else { return [] }
        return ancestors(of: id).reversed() + [node]
    }

    /// A parentless location. Home is the one that matters, but the global Unknown bin is a
    /// root too; both are refused as bins for the same reason (nothing above them to sit in).
    public func isRoot(_ id: LocationCode) -> Bool {
        nodesByID[id] != nil && parentByID[id] == nil
    }

    public func isDescendant(_ id: LocationCode, of ancestor: LocationCode) -> Bool {
        ancestors(of: id).contains { $0.id == ancestor }
    }

    /// The stops of a walk: the scope and every descendant, depth-first in tree order, that
    /// holds stock directly. A location with no direct items has no snapshot to reconcile, so
    /// it is not a stop (its stocked descendants still are).
    public func auditableBins(under scope: LocationCode) -> [LocationTreeNode] {
        guard let root = nodesByID[scope] else { return [] }
        var out: [LocationTreeNode] = []
        func visit(_ node: LocationTreeNode) {
            if node.directItemCount > 0 { out.append(node) }
            for child in node.children { visit(child) }
        }
        visit(root)
        return out
    }

    /// Every location worth offering as a scope, depth-first with its depth: anything holding
    /// stock somewhere beneath it. An empty Unknown is noise, not a walk.
    public func scopeCandidates() -> [(node: LocationTreeNode, depth: Int)] {
        var out: [(LocationTreeNode, Int)] = []
        func visit(_ node: LocationTreeNode, depth: Int) {
            if node.totalItemCount > 0 || node.directItemCount > 0 { out.append((node, depth)) }
            for child in node.children { visit(child, depth: depth + 1) }
        }
        for root in roots { visit(root, depth: 0) }
        return out
    }
}
