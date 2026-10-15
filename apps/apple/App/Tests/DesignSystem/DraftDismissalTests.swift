import Testing

@testable import Cubby

@MainActor
@Suite("Draft dismissal")
struct DraftDismissalTests {
    @Test func unchangedDraftDismissesImmediately() {
        var state = DraftDismissalState()
        var didDismiss = false

        state.request(isDirty: false, isSaving: false) { didDismiss = true }

        #expect(didDismiss)
        #expect(state.confirmation == nil)
    }

    @Test func changedDraftRequiresExplicitDiscard() {
        var state = DraftDismissalState()
        var didDismiss = false

        state.request(isDirty: true, isSaving: false) { didDismiss = true }

        #expect(!didDismiss)
        #expect(state.confirmation == .discardChanges)
    }

    @Test func inFlightSaveCannotDismissTheSheet() {
        var state = DraftDismissalState()
        var didDismiss = false

        state.request(isDirty: false, isSaving: true) { didDismiss = true }

        #expect(!didDismiss)
        #expect(state.confirmation == nil)
    }

    @Test func inFlightSaveBlocksEvenADirtyDraft() {
        var state = DraftDismissalState()

        state.request(isDirty: true, isSaving: true) {}

        #expect(state.confirmation == nil)
    }
}
