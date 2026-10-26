import CubbyKit
import Foundation
import Testing

@testable import Cubby

/// The editor's Save/Cancel gating: create is blocked until every `requiredOnCreate` field has a
/// value, and a changed draft must go through the discard confirmation to dismiss.
@MainActor
@Suite("Entity editor draft")
struct EntityEditorDraftTests {
    private func model(_ key: EntityKey, prefill: [String: JSONValue] = [:]) -> GenericEntityEditModel {
        GenericEntityEditModel(
            descriptor: EntityCatalog[key], mode: .create(prefill: prefill),
            client: PreviewFixtures.signedInModel().client)
    }

    @Test func createSaveWaitsForRequiredFields() {
        let entry = model(.gardenEntry)
        // `observedOn` is seeded with today (`initial: "today"`); `locationId` is still missing.
        #expect(entry.missingRequiredKeys == ["locationId"])
        #expect(!entry.canSave)

        entry.draft["locationId"] = .string("LOC-1")
        #expect(entry.canSave)
    }

    @Test func prefillSatisfiesRequiredFieldsAndSeedsHiddenKeys() {
        let entry = model(
            .gardenEntry,
            prefill: [
                "locationId": .string("LOC-1"),
                "plantingIds": .array([.string("PLT-1")]),
            ])
        #expect(entry.canSave)
        #expect(entry.createBody()["plantingIds"] == .array([.string("PLT-1")]))
        #expect(entry.createBody()["observedOn"]?.stringValue == PlainDate(.now).rawValue)
    }

    /// Cancel and its Escape shortcut use the model's dirty state. The system dismissal dialog
    /// uses the same flag for swipe-down; an untouched create closes without confirmation.
    @Test func dismissalFollowsTheDraftDiff() {
        let entry = model(.gardenEntry)
        var state = DraftDismissalState()
        var dismissed = false
        state.request(isDirty: entry.isDirty, isSaving: false) { dismissed = true }
        #expect(dismissed)

        entry.draft["notes"] = .string("Aphids on the lower leaves")
        dismissed = false
        state.request(isDirty: entry.isDirty, isSaving: false) { dismissed = true }
        #expect(!dismissed)
        #expect(state.confirmation == .discardChanges)
    }

    @Test func revertedDraftClosesImmediatelyAndInvalidDraftStillAsksToDiscard() {
        let entry = model(.gardenEntry, prefill: ["locationId": "LOC-2345"])
        entry.draft["notes"] = "Inspect the leaves"
        entry.draft["notes"] = .null
        var state = DraftDismissalState()
        var dismissed = false
        state.request(isDirty: entry.isDirty, isSaving: false) { dismissed = true }
        #expect(dismissed)
        #expect(state.confirmation == nil)

        entry.draft["locationId"] = .null
        #expect(!entry.canSave)
        dismissed = false
        state.request(isDirty: entry.isDirty, isSaving: false) { dismissed = true }
        #expect(!dismissed)
        #expect(state.confirmation == .discardChanges)
    }

    @Test func stagedValuesAndPhotosNeedConfirmationWhileWritesBlockDismissal() {
        let entry = model(.gardenEntry, prefill: ["locationId": "LOC-2345"])
        #expect(entry.stage(["notes": "Review this observation"]))
        var state = DraftDismissalState()
        var dismissed = false
        state.request(isDirty: entry.isDirty, isSaving: true) { dismissed = true }
        #expect(!dismissed)
        #expect(state.confirmation == nil)
        state.request(isDirty: entry.isDirty, isSaving: false) { dismissed = true }
        #expect(!dismissed)
        #expect(state.confirmation == .discardChanges)

        let product = model(.product)
        #expect(!product.isDirty)
        product.pendingUploads = [ImageCode("IMG-2345")]
        var photoState = DraftDismissalState()
        photoState.request(isDirty: product.isDirty, isSaving: false) { dismissed = true }
        #expect(!dismissed)
        #expect(photoState.confirmation == .discardChanges)
    }
}
