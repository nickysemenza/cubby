import Foundation
import Testing

@testable import CubbyKit

@Suite("Entity relationships")
struct EntityRelationshipsTests {
    @Test func graphPageMergeDeduplicatesAndAdvancesOnlyTheRequestedBranch() throws {
        let root = ref(.product, "PRD-1001")
        let first = ref(.expense, "EXP-1001")
        let second = ref(.expense, "EXP-1002")
        let initialBranch = branch(root: root, items: [first], edgeIDs: ["edge-1"], nextOffset: 1)
        let graph = EntityGraph(
            root: root,
            nodes: [node(root, "Drill"), node(first, "First purchase")],
            edges: [edge("edge-1", root, first)],
            branches: [initialBranch],
            paths: [EntityGraphPath(nodeReferences: [root, first], edgeIDs: ["edge-1"])],
            completion: .init(status: .paginationLimit, requestedDepth: 1, reachedDepth: 1),
            truncated: true
        )
        let nextBranch = branch(
            root: root, items: [first, second], edgeIDs: ["edge-1", "edge-2"], nextOffset: nil)
        let page = EntityGraphPage(
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
        #expect(secondPath.nodeReferences == [root, second])
        #expect(secondPath.edgeIDs == ["edge-2"])
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

    @Test @MainActor func collapsingABranchHidesOnlyNodesNoLongerReachable() async throws {
        let root = ref(.product, "PRD-1001")
        let expense = ref(.expense, "EXP-1001")
        let project = ref(.project, "PRJ-1001")
        let expenseBranch = branch(root: root, items: [expense], edgeIDs: ["edge-1"], nextOffset: nil)
        let graph = EntityGraph(
            root: root,
            nodes: [node(root, "Drill"), node(expense, "Receipt"), node(project, "Workshop")],
            edges: [edge("edge-1", root, expense), edge("edge-2", expense, project)],
            branches: [expenseBranch],
            paths: [],
            completion: .init(status: .exhausted, requestedDepth: 2, reachedDepth: 2),
            truncated: false
        )
        let client = RelationshipClientStub(graphs: [root: graph])
        let model = EntityRelationshipsModel(client: client)
        await model.loadInitial(source: root)

        model.toggle(expenseBranch)

        #expect(model.visibleGraph?.nodes.map(\.reference) == [root])
        #expect(model.visibleGraph?.edges.isEmpty == true)
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
        await client.waitUntilFirstRequestStarts()
        await model.loadInitial(source: second)
        await client.finishFirstRequest()
        await firstLoad.value

        #expect(model.source == second)
        #expect(model.graph?.root == second)
        #expect(model.recommendationDocument?.source == second)
    }

    @Test @MainActor func failedRefreshRetainsLoadedGraphAndRecommendations() async throws {
        let root = ref(.product, "PRD-1001")
        let client = RelationshipClientStub(graphs: [root: singleNodeGraph(root)])
        let model = EntityRelationshipsModel(client: client)
        await model.loadInitial(source: root)
        await client.setFailure(true)

        await model.refresh()

        #expect(model.phase == .loaded)
        #expect(model.graph?.root == root)
        #expect(model.recommendationDocument?.source == root)
        #expect(model.graphError != nil)
        #expect(model.recommendationError != nil)
    }

    @Test @MainActor func sourceChangeDuringAcceptanceCannotRefreshOrOverwriteTheNewSource() async {
        let expense = ref(.expense, "EXP-1001")
        let product = ref(.product, "PRD-1001")
        let client = SuspendedAcceptanceClient(graphs: [
            expense: singleNodeGraph(expense),
            product: singleNodeGraph(product),
        ])
        let model = EntityRelationshipsModel(client: client)
        await model.loadInitial(source: expense)
        let proposal = ExpenseProjectRecommendation(
            expenseID: expense.id,
            target: .init(id: "PRJ-1001", name: "Workshop"),
            effectiveStart: nil,
            effectiveEnd: nil,
            sameTradeCount: 1,
            exactProductCount: 0,
            supportingExpenses: [],
            reasons: ["Same trade"]
        )

        let acceptance = Task {
            await model.accept(.expenseProject(proposal), basisKey: "basis-\(expense.id)")
        }
        await client.waitUntilAcceptanceStarts()
        await model.loadInitial(source: product)
        await client.finishAcceptance()

        #expect(await acceptance.value == nil)
        #expect(model.source == product)
        #expect(model.graph?.root == product)
        #expect(model.recommendationDocument?.source == product)
        #expect(model.acceptingRecommendationID == nil)
        #expect(model.acceptError == nil)
    }

    @Test @MainActor func focusAndDepthKeepRecommendationsScopedToTheDetailSource() async {
        let detailSource = ref(.product, "PRD-1001")
        let focused = ref(.expense, "EXP-1001")
        let detailGraph = EntityGraph(
            root: detailSource,
            nodes: [node(detailSource, "Drill"), node(focused, "Receipt")],
            edges: [edge("edge-1", detailSource, focused)],
            branches: [],
            paths: [.init(nodeReferences: [detailSource, focused], edgeIDs: ["edge-1"])],
            completion: .init(status: .depthLimit, requestedDepth: 1, reachedDepth: 1),
            truncated: false
        )
        let client = RelationshipClientStub(graphs: [
            detailSource: detailGraph,
            focused: singleNodeGraph(focused),
        ])
        let model = EntityRelationshipsModel(client: client)
        await model.loadInitial(source: detailSource)

        await model.focus(on: focused)
        await model.setDepth(3)

        #expect(model.source == detailSource)
        #expect(model.graph?.root == focused)
        #expect(model.recommendationDocument?.source == detailSource)
        #expect(model.depth == 3)
        #expect(model.selectedNode == focused)
    }

    @Test @MainActor func emptyBranchesAreHiddenUntilExplicitlyShown() {
        let root = ref(.product, "PRD-1001")
        let related = ref(.expense, "EXP-1001")
        let populated = branch(
            root: root,
            items: [related],
            edgeIDs: ["edge-1"],
            nextOffset: nil
        )
        let empty = EntityGraphBranch(
            root: root,
            relationshipKey: "tasks",
            label: "Tasks",
            target: .task,
            totalCount: 0,
            nextOffset: nil,
            items: [],
            edgeIDs: []
        )
        let graph = EntityGraph(
            root: root,
            nodes: [node(root, "Drill"), node(related, "Receipt")],
            edges: [edge("edge-1", root, related)],
            branches: [empty, populated],
            paths: [],
            completion: .init(status: .exhausted, requestedDepth: 1, reachedDepth: 1),
            truncated: false
        )
        let model = EntityRelationshipsModel(
            client: RelationshipClientStub(graphs: [root: graph]),
            initialGraph: graph
        )

        #expect(model.hasEmptyBranches)
        #expect(model.displayedBranches == [populated])

        model.setShowsEmptyBranches(true)

        #expect(model.displayedBranches == [empty, populated])
    }

    @Test @MainActor func failedExpenseAcceptanceRetainsProposalAndRetryDispatchesUpdate() async {
        let root = ref(.expense, "EXP-1001")
        let proposal = ExpenseProjectRecommendation(
            expenseID: root.id,
            target: .init(id: "PRJ-1001", name: "Workshop"),
            effectiveStart: nil,
            effectiveEnd: nil,
            sameTradeCount: 2,
            exactProductCount: 1,
            supportingExpenses: [],
            reasons: ["Same trade"]
        )
        let recommendations = EntityRecommendations(
            source: root,
            basisKey: "expense-basis",
            groups: [.expenseProject(status: .ready, currentTarget: nil, proposals: [proposal])]
        )
        let client = RetryingAcceptanceClient(
            graph: singleNodeGraph(root),
            recommendations: recommendations
        )
        let model = EntityRelationshipsModel(
            client: client,
            initialGraph: singleNodeGraph(root),
            initialRecommendations: recommendations
        )

        let firstAccepted = await model.accept(.expenseProject(proposal), basisKey: "expense-basis")

        #expect(firstAccepted == nil)
        #expect(model.recommendationDocument == recommendations)
        #expect(model.acceptError != nil)

        let retryAccepted = await model.accept(.expenseProject(proposal), basisKey: "expense-basis")

        #expect(retryAccepted?.destination == root)
        #expect(model.acceptError == nil)
        #expect(
            await client.recordedActions() == [
                .expense(expenseID: "EXP-1001", projectID: "PRJ-1001"),
                .expense(expenseID: "EXP-1001", projectID: "PRJ-1001"),
            ])
    }

    @Test @MainActor func failedInventoryAcceptanceRetainsProposalAndRetryDispatchesMove() async {
        let root = ref(.inventory, "INV-1001")
        let proposal = InventoryPlacementRecommendation(
            inventoryID: root.id,
            target: .init(id: "LOC-1001", name: "Pantry"),
            reasons: ["Only established stock location"]
        )
        let recommendations = EntityRecommendations(
            source: root,
            basisKey: "inventory-basis",
            groups: [.inventoryPlacement(status: .ready, currentTarget: nil, proposals: [proposal])]
        )
        let client = RetryingAcceptanceClient(
            graph: singleNodeGraph(root),
            recommendations: recommendations
        )
        let model = EntityRelationshipsModel(
            client: client,
            initialGraph: singleNodeGraph(root),
            initialRecommendations: recommendations
        )

        let firstAccepted = await model.accept(.inventoryPlacement(proposal), basisKey: "inventory-basis")

        #expect(firstAccepted == nil)
        #expect(model.recommendationDocument == recommendations)
        #expect(model.acceptError != nil)

        let retryAccepted = await model.accept(.inventoryPlacement(proposal), basisKey: "inventory-basis")

        #expect(retryAccepted?.destination == root)
        #expect(model.acceptError == nil)
        #expect(
            await client.recordedActions() == [
                .inventory(inventoryID: "INV-1001", locationID: "LOC-1001"),
                .inventory(inventoryID: "INV-1001", locationID: "LOC-1001"),
            ])
    }

    @Test @MainActor func mergedInventoryAcceptanceReturnsSurvivorWithoutRefreshingDeletedSource() async {
        let source = ref(.inventory, "INV-1001")
        let survivor = ref(.inventory, "INV-2002")
        let proposal = InventoryPlacementRecommendation(
            inventoryID: source.id,
            target: .init(id: "LOC-1001", name: "Workshop"),
            reasons: ["Only established stock location"]
        )
        let recommendations = EntityRecommendations(
            source: source,
            basisKey: "inventory-basis",
            groups: [.inventoryPlacement(status: .ready, currentTarget: nil, proposals: [proposal])]
        )
        let client = MergedInventoryAcceptanceClient(
            graph: singleNodeGraph(source),
            recommendations: recommendations,
            survivor: survivor
        )
        let model = EntityRelationshipsModel(
            client: client,
            initialGraph: singleNodeGraph(source),
            initialRecommendations: recommendations
        )

        let acceptance = await model.accept(
            .inventoryPlacement(proposal),
            basisKey: "inventory-basis"
        )

        #expect(acceptance?.recommendation.subject == source)
        #expect(acceptance?.destination == survivor)
        #expect(acceptance?.replacedSubject == true)
        #expect(await client.refreshRequestCount() == 0)
        #expect(model.acceptError == nil)
    }
}

private actor RelationshipClientStub: EntityRelationshipsClient {
    let graphs: [EntityReference: EntityGraph]
    var shouldFail = false

    init(graphs: [EntityReference: EntityGraph]) { self.graphs = graphs }

    func setFailure(_ value: Bool) { shouldFail = value }

    func exploreRelationships(root: EntityReference, depth: Int) throws -> EntityGraph {
        if shouldFail { throw URLError(.notConnectedToInternet) }
        return graphs[root]!
    }

    func relationshipPage(
        root: EntityReference,
        relationshipKey: String,
        offset: Int,
        limit: Int
    ) throws -> EntityGraphPage {
        throw URLError(.unsupportedURL)
    }

    func recommendations(for source: EntityReference) throws -> EntityRecommendations {
        if shouldFail { throw URLError(.notConnectedToInternet) }
        return EntityRecommendations(source: source, basisKey: "basis-\(source.id)", groups: [])
    }

    func assignExpense(_ expenseID: String, toProject projectID: String) throws {}
    func moveInventory(_ inventoryID: String, to locationID: String) -> EntityReference {
        EntityReference(entity: .inventory, id: inventoryID)
    }
}

private actor SuspendedRelationshipClient: EntityRelationshipsClient {
    let firstSource: EntityReference
    let graphs: [EntityReference: EntityGraph]
    var firstStarted = false
    var firstContinuation: CheckedContinuation<Void, Never>?

    init(firstSource: EntityReference, graphs: [EntityReference: EntityGraph]) {
        self.firstSource = firstSource
        self.graphs = graphs
    }

    func waitUntilFirstRequestStarts() async {
        while !firstStarted { await Task.yield() }
    }

    func finishFirstRequest() {
        firstContinuation?.resume()
        firstContinuation = nil
    }

    func exploreRelationships(root: EntityReference, depth: Int) async throws -> EntityGraph {
        if root == firstSource {
            firstStarted = true
            await withCheckedContinuation { continuation in firstContinuation = continuation }
            try Task.checkCancellation()
        }
        return graphs[root]!
    }

    func relationshipPage(
        root: EntityReference,
        relationshipKey: String,
        offset: Int,
        limit: Int
    ) throws -> EntityGraphPage {
        throw URLError(.unsupportedURL)
    }

    func recommendations(for source: EntityReference) -> EntityRecommendations {
        EntityRecommendations(source: source, basisKey: "basis-\(source.id)", groups: [])
    }

    func assignExpense(_ expenseID: String, toProject projectID: String) throws {}
    func moveInventory(_ inventoryID: String, to locationID: String) -> EntityReference {
        EntityReference(entity: .inventory, id: inventoryID)
    }
}

private actor SuspendedAcceptanceClient: EntityRelationshipsClient {
    let graphs: [EntityReference: EntityGraph]
    var acceptanceStarted = false
    var acceptanceContinuation: CheckedContinuation<Void, Never>?

    init(graphs: [EntityReference: EntityGraph]) { self.graphs = graphs }

    func waitUntilAcceptanceStarts() async {
        while !acceptanceStarted { await Task.yield() }
    }

    func finishAcceptance() {
        acceptanceContinuation?.resume()
        acceptanceContinuation = nil
    }

    func exploreRelationships(root: EntityReference, depth: Int) throws -> EntityGraph {
        guard let graph = graphs[root] else { throw URLError(.resourceUnavailable) }
        return graph
    }

    func relationshipPage(
        root: EntityReference,
        relationshipKey: String,
        offset: Int,
        limit: Int
    ) throws -> EntityGraphPage {
        throw URLError(.unsupportedURL)
    }

    func recommendations(for source: EntityReference) -> EntityRecommendations {
        EntityRecommendations(source: source, basisKey: "basis-\(source.id)", groups: [])
    }

    func assignExpense(_ expenseID: String, toProject projectID: String) async {
        acceptanceStarted = true
        await withCheckedContinuation { continuation in acceptanceContinuation = continuation }
        // Deliberately ignore cancellation to exercise the model's generation guard.
    }

    func moveInventory(_ inventoryID: String, to locationID: String) -> EntityReference {
        EntityReference(entity: .inventory, id: inventoryID)
    }
}

private actor RetryingAcceptanceClient: EntityRelationshipsClient {
    enum Action: Sendable, Equatable {
        case expense(expenseID: String, projectID: String)
        case inventory(inventoryID: String, locationID: String)
    }

    let graph: EntityGraph
    let recommendationDocument: EntityRecommendations
    var shouldFail = true
    var actions: [Action] = []

    init(graph: EntityGraph, recommendations: EntityRecommendations) {
        self.graph = graph
        recommendationDocument = recommendations
    }

    func recordedActions() -> [Action] { actions }

    func exploreRelationships(root: EntityReference, depth: Int) -> EntityGraph { graph }

    func relationshipPage(
        root: EntityReference,
        relationshipKey: String,
        offset: Int,
        limit: Int
    ) throws -> EntityGraphPage {
        throw URLError(.unsupportedURL)
    }

    func recommendations(for source: EntityReference) -> EntityRecommendations {
        recommendationDocument
    }

    func assignExpense(_ expenseID: String, toProject projectID: String) throws {
        actions.append(.expense(expenseID: expenseID, projectID: projectID))
        try failOnce()
    }

    func moveInventory(_ inventoryID: String, to locationID: String) throws -> EntityReference {
        actions.append(.inventory(inventoryID: inventoryID, locationID: locationID))
        try failOnce()
        return EntityReference(entity: .inventory, id: inventoryID)
    }

    private func failOnce() throws {
        if shouldFail {
            shouldFail = false
            throw URLError(.cannotConnectToHost)
        }
    }
}

private actor MergedInventoryAcceptanceClient: EntityRelationshipsClient {
    let graph: EntityGraph
    let recommendationDocument: EntityRecommendations
    let survivor: EntityReference
    var refreshRequests = 0

    init(
        graph: EntityGraph,
        recommendations: EntityRecommendations,
        survivor: EntityReference
    ) {
        self.graph = graph
        recommendationDocument = recommendations
        self.survivor = survivor
    }

    func refreshRequestCount() -> Int { refreshRequests }

    func exploreRelationships(root: EntityReference, depth: Int) -> EntityGraph {
        refreshRequests += 1
        return graph
    }

    func relationshipPage(
        root: EntityReference,
        relationshipKey: String,
        offset: Int,
        limit: Int
    ) throws -> EntityGraphPage {
        throw URLError(.unsupportedURL)
    }

    func recommendations(for source: EntityReference) -> EntityRecommendations {
        refreshRequests += 1
        return recommendationDocument
    }

    func assignExpense(_ expenseID: String, toProject projectID: String) throws {}

    func moveInventory(_ inventoryID: String, to locationID: String) -> EntityReference {
        survivor
    }
}

private func ref(_ entity: EntityKey, _ id: String) -> EntityReference {
    EntityReference(entity: entity, id: id)
}

private func node(_ reference: EntityReference, _ label: String) -> EntityGraphNode {
    EntityGraphNode(reference: reference, label: label)
}

private func edge(
    _ id: String,
    _ source: EntityReference,
    _ target: EntityReference
) -> EntityGraphEdge {
    EntityGraphEdge(
        id: id,
        source: source,
        target: target,
        relationshipKey: "related",
        label: "Related",
        sourceKey: "test",
        provenance: ["fixture"]
    )
}

private func branch(
    root: EntityReference,
    items: [EntityReference],
    edgeIDs: [String],
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
        edgeIDs: edgeIDs
    )
}

private func singleNodeGraph(_ root: EntityReference) -> EntityGraph {
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
