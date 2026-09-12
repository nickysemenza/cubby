import Foundation
import Testing

@testable import CubbyKit

@Suite("Reconcile wire shapes")
struct ReconcileBodyTests {
    @Test func rowsDecodeWithVerbatimTimestampsAndBarcodes() throws {
        let rows = try Fixtures.decode(SuccessEnvelope<[RecountRow]>.self, from: "inventory-by-location.json").data
        #expect(rows.count == 2)
        let first = try #require(rows.first)
        #expect(first.id == InventoryEntryCode("INV-2345"))
        #expect(first.updatedAtRaw == "2026-03-02T10:00:00.000Z")
        #expect(first.amount == Amount(value: 3, unit: "each"))
        #expect(first.product.barcodes == ["00012345678905", "04006381333931"])
        // The pending image is not a cover; the uploaded one is.
        #expect(first.product.coverImageURL?.absoluteString == "https://images.example/cover.jpg")
        #expect(first.locationID == LocationCode("LOC-5678"))
        #expect(rows[1].product.barcodes.isEmpty)
        #expect(rows[1].product.coverImageURL == nil)
    }

    @Test func snapshotIsTheVerbatimMaxUpdatedAt() throws {
        let rows = try Fixtures.decode(SuccessEnvelope<[RecountRow]>.self, from: "inventory-by-location.json").data
        #expect(RecountRow.snapshotTimestamp(rows) == "2026-03-03T10:00:00.000Z")
        #expect(RecountRow.snapshotTimestamp([]) == nil)
        #expect(RecountRow.gtin14("012345678905") == "00012345678905")
        #expect(RecountRow.gtin14("00012345678905") == "00012345678905")
    }

    @Test func bodyEncodesEachArmWithOnlyItsKeysAndExplicitNullSnapshot() throws {
        let body = ReconcileBody(
            locationId: LocationCode("LOC-5678"),
            expectedInventoryEntryIds: [InventoryEntryCode("INV-2345"), InventoryEntryCode("INV-3456")],
            snapshotUpdatedAt: nil,
            resolutions: [
                .init(.verify, for: InventoryEntryCode("INV-2345")),
                .init(.adjust(Amount(value: 2, unit: "each")), for: InventoryEntryCode("INV-3456")),
                .init(.remove, for: InventoryEntryCode("INV-4567")),
                .init(.relocate(LocationCode("LOC-9ABC"), name: "Unknown"), for: InventoryEntryCode("INV-5678")),
            ]
        )
        let json = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(body))
        #expect(json["locationId"] == "LOC-5678")
        #expect(json["expectedInventoryEntryIds"]?.arrayValue?.count == 2)
        // Present and null, not absent.
        #expect(json["snapshotUpdatedAt"] == .null)
        #expect(json.objectValue?.keys.contains("snapshotUpdatedAt") == true)
        let resolutions = try #require(json["resolutions"]?.arrayValue)
        #expect(resolutions[0].objectValue?.keys.sorted() == ["inventoryEntryId", "kind"])
        #expect(resolutions[1]["amount"]?["value"] == 2)
        #expect(resolutions[1]["amount"]?["unit"] == "each")
        #expect(resolutions[1].objectValue?.keys.contains("targetLocationId") == false)
        #expect(resolutions[2]["kind"] == "remove")
        #expect(resolutions[3]["targetLocationId"] == "LOC-9ABC")
        #expect(resolutions[3].objectValue?.keys.contains("amount") == false)

        let stamped = ReconcileBody(locationId: LocationCode("LOC-5678"), expectedInventoryEntryIds: [], snapshotUpdatedAt: "2026-03-03T10:00:00.000Z", resolutions: [])
        let stampedJSON = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(stamped))
        #expect(stampedJSON["snapshotUpdatedAt"] == "2026-03-03T10:00:00.000Z")
    }

    @Test func staleConflictIsRecognised() throws {
        let error = CubbyAPIError.decode(status: 409, operationID: "inventory.reconcileSession", body: try Fixtures.data(named: "reconcile-stale.json"))
        #expect(error.isStaleInventory)
        #expect(error.reason == "INVENTORY_STALE")
        #expect(error.detail?.code == "CONFLICT")
        let other = CubbyAPIError(status: 409, operationID: "x", detail: nil)
        #expect(!other.isStaleInventory)
    }
}
