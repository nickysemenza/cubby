import CubbyKit
import Foundation

/// Sample data for the audit screens' `#Preview`s. No real household data — placeholders only,
/// matching `PreviewFixtures`' convention for the rest of the app.
///
/// Kept separate from `PreviewFixtures` (which this target may not edit) because
/// `RecountSession.RowState` and `ScanSession.QueuedStray` have no public initializer — CubbyKit
/// only ever builds one from a server response — so a preview row is assembled from its
/// constructible pieces (`RecountRow`, `RecountResolution`, `Bool`) instead of the wrapper type.
enum AuditPreviewData {
    static let sampleRow = RecountRow(
        id: InventoryEntryCode("INV-1234"),
        amount: Amount(value: 3, unit: "each"),
        updatedAtRaw: "2026-09-01T12:00:00.000Z",
        product: RecountRow.Product(
            id: ProductCode("PRD-2345"),
            name: "Sample Product",
            manufacturer: "Sample Manufacturer",
            coverImageURL: nil
        ),
        locationID: LocationCode("LOC-1001"),
        locationName: "Bin 1"
    )
}
