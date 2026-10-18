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

/// Navigation and invalidation after a relationship mutation. `subject` is the displayed record;
/// reviewing from the other endpoint invalidates affected kinds without replacing that endpoint.
public struct RelationshipAcceptance: Sendable, Hashable {
    public let subject: EntityRef
    public let destination: EntityRef
    public let affectedEntities: Set<EntityKey>

    public init(subject: EntityRef, destination: EntityRef, affectedEntities: Set<EntityKey>) {
        self.subject = subject
        self.destination = destination
        self.affectedEntities = affectedEntities
    }

    public init(
        recommendation: ActionableRelationshipRecommendation,
        destination: EntityRef
    ) {
        let affectedEntities: Set<EntityKey>
        switch recommendation {
        case .expenseProject: affectedEntities = [.expense, .project]
        case .inventoryPlacement: affectedEntities = [.inventory, .location, .product]
        }
        self.init(
            subject: recommendation.subject, destination: destination, affectedEntities: affectedEntities)
    }

    public var replacedSubject: Bool { subject != destination }
}

/// Boundary used by the shared observable model and by small deterministic test clients.
public protocol EntityRelationshipsClient: Sendable {
    func storedConnections(_ input: EntityGraphRootInput) async throws -> ConnectionDiscoveryOut
    func discoverConnections(_ input: EntityGraphRootInput) async throws -> ConnectionDiscoveryOut
    func discoveryRunSnapshot(runID: RunShortcode) async throws -> RunWorkSnapshotOutput
    func reviewAssessment(_ input: AssessmentReviewInput) async throws -> AssessmentReviewOut
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
    public private(set) var connectionDocument: ConnectionDiscoveryOut?
    public private(set) var connectionError: String?
    public private(set) var isFindingConnections = false
    public private(set) var discoveryRunID: RunShortcode?
    public private(set) var discoveryRunStatus: String?
    public private(set) var reviewingConnectionID: String?
    public private(set) var phase: Phase = .idle
    public private(set) var activity: Activity = .idle
    public private(set) var graphError: String?
    public private(set) var recommendationError: String?
    public private(set) var acceptingRecommendationID: String?
    public private(set) var acceptError: String?
    public private(set) var depth = 1

    private let client: any EntityRelationshipsClient
    private var requestGeneration = 0
    private var graphTask: Task<EntityGraph, Error>?
    private var recommendationTask: Task<EntityRecommendationsOut, Error>?
    private var acceptTask: Task<RelationshipAcceptance, Error>?
    private var connectionTask: Task<ConnectionDiscoveryOut, Error>?
    private var connectionReviewTask: Task<AssessmentReviewOut, Error>?
    private var discoveryObservationTask: Task<Void, Error>?
    private let waitForDiscoveryPoll: @Sendable () async throws -> Void

    public init(
        client: any EntityRelationshipsClient,
        initialGraph: EntityGraph? = nil,
        initialRecommendations: EntityRecommendationsOut? = nil,
        initialConnections: ConnectionDiscoveryOut? = nil,
        waitForDiscoveryPoll: @escaping @Sendable () async throws -> Void = {
            try await Task.sleep(for: .seconds(3))
        }
    ) {
        self.client = client
        self.waitForDiscoveryPoll = waitForDiscoveryPoll
        graph = initialGraph
        recommendationDocument = initialRecommendations
        connectionDocument = initialConnections
        source =
            initialGraph?.root ?? initialRecommendations.map { EntityRef($0.source) }
            ?? initialConnections.map { EntityRef($0.source) }
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

    public var connectionControlsDisabled: Bool {
        activity != .idle || isFindingConnections || reviewingConnectionID != nil
            || acceptingRecommendationID != nil
    }

    /// Only this explicit action runs matchers; initial loading and refresh read stored evidence.
    public func findConnections() async {
        guard !connectionControlsDisabled, let source else { return }
        let generation = requestGeneration
        isFindingConnections = true
        connectionError = nil
        discoveryRunID = nil
        discoveryRunStatus = nil
        let client = client
        let task = Task {
            try Task.checkCancellation()
            return try await client.discoverConnections(source.graphRootInput)
        }
        connectionTask = task
        do {
            let document = try await withTaskCancellationHandler {
                try await task.value
            } onCancel: {
                task.cancel()
            }
            try Task.checkCancellation()
            guard generation == requestGeneration, self.source == source else { return }
            guard EntityRef(document.source) == source else {
                throw ConnectionReviewError.sourceMismatch
            }
            connectionDocument = document
            if let runID = document.discoveryRunId {
                discoveryRunID = runID
                try await observeDiscoveryRun(runID: runID, source: source, generation: generation)
            }
        } catch is CancellationError {
            // Navigation and source changes do not surface as failures.
        } catch {
            if generation == requestGeneration { connectionError = error.userMessage }
        }
        if generation == requestGeneration {
            connectionTask = nil
            isFindingConnections = false
        }
    }

    /// Retries observation of the existing durable work without starting another discovery Run.
    public func retryConnectionDiscoveryObservation() async {
        guard !connectionControlsDisabled, let runID = discoveryRunID, let source else { return }
        let generation = requestGeneration
        isFindingConnections = true
        connectionError = nil
        do {
            try await observeDiscoveryRun(runID: runID, source: source, generation: generation)
        } catch is CancellationError {
            // The detail no longer owns observation.
        } catch {
            if generation == requestGeneration { connectionError = error.userMessage }
        }
        if generation == requestGeneration { isFindingConnections = false }
    }

    private func observeDiscoveryRun(runID: RunShortcode, source: EntityRef, generation: Int) async throws {
        let task = Task {
            while true {
                try Task.checkCancellation()
                let snapshot = try await client.discoveryRunSnapshot(runID: runID)
                try Task.checkCancellation()
                guard generation == requestGeneration, self.source == source else {
                    throw CancellationError()
                }
                guard snapshot.runId == runID else { throw ConnectionReviewError.discoveryRunMismatch }
                discoveryRunStatus = snapshot.status.rawValue
                if snapshot.status != .running {
                    let document = try await client.storedConnections(source.graphRootInput)
                    try Task.checkCancellation()
                    guard generation == requestGeneration, self.source == source else {
                        throw CancellationError()
                    }
                    guard EntityRef(document.source) == source else {
                        throw ConnectionReviewError.sourceMismatch
                    }
                    connectionDocument = document
                    guard snapshot.status == .completed else {
                        let errors = snapshot.operations.compactMap(\.error)
                        throw ConnectionReviewError.discoveryStopped(
                            (["Discovery Run \(runID) stopped with status \(snapshot.status.rawValue)."]
                                + errors)
                                .joined(separator: "\n"))
                    }
                    return
                }
                try await waitForDiscoveryPoll()
            }
        }
        discoveryObservationTask = task
        defer {
            if generation == requestGeneration { discoveryObservationTask = nil }
        }
        try await withTaskCancellationHandler {
            try await task.value
        } onCancel: {
            task.cancel()
        }
    }

    @discardableResult
    public func reviewConnection(
        _ proposal: ConnectionProposal, verdict: ConnectionReviewVerdict, persistent: Bool = false,
        onAccepted: (RelationshipAcceptance) -> Void = { _ in }
    ) async -> Bool {
        guard !connectionControlsDisabled, let source,
            connectionDocument?.proposals.contains(where: {
                $0.review.assessmentId == proposal.review.assessmentId
                    && $0.fingerprint == proposal.fingerprint
            }) == true,
            !persistent || (verdict == .dismissed && proposal.review.suppression != nil),
            verdict != .correct
                || (!proposal.requiresIdentityReview && proposal.evidence.contradictions.isEmpty)
        else { return false }
        let generation = requestGeneration
        reviewingConnectionID = proposal.review.assessmentId
        connectionError = nil
        var input = AssessmentReviewInput(
            operationId: UUID().uuidString, verdict: .dismissed,
            correction: .AssessmentCorrectionFalse(.init(present: false)),
            intent: verdict == .correct ? .apply : .history,
            assessmentId: proposal.review.assessmentId, expectedFingerprint: proposal.fingerprint)
        switch verdict {
        case .correct: input.verdict = .correct
        case .wrong: input.verdict = .wrong
        case .uncertain: input.verdict = .uncertain
        case .dismissed: input.verdict = .dismissed
        }
        if persistent, let suppression = proposal.review.suppression {
            input.suppression = .init(
                scope: suppression.scope, candidateKey: suppression.candidateKey,
                fingerprint: suppression.fingerprint)
        }
        let client = client
        let reviewInput = input
        let task = Task {
            try Task.checkCancellation()
            return try await client.reviewAssessment(reviewInput)
        }
        connectionReviewTask = task
        do {
            let result = try await withTaskCancellationHandler {
                try await task.value
            } onCancel: {
                task.cancel()
            }
            try Task.checkCancellation()
            guard generation == requestGeneration, self.source == source else { return false }
            guard verdict != .correct || result.applied else { throw ConnectionReviewError.notApplied }
            var acceptance: RelationshipAcceptance?
            if verdict == .correct {
                var destination = source
                if proposal.relation == .inventoryLocation, result.applicationResult == nil {
                    throw ConnectionReviewError.missingApplicationResult
                }
                if let application = result.applicationResult {
                    let appliedSource = EntityRef(application.source)
                    let appliedDestination = EntityRef(application.destination)
                    guard
                        (appliedSource == EntityRef(proposal.source)
                            || appliedSource == EntityRef(proposal.target)),
                        appliedDestination.entity == appliedSource.entity,
                        proposal.relation != .inventoryLocation || appliedSource == EntityRef(proposal.source)
                    else { throw ConnectionReviewError.invalidApplicationResult }
                    if source == appliedSource { destination = appliedDestination }
                }
                var affectedEntities: Set<EntityKey> = [
                    proposal.source.entityKind, proposal.target.entityKind,
                ]
                if proposal.relation == .inventoryLocation { affectedEntities.insert(.product) }
                acceptance = .init(
                    subject: source, destination: destination, affectedEntities: affectedEntities)
            }
            connectionReviewTask = nil
            reviewingConnectionID = nil
            if let acceptance { onAccepted(acceptance) }
            // Replacement navigation loads the survivor. Reading the coalesced row here would
            // turn a committed confirmation into a 404 and race that replacement navigation.
            if acceptance?.replacedSubject != true, generation == requestGeneration, self.source == source {
                await refresh()
            }
            return true
        } catch is CancellationError {
            // A cancelled write may have reached the server; the next load reads persisted state.
        } catch {
            if generation == requestGeneration { connectionError = error.userMessage }
        }
        if generation == requestGeneration {
            connectionReviewTask = nil
            reviewingConnectionID = nil
        }
        return false
    }

    public func cancel() {
        cancelRequests()
        requestGeneration += 1
        activity = .idle
        phase = .idle
    }

    @discardableResult
    public func accept(
        _ recommendation: ActionableRelationshipRecommendation,
        basisKey: String
    ) async -> RelationshipAcceptance? {
        guard recommendationDocument?.basisKey == basisKey,
            acceptingRecommendationID == nil,
            !isFindingConnections, reviewingConnectionID == nil,
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
                acceptError = error.userMessage
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
        if self.source != source {
            discoveryRunID = nil
            discoveryRunStatus = nil
        }
        self.source = source
        graphError = nil
        recommendationError = nil
        connectionError = nil
        acceptError = nil
        activity = retainingContent ? .refreshing : .loadingInitial
        if !retainingContent {
            graph = nil
            recommendationDocument = nil
            connectionDocument = nil
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
        let nextConnectionTask = Task {
            try Task.checkCancellation()
            return try await client.storedConnections(source.graphRootInput)
        }
        connectionTask = nextConnectionTask

        do {
            let result = try await nextGraphTask.value
            if generation == requestGeneration { graph = result }
        } catch is CancellationError {
            // A new source or depth owns the state now.
        } catch {
            if generation == requestGeneration { graphError = error.userMessage }
        }

        do {
            let result = try await nextRecommendationTask.value
            if generation == requestGeneration, EntityRef(result.source) == source {
                recommendationDocument = result
            }
        } catch is CancellationError {
            // A new source or depth owns the state now.
        } catch {
            if generation == requestGeneration { recommendationError = error.userMessage }
        }

        do {
            let document = try await withTaskCancellationHandler {
                try await nextConnectionTask.value
            } onCancel: {
                nextConnectionTask.cancel()
            }
            try Task.checkCancellation()
            if generation == requestGeneration {
                guard EntityRef(document.source) == source else { throw ConnectionReviewError.sourceMismatch }
                connectionDocument = document
            }
        } catch is CancellationError {
            // A new source owns the state now.
        } catch {
            if generation == requestGeneration { connectionError = error.userMessage }
        }

        guard generation == requestGeneration else { return }
        graphTask = nil
        recommendationTask = nil
        connectionTask = nil
        activity = .idle
        if graph == nil, recommendationDocument == nil, connectionDocument == nil {
            let message =
                graphError ?? recommendationError ?? connectionError ?? "Relationships are unavailable"
            phase = .failed(message)
        } else {
            phase = .loaded
        }
        if discoveryRunStatus == "running", discoveryRunID != nil {
            await retryConnectionDiscoveryObservation()
        }
    }

    private func cancelRequests() {
        graphTask?.cancel()
        recommendationTask?.cancel()
        acceptTask?.cancel()
        connectionTask?.cancel()
        connectionReviewTask?.cancel()
        discoveryObservationTask?.cancel()
        graphTask = nil
        recommendationTask = nil
        acceptTask = nil
        acceptingRecommendationID = nil
        connectionTask = nil
        connectionReviewTask = nil
        discoveryObservationTask = nil
        isFindingConnections = false
        reviewingConnectionID = nil
    }
}

public enum ConnectionReviewVerdict: Sendable, Equatable {
    case correct, wrong, uncertain, dismissed
}

extension ConnectionProposal {
    public var requiresIdentityReview: Bool {
        if case .productPairReview = integration { return true }
        return false
    }
}

private enum ConnectionReviewError: LocalizedError {
    case sourceMismatch, notApplied, missingApplicationResult, invalidApplicationResult, discoveryRunMismatch
    case discoveryStopped(String)
    var errorDescription: String? {
        switch self {
        case .sourceMismatch: "Connection response source does not match the requested record."
        case .notApplied: "Connection review returned applied=false for an explicit apply request."
        case .missingApplicationResult: "Inventory connection review returned no applicationResult."
        case .invalidApplicationResult:
            "Assessment applicationResult does not match the reviewed connection endpoints."
        case .discoveryRunMismatch: "Run status response does not match the connection discovery Run."
        case .discoveryStopped(let message): message
        }
    }
}
