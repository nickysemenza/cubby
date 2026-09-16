import CubbyAPI
import Foundation

/// One node of `location.makeTree`: the generated `InfLocation`, whose tree fields are optional
/// on the wire because the same shape serves flat reads.
public typealias LocationTreeNode = InfLocation

extension InfLocation {
    public var childNodes: [InfLocation] { children ?? [] }
    public var directItems: Int { directItemCount ?? 0 }
    public var totalItems: Int { totalItemCount ?? 0 }
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
            for child in node.childNodes { visit(child, parent: node.id) }
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
            if node.directItems > 0 { out.append(node) }
            for child in node.childNodes { visit(child) }
        }
        visit(root)
        return out
    }

    /// Every location worth offering as a scope, depth-first with its depth: anything holding
    /// stock somewhere beneath it. An empty Unknown is noise, not a walk.
    public func scopeCandidates() -> [(node: LocationTreeNode, depth: Int)] {
        var out: [(LocationTreeNode, Int)] = []
        func visit(_ node: LocationTreeNode, depth: Int) {
            if node.totalItems > 0 || node.directItems > 0 { out.append((node, depth)) }
            for child in node.childNodes { visit(child, depth: depth + 1) }
        }
        for root in roots { visit(root, depth: 0) }
        return out
    }
}
