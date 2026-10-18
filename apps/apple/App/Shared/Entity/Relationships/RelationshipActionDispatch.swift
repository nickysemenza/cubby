import CubbyKit

@MainActor
func requestConnectionDiscovery(model: EntityRelationshipsModel) {
    Task { await model.findConnections() }
}

@MainActor
func requestConnectionDiscoveryObservation(model: EntityRelationshipsModel) {
    Task { await model.retryConnectionDiscoveryObservation() }
}

@MainActor
func requestConnectionReview(
    model: EntityRelationshipsModel,
    proposal: ConnectionProposal,
    verdict: ConnectionReviewVerdict,
    persistent: Bool,
    onAccepted: @escaping (RelationshipAcceptance) -> Void
) {
    Task {
        await model.reviewConnection(
            proposal, verdict: verdict, persistent: persistent, onAccepted: onAccepted)
    }
}

/// Keeps isolated task thunks out of the large relationship view for Xcode 26.6.
@MainActor
func requestRelationshipAcceptance(
    model: EntityRelationshipsModel,
    proposal: ActionableRelationshipRecommendation,
    basisKey: String,
    onAccepted: @escaping (RelationshipAcceptance) -> Void
) {
    Task {
        if let acceptance = await model.accept(proposal, basisKey: basisKey) {
            onAccepted(acceptance)
        }
    }
}
