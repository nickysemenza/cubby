import Foundation
import Testing

@testable import CubbyKit

@Suite("Entity relationships", .timeLimit(.minutes(1)))
struct EntityRelationshipsTests {
    @Test func graphPageMergeDeduplicatesAndAdvancesOnlyTheRequestedBranch() throws {
        let root = ref(.product, "PRD-1001")
        let first = ref(.expense, "EXP-1001")
        let second = ref(.expense, "EXP-1002")
        let initialBranch = branch(root: root, items: [first], edgeIds: ["edge-1"], nextOffset: 1)
        let graph = EntityGraph(
            root: root,
            nodes: [node(root, "Drill"), node(first, "First purchase")],
            edges: [edge("edge-1", root, first)],
            branches: [initialBranch],
            paths: [EntityGraphPath(nodeRefs: [root, first], edgeIds: ["edge-1"])],
            completion: .init(status: .paginationLimit, requestedDepth: 1, reachedDepth: 1),
            truncated: true
        )
        let nextBranch = branch(
            root: root, items: [first, second], edgeIds: ["edge-1", "edge-2"], nextOffset: nil)
        let page = EntityGraphOutput(
            nodes: [node(first, "First purchase"), node(second, "Second purchase")],
            edges: [
                edge("edge-1", root, first),
                edge("edge-2", root, second),
                edge("edge-cycle", second, first),
            ],
            branches: [nextBranch],
            truncated: false
        )

        let merged = graph.merging(page, for: initialBranch)

        #expect(merged.nodes.map(\.id) == [root, first, second].map(\.stableKey).sorted())
        #expect(merged.edges.map(\.id) == ["edge-1", "edge-2", "edge-cycle"])
        let mergedBranch = try #require(merged.branches.first)
        #expect(mergedBranch.items == [first, second])
        #expect(mergedBranch.nextOffset == nil)
        #expect(merged.paths.contains(graph.paths[0]))
        let secondPath = try #require(merged.paths.first { $0.destination == second })
        #expect(secondPath.nodeRefs == [root, second])
        #expect(secondPath.edgeIds == ["edge-2"])
        #expect(merged.paths.filter { $0.destination == second }.count == 1)
    }

    @Test func measuredLayoutIsDeterministicAndKeepsLayersApart() throws {
        let root = ref(.product, "PRD-1001")
        let expense = ref(.expense, "EXP-1001")
        let otherExpense = ref(.expense, "EXP-1002")
        let project = ref(.project, "PRJ-1001")
        let graph = EntityGraph(
            root: root,
            nodes: [
                node(project, "Workshop"), node(root, "Drill"), node(expense, "Receipt"),
                node(otherExpense, "Second receipt"),
            ],
            edges: [
                edge("edge-2", expense, project), edge("edge-1", root, expense),
                edge("edge-3", root, otherExpense),
            ],
            branches: [],
            paths: [],
            completion: .init(status: .exhausted, requestedDepth: 2, reachedDepth: 2),
            truncated: false
        )
        let sizes: [String: EntityGraphNodeSize] = [
            root.stableKey: .init(width: 180, height: 80),
            expense.stableKey: .init(width: 220, height: 120),
            otherExpense.stableKey: .init(width: 180, height: 196),
            project.stableKey: .init(width: 160, height: 72),
        ]

        let first = EntityGraphLayout.arrange(graph: graph, measuredSizes: sizes)
        let second = EntityGraphLayout.arrange(graph: graph, measuredSizes: sizes)

        #expect(first == second)
        let rootPoint = try #require(first.centers[root.stableKey])
        let expensePoint = try #require(first.centers[expense.stableKey])
        let otherExpensePoint = try #require(first.centers[otherExpense.stableKey])
        let projectPoint = try #require(first.centers[project.stableKey])
        #expect(rootPoint.x < expensePoint.x)
        #expect(expensePoint.x < projectPoint.x)
        #expect(expensePoint.x == otherExpensePoint.x)
        #expect(abs(expensePoint.y - otherExpensePoint.y) >= (120 + 196) / 2 + 24)
        #expect(first.height >= 404)
    }

    @Test @MainActor func newerSourceWinsWhenAnEarlierRequestFinishesLater() async throws {
        let first = ref(.product, "PRD-1001")
        let second = ref(.location, "LOC-1001")
        let client = SuspendedRelationshipClient(
            firstSource: first,
            graphs: [
                first: singleNodeGraph(first),
                second: singleNodeGraph(second),
            ])
        let model = EntityRelationshipsModel(client: client)

        let firstLoad = Task { await model.loadInitial(source: first) }
        await client.first.arrivals(1)
        await model.loadInitial(source: second)
        client.first.open()
        await firstLoad.value

        #expect(model.source == second)
        #expect(model.graph?.root == second)
        #expect(model.relatednessDocument?.items.first?.shortcode == second.id)
    }

    @Test @MainActor func failedRefreshRetainsLoadedGraphAndRelatedness() async throws {
        let root = ref(.product, "PRD-1001")
        let client = RelationshipClientStub(graphs: [root: singleNodeGraph(root)])
        let model = EntityRelationshipsModel(client: client)
        await model.loadInitial(source: root)
        await client.setFailure(true)

        await model.refresh()

        #expect(model.phase == .loaded)
        #expect(model.graph?.root == root)
        #expect(model.relatednessDocument?.items.first?.shortcode == root.id)
        #expect(model.graphError != nil)
        #expect(model.relatednessError != nil)
    }

    @Test @MainActor func depthKeepsRelatednessScopedToTheDetailSource() async {
        let detailSource = ref(.product, "PRD-1001")
        let client = RelationshipClientStub(graphs: [detailSource: singleNodeGraph(detailSource)])
        let model = EntityRelationshipsModel(client: client)
        await model.loadInitial(source: detailSource)

        await model.setDepth(3)

        #expect(model.source == detailSource)
        #expect(model.graph?.root == detailSource)
        #expect(model.relatednessDocument?.items.first?.shortcode == detailSource.id)
        #expect(model.depth == 3)
    }

}

private actor RelationshipClientStub: EntityRelationshipsClient {
    func discoveryRunSnapshot(runID: RunShortcode) throws -> RunSnapshot {
        throw URLError(.unsupportedURL)
    }

    func storedConnections(_ input: EntityGraphRootInput) async throws -> ConnectionDiscoveryOut {
        if shouldFail { throw URLError(.notConnectedToInternet) }
        return .init(source: .init(entityKind: input.entityKind, entityId: input.entityId), proposals: [])
    }
    func discoverConnections(_ input: EntityGraphRootInput) throws -> ConnectionDiscoveryOut {
        throw URLError(.unsupportedURL)
    }
    func reviewSuggestion(_ input: SuggestionReviewInput) throws -> SuggestionReviewOut {
        throw URLError(.unsupportedURL)
    }

    let graphs: [EntityRef: EntityGraph]
    var shouldFail = false

    init(graphs: [EntityRef: EntityGraph]) { self.graphs = graphs }

    func setFailure(_ value: Bool) { shouldFail = value }

    func exploreRelationships(root: EntityRef, depth: Int) throws -> EntityGraph {
        if shouldFail { throw URLError(.notConnectedToInternet) }
        return graphs[root]!
    }

    func relationshipPage(
        root: EntityRef,
        relationshipKey: String,
        offset: Int,
        limit: Int
    ) throws -> EntityGraphOutput {
        throw URLError(.unsupportedURL)
    }

    func relatedness(for source: EntityRef) throws -> RecommendationWorkbenchOut {
        if shouldFail { throw URLError(.notConnectedToInternet) }
        return RecommendationWorkbenchOut(
            status: .ready,
            items: [
                .init(entity: source.entity, shortcode: source.id, title: "Fixture", score: 1, evidence: [])
            ])
    }

}

private actor SuspendedRelationshipClient: EntityRelationshipsClient {
    func discoveryRunSnapshot(runID: RunShortcode) throws -> RunSnapshot {
        throw URLError(.unsupportedURL)
    }

    func storedConnections(_ input: EntityGraphRootInput) async throws -> ConnectionDiscoveryOut {
        return .init(source: .init(entityKind: input.entityKind, entityId: input.entityId), proposals: [])
    }
    func discoverConnections(_ input: EntityGraphRootInput) throws -> ConnectionDiscoveryOut {
        throw URLError(.unsupportedURL)
    }
    func reviewSuggestion(_ input: SuggestionReviewInput) throws -> SuggestionReviewOut {
        throw URLError(.unsupportedURL)
    }

    let firstSource: EntityRef
    let graphs: [EntityRef: EntityGraph]
    let first = Gate()

    init(firstSource: EntityRef, graphs: [EntityRef: EntityGraph]) {
        self.firstSource = firstSource
        self.graphs = graphs
    }

    func exploreRelationships(root: EntityRef, depth: Int) async throws -> EntityGraph {
        if root == firstSource {
            await first.hold()
            try Task.checkCancellation()
        }
        return graphs[root]!
    }

    func relationshipPage(
        root: EntityRef,
        relationshipKey: String,
        offset: Int,
        limit: Int
    ) throws -> EntityGraphOutput {
        throw URLError(.unsupportedURL)
    }

    func relatedness(for source: EntityRef) -> RecommendationWorkbenchOut {
        RecommendationWorkbenchOut(
            status: .ready,
            items: [
                .init(entity: source.entity, shortcode: source.id, title: "Fixture", score: 1, evidence: [])
            ])
    }

}

private func ref(_ entity: EntityKey, _ id: String) -> EntityRef {
    EntityRef(entity: entity, id: id)
}

private func node(_ reference: EntityRef, _ label: String) -> EntityGraphNode {
    EntityGraphNode(reference: reference, label: label)
}

private func edge(
    _ id: String,
    _ source: EntityRef,
    _ target: EntityRef
) -> EntityGraphEdge {
    EntityGraphEdge(
        relationshipKey: "related",
        label: "Related",
        sourceKey: "test",
        provenance: ["fixture"],
        id: id,
        source: source,
        target: target
    )
}

private func branch(
    root: EntityRef,
    items: [EntityRef],
    edgeIds: [String],
    nextOffset: Int?
) -> EntityGraphBranch {
    EntityGraphBranch(
        root: root,
        relationshipKey: "expenses",
        label: "Expenses",
        target: .expense,
        totalCount: 2,
        nextOffset: nextOffset,
        items: items,
        edgeIds: edgeIds
    )
}

private func singleNodeGraph(_ root: EntityRef) -> EntityGraph {
    EntityGraph(
        root: root,
        nodes: [node(root, root.id)],
        edges: [],
        branches: [],
        paths: [],
        completion: .init(status: .exhausted, requestedDepth: 1, reachedDepth: 0),
        truncated: false
    )
}
