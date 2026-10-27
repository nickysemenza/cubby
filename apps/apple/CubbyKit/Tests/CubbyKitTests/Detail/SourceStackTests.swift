import Foundation
import Testing

@testable import CubbyKit

/// The shared source stack keeps the server's order and marks levels only from server facts.
@Suite("Source stack")
struct SourceStackTests {
    typealias F = FieldEnvelopeFixture

    private func row(_ title: String) -> JSONValue {
        ["entity": .null, "id": .null, "title": .string(title), "trailing": .null]
    }

    private func step(_ index: Int, effect: String) -> JSONValue {
        [
            "source": "fixture", "reason": "inherit", "effect": .string(effect), "observed": [],
            "rowIndex": .number(Double(index)),
        ]
    }

    @Test func chainLevelsFollowTheirSteps() throws {
        let blockJSON: JSONValue = [
            "kind": "records", "empty": "No sources",
            "rows": [
                row("This record"), row("Fixture order"), row("Synthetic vendor"), row("Default"),
                row("Later"),
            ],
        ]
        let block = try blockJSON.decoded(ReportRecordsBlock.self)
        let stepsJSON: JSONValue = [
            step(0, effect: "overridden"), step(1, effect: "blocked"), step(2, effect: "used"),
            step(3, effect: "future_effect"),
        ]
        let steps = try stepsJSON.decoded([FieldDecisionStep].self)
        let levels = SourceStack.levels(chain: block, steps: steps)
        #expect(
            levels.map(\.title) == ["This record", "Fixture order", "Synthetic vendor", "Default", "Later"])
        #expect(
            levels.map(\.status) == [.skipped, .blocked, .deciding, .unsupported("future_effect"), .skipped])
        #expect(SourceStack.levels(chain: block, steps: nil).allSatisfy { $0.status == .skipped })
    }

    @Test func plainSourcesDecideOnlyFromACurrentResult() throws {
        let sourcesJSON: JSONValue = [
            [
                "label": "Product", "entity": ["entityKind": "product", "entityId": "PRD-4K7M"],
                "value": .null,
            ],
            [
                "label": "Category", "entity": ["entityKind": "productCategory", "entityId": "CAT-4K7M"],
                "value": .null,
            ],
        ]
        let sources = try sourcesJSON.decoded([FieldExplanationSource].self)
        let decision = F.decision("LPY-4K7M", provenance: F.inherited("productCategory", "CAT-4K7M"))
        let live = FieldEnvelope(F.envelope(result: F.live(decision)))
        #expect(SourceStack.levels(sources: sources, envelope: live).map(\.status) == [.skipped, .deciding])
        #expect(SourceStack.levels(sources: sources, envelope: live).last?.target?.id == "CAT-4K7M")
        // A stale cache's recorded provenance is never attached to current sources.
        let stale = FieldEnvelope(F.envelope(result: F.cached(decision, freshness: "stale")))
        #expect(SourceStack.levels(sources: sources, envelope: stale).map(\.status) == [.skipped, .skipped])
        let fresh = FieldEnvelope(F.envelope(result: F.cached(decision, freshness: "fresh")))
        #expect(SourceStack.levels(sources: sources, envelope: fresh).map(\.status) == [.skipped, .deciding])
        // Allocation contributors are contributors; none is invented as the deciding source.
        let allocated = FieldEnvelope(
            F.envelope(result: F.live(F.emptyDecision("mixed", provenance: ["kind": "allocated"]))))
        #expect(
            SourceStack.levels(sources: sources, envelope: allocated).map(\.status) == [.skipped, .skipped])
    }

    @Test func imageLevelHoldingTheCoverDecides() throws {
        let chainJSON: JSONValue = [
            "levels": [
                ["label": "Own", "source": .null, "images": []],
                [
                    "label": "From product PRD-4K7M",
                    "source": ["entityKind": "product", "entityId": "PRD-4K7M"],
                    "images": [
                        ["id": "IMG-4K7M", "url": "https://images.example.test/a.jpg", "chosen": true],
                        ["id": "IMG-7M4K", "url": "https://images.example.test/b.jpg", "chosen": false],
                    ],
                ],
            ]
        ]
        let chain = try chainJSON.decoded(ImageChainExplanation.self)
        let levels = SourceStack.levels(imageChain: chain)
        #expect(levels.map(\.status) == [.skipped, .deciding])
        #expect(levels.map(\.target?.id) == [nil, "PRD-4K7M"])
        #expect(Set(levels.map(\.id)).count == 2)
    }
}
