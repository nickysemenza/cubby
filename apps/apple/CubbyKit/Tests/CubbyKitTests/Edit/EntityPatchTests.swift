import Foundation
import Testing

@testable import CubbyKit

@Suite("EntityPatch")
struct EntityPatchTests {
    private let original: JSONValue = [
        "id": "PRD-2345", "name": "Skillet", "manufacturer": "Acme", "categoryId": "CAT-2224",
        "notes": nil, "expectedQuantity": 2,
    ]

    /// Only changed keys travel: an equal value, an untouched key, and a `null` against an
    /// absent-or-null original are all omitted, while a `null` against a held value clears it.
    @Test func diffSendsChangedValuesAndClearsHeldNullableKeys() throws {
        let patch = try EntityPatch.diff(
            original: original,
            draft: [
                "name": "Skillet",  // unchanged
                "manufacturer": "Lodge",  // changed
                "categoryId": nil,  // held → cleared
                "notes": nil,  // original null → unchanged
                "model": nil,  // original absent → unchanged
                "expectedQuantity": 3,  // changed number
            ],
            nullableKeys: ["categoryId", "notes", "model"]
        )
        #expect(patch.values == ["manufacturer": "Lodge", "expectedQuantity": 3])
        #expect(patch.cleared == ["categoryId"])
        #expect(!patch.isEmpty)
    }

    @Test func identicalDraftIsEmpty() throws {
        let patch = try EntityPatch.diff(
            original: original, draft: ["name": "Skillet", "manufacturer": "Acme"], nullableKeys: [])
        #expect(patch.isEmpty)
        #expect(patch == EntityPatch())
    }

    /// Clearing a key the server does not accept `null` for must fail before a request exists.
    @Test func clearingANonNullableKeyThrows() {
        #expect(throws: EntityPatch.DiffError.clearedNonNullableKey("name")) {
            _ = try EntityPatch.diff(original: original, draft: ["name": nil], nullableKeys: ["categoryId"])
        }
    }

    /// With no original (a row that failed to load) nothing can be "cleared"; a `null` draft key
    /// is simply nothing to send, and every non-null value is a change.
    @Test func withoutAnOriginalEveryValueIsAChangeAndNullIsNothing() throws {
        let patch = try EntityPatch.diff(
            original: nil, draft: ["name": "Skillet", "categoryId": nil], nullableKeys: [])
        #expect(patch.values == ["name": "Skillet"])
        #expect(patch.cleared.isEmpty)
    }
}
