import Foundation
import Testing

@testable import CubbyKit

@Suite("Reconcile wire shapes")
struct ReconcileBodyTests {
    @Test func rowsDecodeWithVerbatimTimestampsAndBarcodes() throws {
        let rows = try Fixtures.decode([RecountRow].self, from: "inventory-by-location.json")
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
        let rows = try Fixtures.decode([RecountRow].self, from: "inventory-by-location.json")
        #expect(RecountRow.snapshotTimestamp(rows) == "2026-03-03T10:00:00.000Z")
        #expect(RecountRow.snapshotTimestamp([]) == nil)
        #expect(RecountRow.gtin14("012345678905") == "00012345678905")
        #expect(RecountRow.gtin14("00012345678905") == "00012345678905")
    }

    /// `updatedAtRaw` re-derives from the decoded `Date` through the generated
    /// `RecountRow.init(_:InventoryRowOut)` (`Mapping.swift`), the path `CubbyClient.inventory`
    /// and `.reconcile` actually use — as opposed to `RecountRow`'s own lenient `Decodable` above,
    /// which is exercised directly on the wire fixture. `LenientISO8601DateTranscoder` always
    /// re-encodes with exactly three fractional-second digits, regardless of how many the source
    /// string carried.
    @Test func productionMappingReDerivesUpdatedAtWithThreeFractionalDigits() throws {
        let transcoder = LenientISO8601DateTranscoder()
        for (raw, expected) in [
            ("2026-03-02T10:00:00.000Z", "2026-03-02T10:00:00.000Z"),
            ("2026-03-02T10:00:00.5Z", "2026-03-02T10:00:00.500Z"),
            ("2026-03-02T10:00:00.999Z", "2026-03-02T10:00:00.999Z"),
            ("2026-03-02T10:00:00Z", "2026-03-02T10:00:00.000Z"),
        ] {
            let date = try transcoder.decode(raw)
            let out = InventoryRowOut(
                id: "INV-2345",
                amount: .init(value: 1, unit: "each"),
                placement: .stock,
                createdAt: date,
                updatedAt: date,
                product: .init(
                    id: "PRD-2345", name: "Sample Product", manufacturer: "Sample Manufacturer",
                    createdAt: date, updatedAt: date, images: [], externalIds: [], unitMappings: []
                ),
                location: .init(
                    id: "LOC-5678", name: "Bin 1", aliases: [], images: [], createdAt: date, updatedAt: date),
                displayName: "Sample Product · Bin 1"
            )
            #expect(RecountRow(out).updatedAtRaw == expected)
        }
    }

    @Test func bodyEncodesEachArmWithOnlyItsKeysAndOmitsAnEmptySnapshot() throws {
        let body = ReconcileBody(
            locationId: LocationCode("LOC-5678"),
            expectedInventoryEntryIds: [InventoryEntryCode("INV-2345"), InventoryEntryCode("INV-3456")],
            snapshotUpdatedAt: nil,
            resolutions: [
                .init(.verify, for: InventoryEntryCode("INV-2345")),
                .init(.adjust(Amount(value: 2, unit: "each")), for: InventoryEntryCode("INV-3456")),
                .init(.remove, for: InventoryEntryCode("INV-4567")),
                .init(
                    .relocate(LocationCode("LOC-9ABC"), name: "Unknown"), for: InventoryEntryCode("INV-5678")),
            ]
        )
        let json = try JSONDecoder().decode(
            JSONValue.self, from: JSONEncoder.cubby().encode(ReconcileInput(body)))
        #expect(json["locationId"] == "LOC-5678")
        #expect(json["expectedInventoryEntryIds"]?.arrayValue?.count == 2)
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

        let stamped = ReconcileBody(
            locationId: LocationCode("LOC-5678"), expectedInventoryEntryIds: [],
            snapshotUpdatedAt: "2026-03-03T10:00:00.000Z", resolutions: []
        )
        let stampedJSON = try JSONDecoder().decode(
            JSONValue.self, from: JSONEncoder.cubby().encode(ReconcileInput(stamped))
        )
        #expect(stampedJSON["snapshotUpdatedAt"] == "2026-03-03T10:00:00.000Z")
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
