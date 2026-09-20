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

    /// The sheet asks `DraftDismissalState` with `isDirty = draft != initialDraft`; an untouched
    /// create dismisses at once, a typed-into one needs Discard.
    @Test func dismissalFollowsTheDraftDiff() {
        let entry = model(.gardenEntry)
        let initial = entry.draft
        var state = DraftDismissalState()
        var dismissed = false
        state.request(isDirty: entry.draft != initial, isSaving: false) { dismissed = true }
        #expect(dismissed)

        entry.draft["note"] = .string("Aphids on the lower leaves")
        dismissed = false
        state.request(isDirty: entry.draft != initial, isSaving: false) { dismissed = true }
        #expect(!dismissed)
        #expect(state.confirmation == .discardChanges)
    }
}
