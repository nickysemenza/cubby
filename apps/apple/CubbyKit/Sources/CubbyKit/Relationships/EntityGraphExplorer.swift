import Foundation
import Observation

/// Read-only exploration owns its map independently of detail recommendations and mutations.
@MainActor @Observable
public final class EntityGraphExplorer {
    nonisolated public static let nodeLimit = 500
    nonisolated public static let edgeLimit = 1_000
    nonisolated public static let pageSize = 12

    public private(set) var graph: EntityGraph?
    public private(set) var visibleGraph: EntityGraph?
    public private(set) var selectedNode: EntityReference?
    public var selectedEdgeID: String?
    public private(set) var history: [EntityReference] = []
    public private(set) var historyIndex = 0
    public private(set) var busy: Set<String> = []
    public private(set) var errors: [String: String] = [:]
    public private(set) var expanded: Set<EntityReference> = []
    public private(set) var counts: [String: Int] = [:]
    public private(set) var loading = false
    private let client: any EntityRelationshipsClient
    private var generation = 0
    private var tasks: [String: Task<EntityGraphPage, Error>] = [:]

    public init(client: any EntityRelationshipsClient, initialGraph: EntityGraph? = nil) {
        self.client = client
        if let initialGraph {
            graph = Self.merge(nil, page: Self.page(initialGraph), root: initialGraph.root)
            selectedNode = initialGraph.root
            history = [initialGraph.root]
            expanded = [initialGraph.root]
            rebuildVisible()
        }
    }

    public var atCapacity: Bool {
        (graph?.nodes.count ?? 0) >= Self.nodeLimit || (graph?.edges.count ?? 0) >= Self.edgeLimit
    }

    public func start(at root: EntityReference) async {
        generation += 1
        let requestGeneration = generation
        for task in tasks.values { task.cancel() }
        tasks.removeAll()
        graph = nil; visibleGraph = nil; counts = [:]; expanded = []; busy = []; errors = [:]
        selectedNode = root; selectedEdgeID = nil; history = [root]; historyIndex = 0; loading = true
        let client = client
        let task = Task { Self.page(try await client.exploreRelationships(root: root, depth: 1)) }
        tasks[root.stableKey] = task
        do {
            let page = try await task.value
            guard requestGeneration == generation else { return }
            graph = Self.merge(nil, page: page, root: root)
            expanded.insert(root)
            rebuildVisible()
        } catch {
            guard requestGeneration == generation else { return }
            if !(error is CancellationError) { errors[root.stableKey] = error.localizedDescription }
        }
        guard requestGeneration == generation else { return }
        tasks[root.stableKey] = nil
        loading = false
    }

    public func select(_ reference: EntityReference) {
        guard graph?.nodes.contains(where: { $0.reference == reference }) == true else { return }
        selectedNode = reference; selectedEdgeID = nil
        if history.indices.contains(historyIndex), history[historyIndex] == reference { return }
        history = Array((Array(history.prefix(historyIndex + 1)) + [reference]).suffix(32))
        historyIndex = history.count - 1
    }

    public func moveHistory(by offset: Int) {
        guard !history.isEmpty else { return }
        historyIndex = min(history.count - 1, max(0, historyIndex + offset))
        selectedNode = history[historyIndex]
        selectedEdgeID = nil
    }

    public func shownCount(for branch: EntityGraphBranch) -> Int {
        min(
            branch.items.count,
            counts[branch.id] ?? (branch.totalCount <= Self.pageSize ? branch.items.count : 0))
    }

    public func expand(_ reference: EntityReference) async {
        guard let root = graph?.root, !atCapacity, !expanded.contains(reference) else { return }
        let requestGeneration = generation
        let client = client
        let page = await read(key: reference.stableKey) {
            Self.page(try await client.exploreRelationships(root: reference, depth: 1))
        }
        guard let page, requestGeneration == generation else { return }
        graph = Self.merge(graph, page: page, root: root)
        expanded.insert(reference)
        rebuildVisible()
    }

    public func showMore(_ branch: EntityGraphBranch) async {
        guard let root = graph?.root else { return }
        let requestGeneration = generation
        let desired = min(branch.totalCount, shownCount(for: branch) + Self.pageSize)
        if branch.items.count >= desired || branch.nextOffset == nil {
            counts[branch.id] = desired
            rebuildVisible()
            return
        }
        guard !atCapacity, let offset = branch.nextOffset else { return }
        let client = client
        let page = await read(key: branch.id) {
            try await client.relationshipPage(
                root: branch.root, relationshipKey: branch.relationshipKey,
                offset: offset, limit: Self.pageSize)
        }
        guard let page, requestGeneration == generation else { return }
        graph = Self.merge(graph, page: page, root: root)
        counts[branch.id] = desired
        rebuildVisible()
    }

    public func collapse(_ branch: EntityGraphBranch) {
        counts[branch.id] = 0
        rebuildVisible()
        if let selectedNode, visibleGraph?.nodes.contains(where: { $0.reference == selectedNode }) != true {
            self.selectedNode = branch.root
        }
    }

    private func read(key: String, operation: @escaping @Sendable () async throws -> EntityGraphPage) async
        -> EntityGraphPage?
    {
        guard !busy.contains(key) else { return nil }
        busy.insert(key); errors[key] = nil
        let requestGeneration = generation
        let task = Task { try await operation() }
        tasks[key] = task
        defer {
            if requestGeneration == generation { busy.remove(key); tasks[key] = nil }
        }
        do {
            let page = try await task.value
            return requestGeneration == generation ? page : nil
        } catch {
            if requestGeneration == generation, !(error is CancellationError) {
                errors[key] = error.localizedDescription
            }
            return nil
        }
    }

    private func rebuildVisible() {
        guard let graph else { visibleGraph = nil; return }
        let edgesByID = Dictionary(graph.edges.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        var allowed: Set<String> = []
        for branch in graph.branches {
            let members = Set(branch.items.prefix(shownCount(for: branch)))
            for id in branch.edgeIDs {
                if let edge = edgesByID[id], members.contains(edge.source) || members.contains(edge.target) {
                    allowed.insert(id)
                }
            }
        }
        var adjacency: [EntityReference: [(EntityReference, String)]] = [:]
        for edge in graph.edges where allowed.contains(edge.id) {
            adjacency[edge.source, default: []].append((edge.target, edge.id))
            adjacency[edge.target, default: []].append((edge.source, edge.id))
        }
        var reached: Set<EntityReference> = [graph.root]
        var queue = [graph.root]
        var paths: [EntityReference: EntityGraphPath] = [
            graph.root: .init(nodeReferences: [graph.root], edgeIDs: [])
        ]
        var cursor = 0
        while cursor < queue.count {
            let current = queue[cursor]; cursor += 1
            for (next, edge) in adjacency[current] ?? [] where reached.insert(next).inserted {
                queue.append(next)
                if let path = paths[current], path.edgeIDs.count < 8 {
                    paths[next] = .init(
                        nodeReferences: path.nodeReferences + [next], edgeIDs: path.edgeIDs + [edge])
                }
            }
        }
        visibleGraph = EntityGraph(
            root: graph.root, nodes: graph.nodes.filter { reached.contains($0.reference) },
            edges: graph.edges.filter {
                allowed.contains($0.id) && reached.contains($0.source) && reached.contains($0.target)
            },
            branches: graph.branches, paths: paths.values.sorted { $0.id < $1.id },
            completion: graph.completion, truncated: graph.truncated)
    }

    nonisolated private static func page(_ graph: EntityGraph) -> EntityGraphPage {
        .init(nodes: graph.nodes, edges: graph.edges, branches: graph.branches, truncated: graph.truncated)
    }

    /// One budget across all pages; retain earlier identities when incoming pages exceed it.
    nonisolated public static func merge(_ graph: EntityGraph?, page: EntityGraphPage, root: EntityReference)
        -> EntityGraph
    {
        var nodes = graph?.nodes ?? []
        var nodeIDs = Set(nodes.map(\.id))
        for node in page.nodes where !nodeIDs.contains(node.id) && nodes.count < nodeLimit {
            nodes.append(node); nodeIDs.insert(node.id)
        }
        var edges = graph?.edges ?? []
        var edgeIDs = Set(edges.map(\.id))
        for edge in page.edges
        where !edgeIDs.contains(edge.id) && edges.count < edgeLimit && nodeIDs.contains(edge.source.stableKey)
            && nodeIDs.contains(edge.target.stableKey)
        {
            edges.append(edge); edgeIDs.insert(edge.id)
        }
        var branches = graph?.branches ?? []
        for next in page.branches where nodeIDs.contains(next.root.stableKey) {
            let index = branches.firstIndex { $0.id == next.id }
            let old = index.map { branches[$0] }
            var seenItems: Set<EntityReference> = []
            var seenEdges: Set<String> = []
            let branch = EntityGraphBranch(
                root: next.root, relationshipKey: next.relationshipKey, label: next.label,
                target: next.target,
                totalCount: next.totalCount, nextOffset: next.nextOffset,
                items: ((old?.items ?? []) + next.items).filter {
                    nodeIDs.contains($0.stableKey) && seenItems.insert($0).inserted
                },
                edgeIDs: ((old?.edgeIDs ?? []) + next.edgeIDs).filter {
                    edgeIDs.contains($0) && seenEdges.insert($0).inserted
                })
            if let index { branches[index] = branch } else { branches.append(branch) }
        }
        return .init(
            root: root, nodes: nodes, edges: edges, branches: branches, paths: [],
            completion: graph?.completion ?? .init(status: .depthLimit, requestedDepth: 1, reachedDepth: 1),
            truncated: (graph?.truncated ?? false) || page.truncated)
    }
}
