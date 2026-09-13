import CubbyKit
import SnapshotTesting
import SwiftUI
import Testing

@testable import Cubby

/// `EntityDetailContent` (not `EntityDetailView`) takes plain `descriptor`/`row` state with no
/// network `.task`, which is exactly why it exists as its own type — see its doc comment. Mirrors
/// the file's plain `#Preview` ("Cast Iron Skillet", fed by `PreviewFixtures.sampleDetailRow`).
@MainActor
@Suite("EntityDetailContent snapshots")
struct EntityDetailSnapshotTests {
    @Test("Product detail")
    func productDetail() {
        let view = NavigationStack {
            EntityDetailContent(descriptor: EntityCatalog[.product], row: PreviewFixtures.sampleDetailRow)
                .navigationTitle("Cast Iron Skillet")
        }
        assertSnapshot(
            of: view, as: .image(layout: SnapshotDevice.layout, traits: SnapshotDevice.traits))
    }
}
