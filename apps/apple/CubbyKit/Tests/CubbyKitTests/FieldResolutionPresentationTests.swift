import Foundation
import Testing

@testable import CubbyKit

/// The server's allocated/inherited values are read-only evidence; stored intent remains the write baseline.
@Suite("Field resolution presentation")
@MainActor
struct FieldResolutionPresentationTests {
    private func field() throws -> FieldDescriptor {
        let source =
            #"{"key":"evidenceExpectation","label":"Receipt expectation","kind":"enum","nullable":true,"controlKind":"select","controlOptions":[{"value":"unknown","label":"Unclassified"},{"value":"required","label":"Expected"},{"value":"not_expected","label":"Not expected"}],"resolution":{"reset":{"evidenceExpectation":null},"none":null,"redundancy":"eligible"},"inCreate":true,"requiredOnCreate":false,"inUpdate":true,"showInList":true,"showInDetail":true,"listHidden":false,"mobileInteractive":false}"#
        return try JSONDecoder().decode(FieldDescriptor.self, from: Data(source.utf8))
    }

    private func row(
        mode: String = "allocated", stored: JSONValue = "required", value: JSONValue = "not_expected",
        canReset: Bool = false, sourceEntity: JSONValue = .null
    ) -> JSONValue {
        [
            "evidenceExpectation": stored,
            "fieldResolutions": [
                "evidenceExpectation": [
                    "mode": .string(mode), "storedValue": stored, "value": value,
                    "fallbackValue": "not_expected",
                    "source": "allocated_purchases", "sourceEntity": sourceEntity, "matchesFallback": true,
                    "canReset": .bool(canReset),
                ]
            ],
        ]
    }

    @Test func allocatedShadowedOverrideDisplaysEffectiveValueAndAggregateSourceWithoutFakeLink() throws {
        let field = try field()
        let resolved = try #require(FieldResolutionPresentation(raw: row(), field: field))
        #expect(resolved.effectiveValue == .string("not_expected"))
        #expect(resolved.storedValue == .string("required"))
        #expect(resolved.sourceEntity == nil)
        #expect(resolved.sourceText.contains("allocated_purchases"))
        #expect(resolved.resetPayload(field: field) == nil)
    }

    @Test func sourceEntityIsOnlyTheServerSuppliedProvenanceAndExplicitUnknownIsRetained() throws {
        let field = try field()
        let source: JSONValue = ["entityKind": "purchase", "entityId": "PUR-4K7M", "name": "Fixture order"]
        let inherited = try #require(
            FieldResolutionPresentation(
                raw: row(mode: "inherit", stored: .null, sourceEntity: source), field: field))
        #expect(inherited.sourceEntity?.entityKind.rawValue == "purchase")
        #expect(inherited.sourceEntity?.entityId == "PUR-4K7M")
        let explicit = try #require(
            FieldResolutionPresentation(
                raw: row(mode: "explicit", stored: "unknown", value: "unknown", canReset: true), field: field)
        )
        #expect(explicit.storedValue == .string("unknown"))
        #expect(explicit.resetPayload(field: field) == ["evidenceExpectation": .null])
    }

    // Regression: an explicit value with nothing to inherit was labelled an override.
    @Test func explicitValueWithNothingAboveIsSetHereNotAnOverride() throws {
        let field = try field()
        func state(_ fallback: JSONValue, matches: Bool) throws -> FieldResolutionState {
            let raw: JSONValue = [
                "fieldResolutions": [
                    "evidenceExpectation": [
                        "mode": "explicit", "storedValue": "required", "value": "required",
                        "fallbackValue": fallback, "source": "explicit", "sourceEntity": .null,
                        "matchesFallback": .bool(matches), "canReset": true,
                    ]
                ]
            ]
            return try #require(FieldResolutionPresentation(raw: raw, field: field)).state
        }
        #expect(try state(.null, matches: false).label == "Set here")
        #expect(try state("not_expected", matches: false).label == "Overrides inherited")
        #expect(try state("required", matches: true).tone == .redundant)
    }

    @Test func ordinaryFieldWithoutServerResolutionKeepsItsOwnValue() throws {
        let field = try field()
        #expect(
            FieldResolutionPresentation.readValue(
                in: ["evidenceExpectation": "unknown"], field: field, surface: "detail") == .string("unknown")
        )
        #expect(
            FieldResolutionPresentation.readValue(in: row(), field: field, surface: "list")
                == .string("not_expected"))
    }
    // An allocation label belongs to its effective target, not a stored override or source Purchase.
    @Test func allocatedReferenceUsesTheMatchingTargetName() throws {
        let source =
            #"{"key":"spendingCategoryId","label":"Spending category","kind":"identifier","nullable":true,"reference":{"entity":"spendingCategory","multiple":false,"scope":[],"filters":[]},"inCreate":true,"requiredOnCreate":false,"inUpdate":true,"showInList":true,"showInDetail":true,"listHidden":false,"mobileInteractive":false}"#
        let field = try JSONDecoder().decode(FieldDescriptor.self, from: Data(source.utf8))
        let raw: JSONValue = [
            "spendingCategoryId": "SPC-4K7M", "spendingCategoryName": "Stored label",
            "spendingCategoryAllocations": [
                ["spendingCategoryId": "SPC-7M4K", "spendingCategoryName": "Supplies", "incomplete": false]
            ],
        ]
        #expect(
            FieldResolutionPresentation.referenceName(in: raw, field: field, effectiveID: "SPC-7M4K")
                == "Supplies")
        var allocatedObject = try #require(raw.objectValue)
        allocatedObject["fieldResolutions"] = [
            "spendingCategoryId": [
                "mode": "allocated", "storedValue": "SPC-4K7M", "value": .null,
                "fallbackValue": .null, "source": "purchase_principal_allocations",
                "sourceEntity": .null, "matchesFallback": false, "canReset": false,
            ]
        ]
        allocatedObject["spendingCategoryAllocations"] = [
            ["spendingCategoryId": "SPC-7M4K", "spendingCategoryName": "Supplies", "incomplete": false],
            ["spendingCategoryId": "SPC-4M7K", "spendingCategoryName": "Services", "incomplete": false],
            ["spendingCategoryId": .null, "spendingCategoryName": .null, "incomplete": true],
        ]
        let allocated = JSONValue.object(allocatedObject)
        #expect(
            FieldResolutionPresentation.allocatedReferenceLabel(in: allocated, field: field)
                == "Supplies, Services, Partly unclassified")
        #expect(FieldResolutionPresentation.allocatedReferenceLabel(in: raw, field: field) == nil)

    }

}
