import Foundation
import Testing

@testable import CubbyKit

@Suite("SearchHit")
struct SearchHitTests {
    @Test func decodesHitsAndResolvesKnownKinds() throws {
        let hits = try Fixtures.decode(SuccessEnvelope<[SearchHit]>.self, from: "search-find.json").data
        #expect(hits.count == 3)
        #expect(hits[0].key == .product)
        #expect(hits[0].imageURL?.host() == "images.example")
        #expect(hits[1].key == .location)
        #expect(hits[1].subtitle == "Home › Garage › Shelf A")
        #expect(hits[1].typeHint == "box")
        // An unknown kind decodes (the app must not crash on a new server kind) but has no key.
        #expect(hits[2].key == nil)
    }

    @Test func stockedAtReadsInventoryEntries() throws {
        let raw: JSONValue = [
            "id": "PRD-2345",
            "name": "Sample Product",
            "inventoryEntry": [
                [
                    "id": "INV-2345",
                    "amount": ["value": 3, "unit": "each"],
                    "placement": "stock",
                    "location": ["id": "LOC-5678", "name": "Bin 1", "ancestors": [["name": "Home"], ["name": "Garage"]]],
                ],
                ["id": "INV-3456", "location": ["id": "LOC-9ABC", "name": "Unknown", "ancestors": []]],
            ],
        ]
        let row = try #require(EntityCatalog[.product].row(from: raw))
        let stocked = ProductRelations.stockedAt(from: row)
        #expect(stocked.count == 2)
        #expect(stocked[0].locationID == LocationCode("LOC-5678"))
        #expect(stocked[0].ancestorPath == "Home › Garage")
        #expect(stocked[0].amount == Amount(value: 3, unit: "each"))
        #expect(stocked[1].ancestorPath == nil)
        #expect(stocked[1].amount == nil)
    }
}
