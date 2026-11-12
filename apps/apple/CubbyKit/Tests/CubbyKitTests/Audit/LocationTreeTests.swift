import Foundation
import Testing

@testable import CubbyKit

@Suite("LocationTree")
struct LocationTreeTests {
    static func tree() throws -> LocationTree {
        LocationTree(roots: try Fixtures.decode([LocationTreeNode].self, from: "location-tree.json"))
    }

    @Test func decodesTheRecursiveNodeAndIndexesParents() throws {
        let tree = try Self.tree()
        #expect(tree.count == 8)
        #expect(tree[LocationCode("LOC-5678")]?.name == "Bin 1")
        #expect(tree.parent(of: LocationCode("LOC-5678"))?.id == LocationCode("LOC-4567"))
        #expect(tree.isRoot(LocationCode("LOC-2345")))
        #expect(tree.isRoot(LocationCode("LOC-9ABC")))
        #expect(!tree.isRoot(LocationCode("LOC-3456")))
        #expect(
            tree[LocationCode("LOC-4567")]?.lastBulkInventory
                == (try LenientISO8601DateTranscoder().decode("2026-08-01T12:00:00.000Z")))
    }

    @Test func ancestorsAndBreadcrumb() throws {
        let tree = try Self.tree()
        #expect(
            tree.ancestors(of: LocationCode("LOC-6789")).map(\.name) == [
                "Bin 1", "Shelf A", "Garage", "Home",
            ])
        #expect(
            tree.breadcrumb(of: LocationCode("LOC-6789")).map(\.name) == [
                "Home", "Garage", "Shelf A", "Bin 1", "Bin 2",
            ])
        #expect(tree.isDescendant(LocationCode("LOC-6789"), of: LocationCode("LOC-3456")))
        #expect(!tree.isDescendant(LocationCode("LOC-3456"), of: LocationCode("LOC-6789")))
        #expect(tree.breadcrumb(of: LocationCode("LOC-ZZZZ")).isEmpty)
    }

    /// Shelf A holds nothing directly, so it is not a stop; its stocked descendants are.
    @Test func auditableBinsAreStockedNodesStalestFirst() throws {
        let tree = try Self.tree()
        #expect(
            tree.auditableBins(under: LocationCode("LOC-3456")).map(\.name) == ["Bin 1", "Bin 2", "Garage"])
        #expect(tree.auditableBins(under: LocationCode("LOC-4567")).map(\.name) == ["Bin 1", "Bin 2"])
        #expect(tree.auditableBins(under: LocationCode("LOC-9ABC")).isEmpty)
    }

    @Test func coverImageURLReadsTheEnvelopeAndSkipsAMissingOne() throws {
        let tree = try Self.tree()
        #expect(tree[LocationCode("LOC-2345")]?.coverImageURL == nil)

        let preferred: JSONValue = [
            "current": [
                "assignment": .null,
                "controls": ["kind": "readonly", "reason": "computed"],
            ],
            "result": [
                "kind": "live",
                "decision": [
                    "outcome": [
                        "kind": "value",
                        "value": [
                            [
                                "id": "IMG-1",
                                "url": "https://images.example/original.heic",
                                "representations": ["preferred": "https://images.example/cutout.png"],
                            ]
                        ],
                    ],
                    "provenance": ["kind": "computed"],
                ],
            ],
        ]
        let originalOnly: JSONValue = [
            "current": [
                "assignment": .null,
                "controls": ["kind": "readonly", "reason": "computed"],
            ],
            "result": [
                "kind": "live",
                "decision": [
                    "outcome": [
                        "kind": "value",
                        "value": [["id": "IMG-2", "url": "https://images.example/original.jpg"]],
                    ]
                ],
            ],
        ]
        #expect(
            LocationTreeNode.coverImageURL(from: preferred)
                == URL(string: "https://images.example/cutout.png"))
        #expect(
            LocationTreeNode.coverImageURL(from: originalOnly)
                == URL(string: "https://images.example/original.jpg"))
    }

    @Test func scopeCandidatesSkipTheEmptyUnknown() throws {
        let tree = try Self.tree()
        let candidates = tree.scopeCandidates()
        #expect(
            candidates.map(\.node.name) == [
                "Home", "Garage", "Shelf A", "Bin 1", "Bin 2", "Kitchen", "Bin 9",
            ])
        #expect(candidates.map(\.depth) == [0, 1, 2, 3, 4, 1, 2])
    }
}
