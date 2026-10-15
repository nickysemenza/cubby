import Foundation
import Testing

@testable import CubbyKit

@Suite("Reconcile wire shapes")
struct ReconcileBodyTests {
    @Test func rowsCarryBarcodesAndTheUploadedCover() throws {
        let rows = try Fixtures.decode(
            [InventoryWithLocationAndProductOut].self, from: "inventory-by-location.json"
        )
        .map(RecountRow.init)
        #expect(rows.count == 2)
        let first = try #require(rows.first)
        #expect(first.id == InventoryEntryCode("INV-2345"))
        #expect(first.amount == Amount(value: 3, unit: "each"))
        #expect(first.product.barcodes == ["00012345678905", "04006381333931"])
        // The pending image is not a cover; the uploaded one is.
        #expect(first.product.coverImageURL?.absoluteString == "https://images.example/cover.jpg")
        #expect(first.locationID == LocationCode("LOC-5678"))
        #expect(rows[1].product.barcodes.isEmpty)
        #expect(rows[1].product.coverImageURL == nil)
    }

    @Test func bodyEncodesEachArmAndPreservesCompleteSnapshotToken() throws {
        let body = ReconcileSessionPayload(
            locationId: LocationCode("LOC-5678"),
            expectedInventoryEntryIds: [InventoryEntryCode("INV-2345"), InventoryEntryCode("INV-3456")],
            snapshotUpdatedAt: nil,
            snapshotToken: "complete-server-snapshot",
            resolutions: [
                RecountResolution.verify.resolution(for: InventoryEntryCode("INV-2345")),
                RecountResolution.adjust(Amount(value: 2, unit: "each")).resolution(
                    for: InventoryEntryCode("INV-3456")),
                RecountResolution.remove.resolution(for: InventoryEntryCode("INV-4567")),
                RecountResolution.relocate(LocationCode("LOC-9ABC"), name: "Unknown")
                    .resolution(for: InventoryEntryCode("INV-5678")),
            ]
        )
        let json = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder.cubby().encode(body))
        #expect(json["locationId"] == "LOC-5678")
        #expect(json["expectedInventoryEntryIds"]?.arrayValue?.count == 2)
        #expect(json["snapshotToken"] == "complete-server-snapshot")
        // `packages/schemas/src/inventory.ts` documents this on purpose: the generated payload's
        // synthesized encoder omits an Optional key instead of sending explicit `null`, so the
        // server accepts the field `.nullish()`, not `.nullable()`, for an empty-bin commit.
        #expect(json.objectValue?.keys.contains("snapshotUpdatedAt") == false)
        let resolutions = try #require(json["resolutions"]?.arrayValue)
        #expect(resolutions[0].objectValue?.keys.sorted() == ["inventoryEntryId", "kind"])
        #expect(resolutions[1]["amount"]?["value"] == 2)
        #expect(resolutions[1]["amount"]?["unit"] == "each")
        #expect(resolutions[1].objectValue?.keys.contains("targetLocationId") == false)
        #expect(resolutions[2]["kind"] == "remove")
        #expect(resolutions[3]["targetLocationId"] == "LOC-9ABC")
        #expect(resolutions[3].objectValue?.keys.contains("amount") == false)

        // The snapshot goes back with the millisecond the server sent, whatever fraction the
        // source string carried: the reconcile guard compares to the millisecond.
        for (raw, expected) in [
            ("2026-03-03T10:00:00.000Z", "2026-03-03T10:00:00.000Z"),
            ("2026-03-03T10:00:00.5Z", "2026-03-03T10:00:00.500Z"),
            ("2026-03-03T10:00:00Z", "2026-03-03T10:00:00.000Z"),
        ] {
            let stamped = ReconcileSessionPayload(
                locationId: LocationCode("LOC-5678"), expectedInventoryEntryIds: [],
                snapshotUpdatedAt: try LenientISO8601DateTranscoder().decode(raw), resolutions: []
            )
            let stampedJSON = try JSONDecoder().decode(
                JSONValue.self, from: JSONEncoder.cubby().encode(stamped))
            #expect(stampedJSON["snapshotUpdatedAt"] == .string(expected))
        }
    }

    @Test func staleConflictIsRecognised() throws {
        let error = CubbyAPIError.decode(
            status: 409, operationID: "inventory.reconcileSession",
            body: try Fixtures.data(named: "reconcile-stale.json"))
        #expect(error.isStaleInventory)
        #expect(error.reason == "INVENTORY_STALE")
        #expect(error.detail?.code == "CONFLICT")
        let other = CubbyAPIError(status: 409, operationID: "x", detail: nil)
        #expect(!other.isStaleInventory)
    }
}
