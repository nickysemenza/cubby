import CubbyKit

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
