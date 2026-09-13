import CubbyKit
import SnapshotTesting
import SwiftUI
import Testing

@testable import Cubby

/// Mirrors `ScanLookupSheet`'s "Unknown code, catalog hit" and "Multiple products" `#Preview`s —
/// `previewOutcome` is the sheet's own preview-only seed (see its doc comment), so no production
/// change was needed to snapshot these two states.
@MainActor
@Suite("ScanLookupSheet snapshots")
struct ScanLookupSheetSnapshotTests {
    @Test("Unknown code, catalog hit")
    func unknownCodeCatalogHit() {
        let view = ScanLookupSheet(
            previewOutcome: .unknownCode(
                .barcode("00012345678905"),
                catalog: UPCLookup(
                    upc: "00012345678905", name: "LED bulbs, 4-pack", manufacturer: "Acme",
                    category: nil, priceDollars: nil, imageURL: nil, source: "upcitemdb", cached: false)
            )
        )
        .environment(PreviewFixtures.signedInModel())
        assertSnapshot(
            of: view, as: .image(layout: SnapshotDevice.layout, traits: SnapshotDevice.traits))
    }

    @Test("Multiple products")
    func multipleProducts() {
        let view = ScanLookupSheet(
            previewOutcome: .products(PreviewFixtures.sampleRows, code: .barcode("012345678905"))
        )
        .environment(PreviewFixtures.signedInModel())
        assertSnapshot(
            of: view, as: .image(layout: SnapshotDevice.layout, traits: SnapshotDevice.traits))
    }
}
