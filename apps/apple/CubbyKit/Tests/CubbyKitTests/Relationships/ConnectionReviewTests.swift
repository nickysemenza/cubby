import Foundation
import Testing

@testable import CubbyKit

// Failures guarded here: passive loads must not discover; late reads/discovery must not
// replace another source; stale fingerprints and duplicate pending writes must not apply;
// identity pairs require survivor/effects review; suppression must be explicitly supplied.
// Inventory confirmation can coalesce away its source. Its persisted application result must
// replace the Inventory detail without reading the deleted row; a Location endpoint must stay
// on Location and refresh. Missing/mismatched results must not guess a survivor or navigate.
@Suite("Connection review", .timeLimit(.minutes(1)))
struct ConnectionReviewTests {
    @Test @MainActor func mergedInventoryUsesExistingReplacementCallbackWithoutRefreshingDeletedSource()
        async throws
    {
        let client = ConnectionClient(inventoryMode: true, inventoryDestination: ConnectionClient.survivor)
        let proposal = try ConnectionClient.inventoryProposal()
        let model = EntityRelationshipsModel(
            client: client, initialConnections: .init(source: proposal.source, proposals: [proposal]))
        var acceptance: RelationshipAcceptance?

        #expect(await model.reviewConnection(proposal, verdict: .correct, onAccepted: { acceptance = $0 }))

        let accepted = try #require(acceptance)
        #expect(accepted.subject == ConnectionClient.inventory)
        #expect(accepted.destination == ConnectionClient.survivor)
        #expect(accepted.replacedSubject)
        #expect(accepted.affectedEntities == [.inventory, .location, .product])
        #expect(await client.reads == 0)
        #expect(await client.graphReads == 0)
        #expect(model.connectionError == nil)
    }

    @Test @MainActor func mergedInventoryFromLocationKeepsLocationAndRefreshes() async throws {
        let client = ConnectionClient(inventoryMode: true, inventoryDestination: ConnectionClient.survivor)
        let proposal = try ConnectionClient.inventoryProposal()
        let model = EntityRelationshipsModel(
            client: client, initialConnections: .init(source: proposal.target, proposals: [proposal]))
        var acceptance: RelationshipAcceptance?

        #expect(await model.reviewConnection(proposal, verdict: .correct, onAccepted: { acceptance = $0 }))

        let accepted = try #require(acceptance)
        #expect(accepted.subject == ConnectionClient.location)
        #expect(accepted.destination == ConnectionClient.location)
        #expect(!accepted.replacedSubject)
        #expect(accepted.affectedEntities == [.inventory, .location, .product])
        #expect(await client.reads == 1)
        #expect(await client.graphReads == 1)
        #expect(model.source == ConnectionClient.location)
    }

    @Test @MainActor func unmergedInventoryRefreshesItsStillExistingSource() async throws {
        let client = ConnectionClient(inventoryMode: true, inventoryDestination: ConnectionClient.inventory)
        let proposal = try ConnectionClient.inventoryProposal()
        let model = EntityRelationshipsModel(
            client: client, initialConnections: .init(source: proposal.source, proposals: [proposal]))
        var acceptance: RelationshipAcceptance?

        #expect(await model.reviewConnection(proposal, verdict: .correct, onAccepted: { acceptance = $0 }))
        #expect(acceptance?.replacedSubject == false)
        #expect(await client.reads == 1)
        #expect(await client.graphReads == 1)
    }

    @Test @MainActor func missingInventoryResultDoesNotRefreshPossiblyDeletedSource() async throws {
        let client = ConnectionClient(inventoryMode: true)
        let proposal = try ConnectionClient.inventoryProposal()
        let model = EntityRelationshipsModel(
            client: client, initialConnections: .init(source: proposal.source, proposals: [proposal]))
        var acceptance: RelationshipAcceptance?

        #expect(!(await model.reviewConnection(proposal, verdict: .correct, onAccepted: { acceptance = $0 })))
        #expect(acceptance == nil)
        #expect(model.connectionError?.contains("applicationResult") == true)
        #expect(await client.reads == 0)
        #expect(await client.graphReads == 0)
    }

    @Test @MainActor func mismatchedInventoryResultDoesNotNavigate() async throws {
        let client = ConnectionClient(inventoryMode: true, inventoryDestination: ConnectionClient.location)
        let proposal = try ConnectionClient.inventoryProposal()
        let model = EntityRelationshipsModel(
            client: client, initialConnections: .init(source: proposal.source, proposals: [proposal]))
        var acceptance: RelationshipAcceptance?

        #expect(!(await model.reviewConnection(proposal, verdict: .correct, onAccepted: { acceptance = $0 })))
        #expect(acceptance == nil)
        #expect(model.connectionError?.contains("applicationResult") == true)
        #expect(await client.reads == 0)
    }

    @Test @MainActor func passiveLoadReadsBothEndpointsWithoutDiscovering() async throws {
        let client = ConnectionClient()
        let model = EntityRelationshipsModel(client: client)
        for source in [ConnectionClient.expense, ConnectionClient.project] {
            await model.loadInitial(source: source)
            #expect(model.connectionDocument?.proposals.count == 1)
            #expect(model.connectionDocument?.source.entityId == source.id)
        }
        #expect(await client.discoveries == 0)
    }

    @Test(arguments: ["connection-review", "field-review", "email-link-review"])
    @MainActor func acceptanceUsesReviewedFingerprintAndRefreshesStoredAndGraph(kind: String) async throws {
        let client = ConnectionClient(proposalKind: kind)
        let model = EntityRelationshipsModel(client: client)
        await model.loadInitial(source: ConnectionClient.expense)
        let proposal = try #require(model.connectionDocument?.proposals.first)
        #expect(await model.reviewConnection(proposal, verdict: .correct))
        let input = try #require(await client.reviews.first)
        #expect(input.assessmentId == proposal.review.assessmentId)
        #expect(input.expectedFingerprint == proposal.fingerprint)
        #expect(input.intent == .apply)
        #expect(UUID(uuidString: input.operationId) != nil)
        #expect(input.suppression == nil)
        #expect(await client.reads == 2)
        #expect(await client.graphReads == 2)
    }

    @Test @MainActor func historyDoesNotApplyOrInventSuppression() async throws {
        let client = ConnectionClient()
        let model = EntityRelationshipsModel(client: client)
        await model.loadInitial(source: ConnectionClient.expense)
        let proposal = try #require(model.connectionDocument?.proposals.first)
        for verdict in [ConnectionReviewVerdict.wrong, .uncertain, .dismissed] {
            #expect(await model.reviewConnection(proposal, verdict: verdict))
        }
        for input in await client.reviews {
            #expect(input.intent == .history)
            #expect(input.suppression == nil)
        }
        #expect(!(await model.reviewConnection(proposal, verdict: .dismissed, persistent: true)))
        #expect(await client.reviews.count == 3)
    }

    @Test @MainActor func staleFingerprintAndIdentityApplyAreRejected() async throws {
        let client = ConnectionClient()
        let model = EntityRelationshipsModel(client: client)
        await model.loadInitial(source: ConnectionClient.expense)
        var stale = try #require(model.connectionDocument?.proposals.first)
        stale.fingerprint = "old-evidence"
        #expect(!(await model.reviewConnection(stale, verdict: .correct)))
        let identity = try ConnectionClient.proposal(kind: "product-pair-review")
        let identityModel = EntityRelationshipsModel(
            client: client,
            initialConnections: .init(source: identity.source, proposals: [identity]))
        #expect(identity.requiresIdentityReview)
        #expect(!(await identityModel.reviewConnection(identity, verdict: .correct)))
        #expect(await client.reviews.isEmpty)
    }

    @Test @MainActor func pendingReviewBlocksDuplicateAndDiscovery() async throws {
        let gate = Gate()
        let client = ConnectionClient(reviewGate: gate)
        let model = EntityRelationshipsModel(client: client)
        await model.loadInitial(source: ConnectionClient.expense)
        let proposal = try #require(model.connectionDocument?.proposals.first)
        let write = Task { await model.reviewConnection(proposal, verdict: .correct) }
        await gate.arrivals()
        #expect(model.connectionControlsDisabled)
        #expect(!(await model.reviewConnection(proposal, verdict: .correct)))
        await model.findConnections()
        #expect(await client.discoveries == 0)
        gate.open()
        #expect(await write.value)
        #expect(await client.reviews.count == 1)
    }

    @Test @MainActor func suppressionRequiresExplicitDismissAndPreservesServerHandle() async throws {
        let client = ConnectionClient()
        let proposal = try ConnectionClient.proposal(suppression: true)
        let model = EntityRelationshipsModel(
            client: client,
            initialConnections: .init(source: proposal.source, proposals: [proposal]))
        #expect(await model.reviewConnection(proposal, verdict: .dismissed, persistent: true))
        let input = try #require(await client.reviews.first)
        #expect(input.intent == .history)
        #expect(input.suppression?.scope == "connection")
        #expect(input.suppression?.candidateKey == "synthetic-pair")
        #expect(input.suppression?.fingerprint == "current-evidence")
    }

    @Test @MainActor func lateReviewDoesNotRefreshOrReplaceANewSource() async throws {
        let gate = Gate()
        let client = ConnectionClient(reviewGate: gate)
        let model = EntityRelationshipsModel(client: client)
        await model.loadInitial(source: ConnectionClient.expense)
        let proposal = try #require(model.connectionDocument?.proposals.first)
        var acceptance: RelationshipAcceptance?
        let write = Task {
            await model.reviewConnection(proposal, verdict: .correct, onAccepted: { acceptance = $0 })
        }
        await gate.arrivals()
        await model.loadInitial(source: ConnectionClient.project)
        gate.open()
        #expect(!(await write.value))
        #expect(model.connectionDocument?.source.entityId == ConnectionClient.project.id)
        #expect(model.reviewingConnectionID == nil)
        #expect(acceptance == nil)
        #expect(await client.reads == 2)
    }

    @Test @MainActor func lateStoredReadAndCancelledDiscoveryDoNotPublish() async throws {
        let reads = Gate()
        let discoveries = Gate()
        let client = ConnectionClient(discoveryGate: discoveries, readGate: reads)
        let model = EntityRelationshipsModel(client: client)
        let first = Task { await model.loadInitial(source: ConnectionClient.expense) }
        await reads.arrivals()
        await model.loadInitial(source: ConnectionClient.project)
        reads.open()
        await first.value
        #expect(model.connectionDocument?.source.entityId == ConnectionClient.project.id)
        let discovery = Task { await model.findConnections() }
        await discoveries.arrivals()
        discovery.cancel()
        discoveries.open()
        await discovery.value
        #expect(model.connectionError == nil)
        #expect(!model.isFindingConnections)
    }

    @Test @MainActor func discoveryErrorsRemainRawAndClearPendingState() async throws {
        let client = ConnectionClient(failDiscovery: true)
        let model = EntityRelationshipsModel(client: client)
        await model.loadInitial(source: ConnectionClient.expense)
        await model.findConnections()
        #expect(model.connectionError?.contains("SQLSTATE 23505") == true)
        #expect(!model.connectionControlsDisabled)
        #expect(model.connectionDocument?.proposals.count == 1)
    }

    @Test @MainActor func supersededDiscoveryCannotReplaceNewSource() async throws {
        let gate = Gate()
        let client = ConnectionClient(discoveryGate: gate)
        let model = EntityRelationshipsModel(client: client)
        await model.loadInitial(source: ConnectionClient.expense)
        let discovery = Task { await model.findConnections() }
        await gate.arrivals()
        await model.loadInitial(source: ConnectionClient.project)
        gate.open()
        await discovery.value
        #expect(model.connectionDocument?.source.entityId == ConnectionClient.project.id)
        #expect(!model.isFindingConnections)
    }
}

private actor ConnectionClient: EntityRelationshipsClient {
    static let expense = EntityRef(entity: .expense, id: "EXP-2345")
    static let project = EntityRef(entity: .project, id: "PRJ-2345")
    static let inventory = EntityRef(entity: .inventory, id: "INV-2345")
    static let survivor = EntityRef(entity: .inventory, id: "INV-3456")
    static let location = EntityRef(entity: .location, id: "LOC-2345")
    var discoveries = 0
    var reads = 0
    var graphReads = 0
    var reviews: [AssessmentReviewInput] = []
    let discoveryGate: Gate?
    let reviewGate: Gate?
    let readGate: Gate?
    let failDiscovery: Bool
    let proposalKind: String
    let inventoryMode: Bool
    let inventoryDestination: EntityRef?

    init(
        discoveryGate: Gate? = nil, reviewGate: Gate? = nil, readGate: Gate? = nil,
        failDiscovery: Bool = false, proposalKind: String = "connection-review",
        inventoryMode: Bool = false, inventoryDestination: EntityRef? = nil
    ) {
        self.discoveryGate = discoveryGate
        self.reviewGate = reviewGate
        self.readGate = readGate
        self.failDiscovery = failDiscovery
        self.proposalKind = proposalKind
        self.inventoryMode = inventoryMode
        self.inventoryDestination = inventoryDestination
    }

    func storedConnections(_ input: EntityGraphRootInput) async throws -> ConnectionDiscoveryOut {
        reads += 1
        if input.entityId == Self.expense.id, let readGate { await readGate.hold() }
        return try document(input)
    }

    func discoverConnections(_ input: EntityGraphRootInput) async throws -> ConnectionDiscoveryOut {
        discoveries += 1
        if let discoveryGate { await discoveryGate.hold() }
        if failDiscovery { throw FixtureError() }
        return try document(input)
    }

    func reviewAssessment(_ input: AssessmentReviewInput) async throws -> AssessmentReviewOut {
        reviews.append(input)
        if let reviewGate { await reviewGate.hold() }
        let assessmentID = try #require(input.assessmentId)
        var result = AssessmentReviewOut(
            assessmentId: assessmentID, feedbackId: UUID().uuidString,
            status: "reviewed", applied: input.intent == .apply)
        if let inventoryDestination {
            result.applicationResult = .init(
                source: .init(Self.inventory), destination: .init(inventoryDestination))
        }
        return result
    }

    func exploreRelationships(root: EntityRef, depth: Int) -> EntityGraph {
        graphReads += 1
        return .init(
            root: root, nodes: [.init(reference: root, label: "Fixture")], edges: [], branches: [],
            paths: [], completion: .init(status: .exhausted, requestedDepth: depth, reachedDepth: 0),
            truncated: false)
    }

    func recommendations(for source: EntityRef) -> EntityRecommendationsOut {
        .init(source: .init(source), basisKey: "fixture", groups: [])
    }
    func relationshipPage(root: EntityRef, relationshipKey: String, offset: Int, limit: Int) throws
        -> EntityGraphOutput
    { throw URLError(.unsupportedURL) }
    func assignExpense(_ expenseID: String, toProject projectID: String) {}
    func moveInventory(_ inventoryID: String, to locationID: String) -> EntityRef {
        .init(entity: .inventory, id: inventoryID)
    }

    private func document(_ input: EntityGraphRootInput) throws -> ConnectionDiscoveryOut {
        let proposal = inventoryMode ? try Self.inventoryProposal() : try Self.proposal(kind: proposalKind)
        return .init(
            source: .init(entityKind: input.entityKind, entityId: input.entityId),
            proposals: [proposal])
    }

    static func inventoryProposal() throws -> ConnectionProposal {
        var proposal = try proposal()
        proposal.relation = .inventoryLocation
        proposal.source = .init(inventory)
        proposal.target = .init(location)
        proposal.label = "Move stock to workshop"
        return proposal
    }

    static func proposal(kind: String = "connection-review", suppression: Bool = false) throws
        -> ConnectionProposal
    {
        let handle =
            suppression
            ? #"{"scope":"connection","candidateKey":"synthetic-pair","fingerprint":"current-evidence"}"#
            : "null"
        let relation = kind == "product-pair-review" ? "product-identity" : "expense-project"
        let sourceKind = kind == "product-pair-review" ? "product" : "expense"
        let targetKind = kind == "product-pair-review" ? "product" : "project"
        let sourceID = kind == "product-pair-review" ? "PRD-2345" : "EXP-2345"
        let targetID = kind == "product-pair-review" ? "PRD-3456" : "PRJ-2345"
        let field = kind == "field-review" ? #", "field":"projectId""# : ""
        return try JSONDecoder().decode(
            ConnectionProposal.self,
            from: Data(
                """
                {"relation":"\(relation)","source":{"entityKind":"\(sourceKind)","entityId":"\(sourceID)"},
                "target":{"entityKind":"\(targetKind)","entityId":"\(targetID)"},"label":"Assign project",
                "evidence":{"reasons":["Shared work"],"contradictions":[],"unknowns":[]},
                "review":{"assessmentId":"00000000-0000-4000-8000-000000000001","suppression":\(handle)},
                "fingerprint":"current-evidence","integration":{"kind":"\(kind)"\(field)}}
                """.utf8))
    }

    private struct FixtureError: LocalizedError {
        var errorDescription: String? { "SQLSTATE 23505: synthetic connection diagnostic" }
    }
}
