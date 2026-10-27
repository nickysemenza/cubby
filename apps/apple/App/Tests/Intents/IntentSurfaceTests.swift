import CubbyKit
import Foundation
import Testing

@testable import Cubby

@MainActor
@Suite("Audit intent surface", .serialized)
struct AuditIntentSurfaceTests {
    @Test func captureControlOpensCaptureAndPreservesTheOtherTabsHistory() async throws {
        let previous = AppModel.active
        defer { AppModel.active = previous }
        let model = AppModel.preview(signedIn: false, baseURL: URL(string: "https://cubby.example.com")!)
        AppModel.active = model
        model.navigator.section = .search
        model.navigator.paths[.search] = [.entityDetail(.product, id: "PRD-ABCD")]
        model.navigator.paths[.capture] = [.identify]

        _ = try await OpenCaptureControlIntent().perform()

        #expect(model.navigator.section == .capture)
        #expect(model.navigator.paths[.capture] == [])
        #expect(model.navigator.paths[.search] == [.entityDetail(.product, id: "PRD-ABCD")])
    }

    @Test func cookIntentRejectsANonRecipe() async throws {
        var intent = CookRecipeIntent()
        intent.recipe = CubbyEntity(
            row: EntityRow(id: "PRD-2345", title: "Synthetic Jar", subtitle: nil, imageURL: nil, raw: .null),
            kind: .product)

        await #expect(throws: (any Error).self) {
            try await intent.perform()
        }
    }

    @Test func nonLocationPickRequiresAnotherValueBeforeOpeningAudit() async throws {
        var intent = StartAuditIntent()
        intent.location = CubbyEntity(
            row: EntityRow(id: "PRD-2345", title: "Jar", subtitle: nil, imageURL: nil, raw: .null),
            kind: .product)

        await #expect(throws: (any Error).self) {
            try await intent.perform()
        }
    }
    @Test func productLocationDistinguishesUnavailableFromEmptyAndRetainsCachedPlacement() {
        func row(result: JSONValue, work: JSONValue = ["kind": "idle"]) -> EntityRow {
            EntityRow(
                id: "PRD-2345", title: "Synthetic jar", subtitle: nil, imageURL: nil,
                raw: [
                    "primaryPlacement": ["path": "Stale top-level location"],
                    "fields": [
                        "primaryPlacement": [
                            "current": [
                                "assignment": .null, "controls": ["kind": "readonly", "reason": "computed"],
                            ],
                            "result": result, "work": work,
                        ]
                    ],
                ])
        }
        let empty = row(result: [
            "kind": "live",
            "decision": ["outcome": ["kind": "empty", "reason": "unset"], "provenance": .null],
        ])
        let missing = row(result: ["kind": "missing"])
        let unsupported = row(result: ["kind": "future-result"])
        let cached = row(
            result: [
                "kind": "cached", "computedAt": "2026-10-25T12:00:00Z", "freshness": "stale",
                "decision": [
                    "outcome": ["kind": "value", "value": ["path": "Home › Pantry"]],
                    "provenance": ["kind": "computed"],
                ],
            ], work: ["kind": "failed", "error": "Synthetic refresh failed", "retryAt": .null])
        #expect(
            WhereIsProductIntent.placementDescription(for: empty) == "Synthetic jar isn't stocked anywhere.")
        #expect(
            WhereIsProductIntent.placementDescription(for: missing)
                == "Location for Synthetic jar is unavailable.")
        #expect(
            WhereIsProductIntent.placementDescription(for: unsupported)
                == "Location for Synthetic jar is unavailable.")
        #expect(
            WhereIsProductIntent.placementDescription(for: cached) == "Synthetic jar is in Home › Pantry.")
    }

}
