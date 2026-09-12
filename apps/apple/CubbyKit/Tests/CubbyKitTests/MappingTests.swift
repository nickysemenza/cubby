import Foundation
import Testing

@testable import CubbyKit

@Suite("Generated ↔ domain mapping")
struct MappingTests {
    @Test func scanResponseMapsToScanResult() throws {
        let response = try Fixtures.decode(ScanResponse.self, from: "scan-added.json")
        let result = ScanResult(response)
        #expect(result.outcome == .added)
        #expect(result.product.id == ProductCode("PRD-2345"))
        #expect(result.product.created)
        #expect(result.strays.isEmpty)
    }

    @Test func queuedScanCarriesStrays() throws {
        let response = try Fixtures.decode(ScanResponse.self, from: "scan-queued.json")
        let result = ScanResult(response)
        #expect(result.outcome == .queued)
        #expect(!result.strays.isEmpty)
        let stray = try #require(result.strays.first)
        #expect(stray.locationId.rawValue.hasPrefix("LOC-"))
    }

    @Test func productGetMapsToSummary() throws {
        let response = try Fixtures.decode(ProductGetResponse.self, from: "product-get.json")
        let summary = ProductSummary(response)
        #expect(summary.id == ProductCode("PRD-2345"))
        #expect(summary.name == "Sample Product")
        #expect(summary.manufacturer == "Sample Manufacturer")
    }

    /// The `code` field is an anyOf/oneOf tower in the generated types; on the wire it must be the
    /// flat `{kind, value}` object the server expects.
    @Test func scanBodyEncodesFlatCodeObject() throws {
        let body = ScanBody(location: LocationCode("LOC-2345"), code: .barcode("012345678905"))
        let data = try JSONEncoder().encode(body)
        let json = try JSONDecoder().decode(JSONValue.self, from: data)
        #expect(json["locationId"] == "LOC-2345")
        #expect(json["code"]?["kind"] == "barcode")
        #expect(json["code"]?["value"] == "012345678905")

        let product = ScanBody(location: LocationCode("LOC-2345"), code: .product(ProductCode("PRD-2345")))
        let productJSON = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(product))
        #expect(productJSON["code"]?["kind"] == "product")
        #expect(productJSON["code"]?["value"] == "PRD-2345")
    }

    @Test func resolveBodyEncodesMoves() throws {
        let body = ResolveBody(
            target: LocationCode("LOC-2345"),
            moves: [StrayMove(entryId: InventoryEntryCode("INV-2345")), StrayMove(entryId: InventoryEntryCode("INV-3456"), quantity: 2)]
        )
        let json = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(body))
        #expect(json["targetLocationId"] == "LOC-2345")
        #expect(json["moves"]?[0]?["quantity"] == nil)
        #expect(json["moves"]?[1]?["quantity"]?["value"] == 2)
        #expect(json["moves"]?[1]?["quantity"]?["unit"] == "each")
    }
}
