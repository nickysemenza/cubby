import Foundation
import Testing

@testable import CubbyKit

@Suite("Persistent graph explorer")
struct EntityGraphExplorerTests {
    let root = EntityReference(entity: .vendor, id: "VEN-2345")
    let purchase = EntityReference(entity: .purchase, id: "PUR-2345")
    let expense = EntityReference(entity: .expense, id: "EXP-2345")

    @Test @MainActor func selectionDoesNotReadAndExpansionKeepsTheMap() async throws {
        let initial = fixture(root: root, members: [purchase])
        let next = fixture(root: purchase, members: [expense])
        let client = GraphExplorerClient(graphs: [root: initial, purchase: next])
        let model = EntityGraphExplorer(client: client)
        await model.start(at: root)
        model.select(purchase)
        #expect(await client.reads == [root])
        await model.expand(purchase)
        await model.expand(purchase)
        #expect(await client.reads == [root, purchase])
        #expect(model.graph?.root == root)
        #expect(Set(model.visibleGraph?.nodes.map(\.reference) ?? []) == [root, purchase, expense])
        model.moveHistory(by: -1)
        #expect(model.selectedNode == root)
        #expect(await client.reads.count == 2)
    }

    @Test @MainActor func countedGroupsAndSharedEdgesSurviveCollapse() async throws {
        let initial = fixture(root: root, members: [purchase], total: 250)
        let client = GraphExplorerClient(graphs: [root: initial])
        let model = EntityGraphExplorer(client: client, initialGraph: initial)
        let branch = try #require(initial.branches.first)
        #expect(model.visibleGraph?.nodes.count == 1)
        await model.showMore(branch)
        #expect(model.visibleGraph?.nodes.count == 2)
        model.collapse(branch)
        #expect(model.visibleGraph?.nodes.count == 1)
        #expect(model.graph?.nodes.count == 2)
        await model.showMore(branch)
        #expect(model.visibleGraph?.nodes.count == 2)
        #expect(await client.reads.isEmpty)
    }

    @Test func mergeUsesOneBudgetAndPreservesParallelEvidence() {
        let initial = fixture(root: root, members: [purchase])
        let extra = (0..<510).map {
            EntityGraphNode(
                reference: .init(entity: .purchase, id: "PUR-\($0)"), label: "Fixture order \($0)")
        }
        let parallel = EntityGraphEdge(
            id: "parallel", source: root, target: purchase, relationshipKey: "secondary",
            label: "Other evidence", sourceKey: "fixture.secondary", provenance: [])
        let graph = EntityGraphExplorer.merge(
            initial, page: .init(nodes: extra, edges: [parallel], branches: [], truncated: false), root: root)
        #expect(graph.nodes.count == 500)
        #expect(graph.edges.count == 2)
        #expect(graph.edges.contains { $0.id == "parallel" })
    }

    @Test func denseLayoutIsCompactAndKeepsExistingCoordinates() async throws {
        let members = (0..<499).map { EntityReference(entity: .purchase, id: "PUR-\($0)") }
        let initial = fixture(root: root, members: Array(members.prefix(24)))
        let full = fixture(root: root, members: members)
        let first = try await EntityGraphMapLayout.place(graph: initial, measuredSizes: [:], previous: [:])
        let positions = try await EntityGraphMapLayout.place(graph: full, measuredSizes: [:], previous: first)
        #expect(positions.count == 500)
        for (id, position) in first { #expect(positions[id] == position) }
        let frames = Array(positions.values)
        for a in frames.indices {
            for b in frames.indices where b > a { #expect(!frames[a].intersects(frames[b])) }
        }
        let width = (frames.map { $0.x + $0.width }.max() ?? 0) - (frames.map(\.x).min() ?? 0)
        let height = (frames.map { $0.y + $0.height }.max() ?? 0) - (frames.map(\.y).min() ?? 0)
        #expect(max(width / height, height / width) < 4)
    }

    @Test @MainActor func lateExpansionCannotOverwriteANewMap() async {
        let client = GraphExplorerClient(
            graphs: [
                root: fixture(root: root, members: [purchase]), expense: fixture(root: expense, members: []),
            ], delayed: purchase)
        let model = EntityGraphExplorer(client: client)
        await model.start(at: root)
        let expansion = Task { await model.expand(purchase) }
        await client.waitForDelayedRead()
        await model.start(at: expense)
        await client.finishDelay(with: fixture(root: purchase, members: [root]))
        await expansion.value
        #expect(model.graph?.root == expense)
        #expect(model.graph?.nodes.count == 1)
        #expect(model.busy.isEmpty)
    }

    private func fixture(root: EntityReference, members: [EntityReference], total: Int? = nil) -> EntityGraph
    {
        let edges = members.map {
            EntityGraphEdge(
                id: "\(root.stableKey)>\($0.stableKey)", source: root, target: $0, relationshipKey: "members",
                label: "Connected records", sourceKey: "fixture.members", provenance: [])
        }
        return .init(
            root: root,
            nodes: [EntityGraphNode(reference: root, label: "Fixture root")]
                + members.map { EntityGraphNode(reference: $0, label: "Fixture \($0.id)") },
            edges: edges,
            branches: [
                .init(
                    root: root, relationshipKey: "members", label: "Connected records", target: .purchase,
                    totalCount: total ?? members.count, nextOffset: nil, items: members,
                    edgeIDs: edges.map(\.id))
            ],
            paths: [], completion: .init(status: .exhausted, requestedDepth: 1, reachedDepth: 1),
            truncated: false)
    }
}

private actor GraphExplorerClient: EntityRelationshipsClient {
    let graphs: [EntityReference: EntityGraph]
    let delayed: EntityReference?
    var reads: [EntityReference] = []
    private var continuation: CheckedContinuation<EntityGraph, Never>?
    private var started: CheckedContinuation<Void, Never>?
    init(graphs: [EntityReference: EntityGraph], delayed: EntityReference? = nil) {
        self.graphs = graphs; self.delayed = delayed
    }
    func exploreRelationships(root: EntityReference, depth: Int) async throws -> EntityGraph {
        reads.append(root)
        if root == delayed {
            return await withCheckedContinuation { continuation in
                self.continuation = continuation; started?.resume(); started = nil
            }
        }
        guard let graph = graphs[root] else { throw URLError(.resourceUnavailable) }
        return graph
    }
    func waitForDelayedRead() async {
        if continuation == nil { await withCheckedContinuation { started = $0 } }
    }
    func finishDelay(with graph: EntityGraph) { continuation?.resume(returning: graph); continuation = nil }
    func relationshipPage(root: EntityReference, relationshipKey: String, offset: Int, limit: Int) throws
        -> EntityGraphPage
    { throw URLError(.unsupportedURL) }
    func recommendations(for source: EntityReference) throws -> EntityRecommendations {
        throw URLError(.unsupportedURL)
    }
    func assignExpense(_ expenseID: String, toProject projectID: String) throws {
        throw URLError(.unsupportedURL)
    }
    func moveInventory(_ inventoryID: String, to locationID: String) throws -> EntityReference {
        throw URLError(.unsupportedURL)
    }
}
