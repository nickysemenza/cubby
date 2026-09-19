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

@MainActor
func requestRelationshipFocus(
    model: EntityRelationshipsModel,
    on reference: EntityRef,
    onFocused: @escaping () -> Void
) {
    Task {
        await model.focus(on: reference)
        if model.graph?.root == reference { onFocused() }
    }
}
