import Foundation
import Observation

/// The explored neighbourhood around one record: `entity.explore`'s page plus every
/// `entity.graph` page merged into it since. The wire types are the generated ones; only the
/// merge is ours.
public struct EntityGraph: Sendable, Hashable {
    public let root: EntityRef
    public let nodes: [EntityGraphNode]
    public let edges: [EntityGraphEdge]
    public let branches: [EntityGraphBranch]
    public let paths: [EntityGraphPath]
    public let completion: EntityGraphExploreCompletion
    public let truncated: Bool

    public init(
        root: EntityRef,
        nodes: [EntityGraphNode],
        edges: [EntityGraphEdge],
        branches: [EntityGraphBranch],
        paths: [EntityGraphPath],
        completion: EntityGraphExploreCompletion,
        truncated: Bool
    ) {
        self.root = root
        self.nodes = nodes
        self.edges = edges
        self.branches = branches
        self.paths = paths
        self.completion = completion
        self.truncated = truncated
    }

    public init(root: EntityRef, output: EntityGraphExploreOutput) {
        self.init(
            root: root, nodes: output.nodes, edges: output.edges, branches: output.branches,
            paths: output.paths, completion: output.completion, truncated: output.truncated)
    }

    /// Merges one canonical `entity.graph` page and extends loaded explanatory paths through the
    /// requested branch. The graph retains non-path cycle edges while paths stay simple and bounded.
    public func merging(_ page: EntityGraphOutput, for requestedBranch: EntityGraphBranch) -> EntityGraph {
        let nodesByID = Dictionary(
            (nodes + page.nodes).map { ($0.id, $0) }, uniquingKeysWith: { _, newer in newer })
        let edgesByID = Dictionary(
            (edges + page.edges).map { ($0.id, $0) }, uniquingKeysWith: { _, newer in newer })

        let returnedBranch = page.branches.first { $0.id == requestedBranch.id }
        let mergedRequestedBranch =
            returnedBranch.map { next in
                EntityGraphBranch(
                    root: requestedBranch.root,
                    relationshipKey: requestedBranch.relationshipKey,
                    label: next.label,
                    target: next.target,
                    totalCount: next.totalCount,
                    nextOffset: next.nextOffset,
                    items: Self.uniqued(requestedBranch.items + next.items),
                    edgeIds: Self.uniqued(requestedBranch.edgeIds + next.edgeIds)
                )
            } ?? requestedBranch

        let branchesByID = Dictionary(
            (branches.filter { $0.id != requestedBranch.id } + [mergedRequestedBranch]
                + page.branches.filter { $0.id != requestedBranch.id })
                .map { ($0.id, $0) },
            uniquingKeysWith: { _, newer in newer }
        )
        let extendedPaths = Self.extendingPaths(
            paths,
            root: root,
            requestedBranch: requestedBranch,
            returnedBranch: returnedBranch,
            pageEdges: page.edges
        )
        return EntityGraph(
            root: root,
            nodes: nodesByID.values.sorted { $0.id < $1.id },
            edges: edgesByID.values.sorted { $0.id < $1.id },
            branches: branchesByID.values.sorted { $0.id < $1.id },
            paths: extendedPaths,
            completion: completion,
            truncated: truncated || page.truncated
        )
    }

    private static func uniqued<T: Hashable>(_ values: [T]) -> [T] {
        var seen: Set<T> = []
        return values.filter { seen.insert($0).inserted }
    }

    private static func extendingPaths(
        _ existing: [EntityGraphPath],
        root: EntityRef,
        requestedBranch: EntityGraphBranch,
        returnedBranch: EntityGraphBranch?,
        pageEdges: [EntityGraphEdge]
    ) -> [EntityGraphPath] {
        guard let returnedBranch else { return existing }
        let bases =
            requestedBranch.root == root
            ? [EntityGraphPath(nodeRefs: [root], edgeIds: [])]
            : existing.filter { $0.destination == requestedBranch.root }
        guard !bases.isEmpty else { return existing }

        let branchEdgeIDs = Set(returnedBranch.edgeIds)
        var candidates: [EntityGraphPath] = []
        for item in returnedBranch.items.sorted(by: { $0.stableKey < $1.stableKey }) {
            let edges = pageEdges.filter { edge in
                branchEdgeIDs.contains(edge.id)
                    && ((edge.source == requestedBranch.root && edge.target == item)
                        || (edge.target == requestedBranch.root && edge.source == item))
            }.sorted { $0.id < $1.id }
            for base in bases.sorted(by: { $0.id < $1.id }) where !base.nodeRefs.contains(item) {
                for edge in edges where base.edgeIds.count < 8 && base.nodeRefs.count < 9 {
                    candidates.append(
                        EntityGraphPath(
                            nodeRefs: base.nodeRefs + [item],
                            edgeIds: base.edgeIds + [edge.id]
                        ))
                }
            }
        }

        var result = existing
        var seen = Set(existing.map(\.id))
        var countByDestination: [EntityRef: Int] = [:]
        for path in existing {
            if let destination = path.destination {
                countByDestination[destination, default: 0] += 1
            }
        }
        for candidate in candidates.sorted(by: { $0.id < $1.id }) {
            guard let destination = candidate.destination,
                countByDestination[destination, default: 0] < 3,
                seen.insert(candidate.id).inserted
            else { continue }
            result.append(candidate)
            countByDestination[destination, default: 0] += 1
        }
        return result
    }
}

public enum ActionableRelationshipRecommendation: Sendable, Hashable, Identifiable {
    case expenseProject(ExpenseProjectProposal)
    case inventoryPlacement(InventoryPlacementProposal)

    public var id: String {
        switch self {
        case .expenseProject(let proposal): proposal.id
        case .inventoryPlacement(let proposal): proposal.id
        }
    }

    public var subject: EntityRef {
        switch self {
        case .expenseProject(let proposal):
            EntityRef(entity: .expense, id: proposal.expenseId)
        case .inventoryPlacement(let proposal):
            EntityRef(entity: .inventory, id: proposal.inventoryId.rawValue)
        }
    }
}

/// The record that survives an accepted relationship mutation. Inventory moves can coalesce the
/// source into stock already at the destination, so this may differ from the proposal's subject.
public struct RelationshipAcceptance: Sendable, Hashable {
    public let recommendation: ActionableRelationshipRecommendation
    public let destination: EntityRef

    public init(
        recommendation: ActionableRelationshipRecommendation,
        destination: EntityRef
    ) {
        self.recommendation = recommendation
        self.destination = destination
    }

    public var replacedSubject: Bool { recommendation.subject != destination }
}

/// Boundary used by the shared observable model and by small deterministic test clients.
public protocol EntityRelationshipsClient: Sendable {
    func exploreRelationships(root: EntityRef, depth: Int) async throws -> EntityGraph
    func relationshipPage(
        root: EntityRef,
        relationshipKey: String,
        offset: Int,
        limit: Int
    ) async throws -> EntityGraphOutput
    func recommendations(for source: EntityRef) async throws -> EntityRecommendationsOut
    func assignExpense(_ expenseID: String, toProject projectID: String) async throws
    func moveInventory(_ inventoryID: String, to locationID: String) async throws -> EntityRef
}

@MainActor
@Observable
public final class EntityRelationshipsModel {
    public enum Phase: Equatable {
        case idle, loading, loaded, failed(String)
    }

    public enum Activity: Equatable {
        case idle, loadingInitial, refreshing
    }

    public private(set) var source: EntityRef?
    public private(set) var graph: EntityGraph?
    public private(set) var recommendationDocument: EntityRecommendationsOut?
    public private(set) var phase: Phase = .idle
    public private(set) var activity: Activity = .idle
    public private(set) var graphError: String?
    public private(set) var recommendationError: String?
    public private(set) var collapsedBranchIDs: Set<String> = []
    public private(set) var pagingBranchIDs: Set<String> = []
    public private(set) var pageErrors: [String: String] = [:]
    public private(set) var selectedNode: EntityRef?
    public private(set) var selectedPathIndex = 0
    public private(set) var acceptingRecommendationID: String?
    public private(set) var acceptError: String?
    public private(set) var depth = 1
    public private(set) var showsEmptyBranches = false

    public var displayedBranches: [EntityGraphBranch] {
        guard let graph else { return [] }
        return graph.branches.filter { showsEmptyBranches || $0.totalCount > 0 || !$0.items.isEmpty }
    }

    public var hasEmptyBranches: Bool {
        graph?.branches.contains { $0.totalCount == 0 && $0.items.isEmpty } == true
    }

    public var visibleGraph: EntityGraph? {
        guard let graph else { return nil }
        let hiddenEdgeIDs = Set(
            graph.branches.filter { collapsedBranchIDs.contains($0.id) }.flatMap(\.edgeIds))
        let candidateEdges = graph.edges.filter { !hiddenEdgeIDs.contains($0.id) }
        var reachable: Set<EntityRef> = [graph.root]
        var changed = true
        while changed {
            changed = false
            for edge in candidateEdges {
                if reachable.contains(edge.source), reachable.insert(edge.target).inserted { changed = true }
                if reachable.contains(edge.target), reachable.insert(edge.source).inserted { changed = true }
            }
        }
        return EntityGraph(
            root: graph.root,
            nodes: graph.nodes.filter { reachable.contains($0.reference) },
            edges: candidateEdges.filter {
                reachable.contains($0.source) && reachable.contains($0.target)
            },
            branches: graph.branches,
            paths: graph.paths.filter { Set($0.nodeRefs).isSubset(of: reachable) },
            completion: graph.completion,
            truncated: graph.truncated
        )
    }

    public var selectedPath: EntityGraphPath? {
        let candidates = paths(to: selectedNode)
        guard candidates.indices.contains(selectedPathIndex) else { return candidates.first }
        return candidates[selectedPathIndex]
    }

    private let client: any EntityRelationshipsClient
    private let pageSize: Int
    private var requestGeneration = 0
    private var graphTask: Task<EntityGraph, Error>?
    private var recommendationTask: Task<EntityRecommendationsOut, Error>?
    private var pageTasks: [String: Task<EntityGraphOutput, Error>] = [:]
    private var acceptTask: Task<RelationshipAcceptance, Error>?

    public init(
        client: any EntityRelationshipsClient,
        pageSize: Int = 12,
        initialGraph: EntityGraph? = nil,
        initialRecommendations: EntityRecommendationsOut? = nil
    ) {
        self.client = client
        self.pageSize = pageSize
        graph = initialGraph
        recommendationDocument = initialRecommendations
        source = initialGraph?.root ?? initialRecommendations.map { EntityRef($0.source) }
        if source != nil { phase = .loaded }
    }

    public func loadInitial(source: EntityRef) async {
        guard self.source != source || phase != .loaded else { return }
        await load(
            source: source,
            graphRoot: source,
            retainingContent: self.source == source && graph != nil
        )
    }

    public func refresh() async {
        guard let source else { return }
        await load(source: source, graphRoot: graph?.root ?? source, retainingContent: graph != nil)
    }

    public func setDepth(_ requestedDepth: Int) async {
        let clamped = min(3, max(1, requestedDepth))
        guard clamped != depth else { return }
        depth = clamped
        await refresh()
    }

    /// Starts the depth refresh from a synchronous SwiftUI control action.
    /// Keeping the task here avoids an Xcode 26.6 IR-generation crash in the
    /// large relationship view while retaining `setDepth` for awaited callers.
    public func requestDepth(_ requestedDepth: Int) {
        Task { @MainActor [self] in
            await setDepth(requestedDepth)
        }
    }

    public func requestRefresh() {
        Task { @MainActor [self] in
            await refresh()
        }
    }

    public func requestNextPage(for branch: EntityGraphBranch) {
        Task { @MainActor [self] in
            await loadNextPage(for: branch)
        }
    }

    public func focus(on reference: EntityRef) async {
        guard let source, graph?.nodes.contains(where: { $0.reference == reference }) == true else {
            return
        }
        await load(source: source, graphRoot: reference, retainingContent: graph != nil)
        if graph?.root == reference { select(reference) }
    }

    public func setShowsEmptyBranches(_ showsEmptyBranches: Bool) {
        self.showsEmptyBranches = showsEmptyBranches
    }

    public func toggle(_ branch: EntityGraphBranch) {
        if collapsedBranchIDs.contains(branch.id) {
            collapsedBranchIDs.remove(branch.id)
        } else {
            collapsedBranchIDs.insert(branch.id)
            if let selectedNode,
                visibleGraph?.nodes.contains(where: { $0.reference == selectedNode }) != true
            {
                select(nil)
            }
        }
    }

    public func loadNextPage(for branch: EntityGraphBranch) async {
        guard let offset = branch.nextOffset, !pagingBranchIDs.contains(branch.id) else { return }
        pageErrors[branch.id] = nil
        pagingBranchIDs.insert(branch.id)
        let generation = requestGeneration
        let client = client
        let task = Task {
            try Task.checkCancellation()
            return try await client.relationshipPage(
                root: branch.root,
                relationshipKey: branch.relationshipKey,
                offset: offset,
                limit: pageSize
            )
        }
        pageTasks[branch.id] = task
        do {
            let page = try await task.value
            guard generation == requestGeneration else { return }
            graph = graph?.merging(page, for: branch)
        } catch is CancellationError {
            // A new source or depth owns the graph now.
        } catch {
            guard generation == requestGeneration else { return }
            pageErrors[branch.id] = Self.describe(error)
        }
        guard generation == requestGeneration else { return }
        pageTasks[branch.id] = nil
        pagingBranchIDs.remove(branch.id)
    }

    public func select(_ node: EntityRef?) {
        selectedNode = node
        selectedPathIndex = 0
    }

    public func selectPath(at index: Int) {
        guard paths(to: selectedNode).indices.contains(index) else { return }
        selectedPathIndex = index
    }

    public func paths(to node: EntityRef?) -> [EntityGraphPath] {
        guard let node else { return [] }
        return visibleGraph?.paths.filter { $0.destination == node } ?? []
    }

    @discardableResult
    public func accept(
        _ recommendation: ActionableRelationshipRecommendation,
        basisKey: String
    ) async -> RelationshipAcceptance? {
        guard recommendationDocument?.basisKey == basisKey,
            acceptingRecommendationID == nil,
            activity == .idle,
            let source
        else { return nil }

        let generation = requestGeneration
        let recommendationID = recommendation.id
        acceptingRecommendationID = recommendation.id
        acceptError = nil
        let client = client
        let task = Task {
            try Task.checkCancellation()
            switch recommendation {
            case .expenseProject(let proposal):
                try await client.assignExpense(proposal.expenseId, toProject: proposal.target.id)
                return RelationshipAcceptance(
                    recommendation: recommendation,
                    destination: recommendation.subject
                )
            case .inventoryPlacement(let proposal):
                return RelationshipAcceptance(
                    recommendation: recommendation,
                    destination: try await client.moveInventory(
                        proposal.inventoryId.rawValue,
                        to: proposal.target.id.rawValue
                    )
                )
            }
        }
        acceptTask = task
        do {
            let acceptance = try await task.value
            guard generation == requestGeneration, self.source == source,
                acceptingRecommendationID == recommendationID
            else { return nil }
            acceptTask = nil
            acceptingRecommendationID = nil
            // A merged inventory source no longer exists. Its destination screen will load the
            // surviving row; refreshing this model would turn the successful action into a 404.
            if source != recommendation.subject || !acceptance.replacedSubject {
                await refresh()
            }
            return acceptance
        } catch is CancellationError {
            if generation == requestGeneration, acceptingRecommendationID == recommendationID {
                acceptTask = nil
                acceptingRecommendationID = nil
            }
            return nil
        } catch {
            if generation == requestGeneration, self.source == source,
                acceptingRecommendationID == recommendationID
            {
                acceptTask = nil
                acceptError = Self.describe(error)
                acceptingRecommendationID = nil
            }
            return nil
        }
    }

    private func load(
        source: EntityRef,
        graphRoot: EntityRef,
        retainingContent: Bool
    ) async {
        cancelRequests()
        requestGeneration += 1
        let generation = requestGeneration
        self.source = source
        graphError = nil
        recommendationError = nil
        acceptError = nil
        pageErrors = [:]
        activity = retainingContent ? .refreshing : .loadingInitial
        if !retainingContent {
            graph = nil
            recommendationDocument = nil
            collapsedBranchIDs = []
            showsEmptyBranches = false
            select(nil)
            phase = .loading
        }

        let client = client
        let depth = depth
        let nextGraphTask = Task {
            try Task.checkCancellation()
            return try await client.exploreRelationships(root: graphRoot, depth: depth)
        }
        let nextRecommendationTask = Task {
            try Task.checkCancellation()
            return try await client.recommendations(for: source)
        }
        graphTask = nextGraphTask
        recommendationTask = nextRecommendationTask

        do {
            let result = try await nextGraphTask.value
            if generation == requestGeneration {
                graph = result
                if let selectedNode,
                    !result.nodes.contains(where: { $0.reference == selectedNode })
                {
                    select(nil)
                } else if !paths(to: selectedNode).indices.contains(selectedPathIndex) {
                    selectedPathIndex = 0
                }
            }
        } catch is CancellationError {
            // A new source or depth owns the state now.
        } catch {
            if generation == requestGeneration { graphError = Self.describe(error) }
        }

        do {
            let result = try await nextRecommendationTask.value
            if generation == requestGeneration, EntityRef(result.source) == source {
                recommendationDocument = result
            }
        } catch is CancellationError {
            // A new source or depth owns the state now.
        } catch {
            if generation == requestGeneration { recommendationError = Self.describe(error) }
        }

        guard generation == requestGeneration else { return }
        graphTask = nil
        recommendationTask = nil
        activity = .idle
        if graph == nil, recommendationDocument == nil {
            let message = graphError ?? recommendationError ?? "Relationships are unavailable"
            phase = .failed(message)
        } else {
            phase = .loaded
        }
    }

    private func cancelRequests() {
        graphTask?.cancel()
        recommendationTask?.cancel()
        pageTasks.values.forEach { $0.cancel() }
        acceptTask?.cancel()
        graphTask = nil
        recommendationTask = nil
        pageTasks = [:]
        acceptTask = nil
        acceptingRecommendationID = nil
        pagingBranchIDs = []
    }

    private static func describe(_ error: any Error) -> String {
        if let apiError = error as? CubbyAPIError {
            let code = apiError.detail?.code ?? "HTTP_\(apiError.status)"
            let message = apiError.detail?.message ?? "Request failed"
            return "\(code): \(message)"
        }
        return String(describing: error)
    }
}
