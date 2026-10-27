import CubbyKit
import Foundation
import Testing

@testable import Cubby

struct PhotoVisualEvidenceMatcherTests {
    private func field(_ value: JSONValue) -> JSONValue {
        [
            "current": ["assignment": .null, "controls": ["kind": "readonly", "reason": "computed"]],
            "result": [
                "kind": "live",
                "decision": [
                    "outcome": ["kind": "value", "value": value], "provenance": ["kind": "computed"],
                ],
            ],
            "work": ["kind": "idle"],
        ]
    }

    @Test func choosesOnlyAClearBoundedVisualWinner() throws {
        let winner = try #require(
            PhotoVisualEvidenceMatcher.clearWinner([
                ("planting-new-garden-entry:PLT-CJK7", 0.41),
                ("planting-new-garden-entry:PLT-OTHER", 0.72),
            ]))

        #expect(winner.0 == "planting-new-garden-entry:PLT-CJK7")
        #expect(winner.1 == 0.41)
    }

    @Test func abstainsWhenVisualCandidatesAreTooCloseOrTooFar() {
        #expect(
            PhotoVisualEvidenceMatcher.clearWinner([
                ("PLT-A", 0.41),
                ("PLT-B", 0.49),
            ]) == nil)
        #expect(PhotoVisualEvidenceMatcher.clearWinner([("PLT-A", 0.8)]) == nil)
    }

    @Test func ownImageEvidenceKeepsItemAndCoverPhotosButNotLabels() {
        let row = EntityRow(
            id: "PRD-1", title: "Jar", subtitle: nil, imageURL: nil,
            raw: [
                "attachments": [
                    [
                        "role": "attachment", "purpose": "item", "status": "UPLOADED",
                        "fields": ["url": field("https://gallery.example/item.jpg")],
                    ],
                    [
                        "role": "attachment", "purpose": "label", "status": "UPLOADED",
                        "fields": ["url": field("https://gallery.example/label.jpg")],
                    ],
                    [
                        "role": "cover", "status": "UPLOADED",
                        "fields": ["url": field("https://cover.example/c.jpg")],
                    ],
                    [
                        "role": "attachment", "status": "PENDING",
                        "fields": ["url": field("https://p.example/x.jpg")],
                    ],
                ]
            ])

        #expect(
            PhotoVisualEvidenceMatcher.ownImageURLs(in: row) == [
                URL(string: "https://gallery.example/item.jpg")!,
                URL(string: "https://cover.example/c.jpg")!,
            ])
    }

    @Test func visualEvidenceUsesOnlyUploadedDirectAttachments() throws {
        let row = EntityRow(
            id: "MEA-1", title: "Dinner", subtitle: nil,
            imageURL: URL(string: "https://borrowed.example/recipe.jpg"),
            raw: [
                "displayImages": [["url": "https://borrowed.example/recipe.jpg"]],
                "attachments": [
                    [
                        "role": "cover", "status": "UPLOADED",
                        "fields": ["url": field("https://cover.example/should-not-match.jpg")],
                    ],
                    [
                        "role": "attachment", "status": "PENDING",
                        "fields": ["url": field("https://pending.example/should-not-match.jpg")],
                    ],
                    [
                        "role": "attachment", "status": "UPLOADED",
                        "fields": ["url": field("https://gallery.example/direct.jpg")],
                    ],
                ],
            ])

        #expect(
            PhotoVisualEvidenceMatcher.directGalleryURLs(in: row)
                == [URL(string: "https://gallery.example/direct.jpg")!])
    }
    @Test func unavailableAndEmptyImageResultsNeverReviveStaleURLs() {
        let missing: JSONValue = ["result": ["kind": "missing"]]
        let empty: JSONValue = [
            "result": ["kind": "live", "decision": ["outcome": ["kind": "empty", "reason": "unset"]]]
        ]
        let row = EntityRow(
            id: "PRD-1", title: "Synthetic jar", subtitle: nil, imageURL: nil,
            raw: [
                "attachments": [
                    [
                        "role": "attachment", "status": "UPLOADED",
                        "url": "https://stale.example/missing.jpg", "fields": ["url": missing],
                    ],
                    [
                        "role": "cover", "status": "UPLOADED", "url": "https://stale.example/empty.jpg",
                        "fields": ["url": empty],
                    ],
                ]
            ])
        #expect(PhotoVisualEvidenceMatcher.ownImageURLs(in: row).isEmpty)
        #expect(PhotoVisualEvidenceMatcher.directGalleryURLs(in: row).isEmpty)
    }

}
