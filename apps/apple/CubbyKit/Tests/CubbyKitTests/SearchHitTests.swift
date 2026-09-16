import Foundation
import Testing

@testable import CubbyKit

@Suite("SearchHit")
struct SearchHitTests {
    @Test func decodesHitsAndResolvesKinds() throws {
        let hits = try Fixtures.decode([SearchHit].self, from: "search-find.json")
        #expect(hits.count == 3)
        #expect(hits[0].key == .product)
        #expect(hits[0].imageURL?.host() == "images.example")
        #expect(hits[1].key == .location)
        #expect(hits[1].subtitle == "Home › Garage › Shelf A")
        #expect(hits[1].typeHint == "box")
    }

    /// `entityType` is a raw string on the wire, so a kind the catalog has not declared still
    /// decodes; it surfaces as `key == nil` and `SearchModel` drops it instead of failing the page.
    @Test func unknownKindIsNil() throws {
        let hits = try Fixtures.decode([SearchHit].self, from: "search-find.json")
        #expect(hits[2].entityType == "widget")
        #expect(hits[2].key == nil)
    }
}
