import CubbyKit
import SnapshotTesting
import SwiftUI
import Testing

@testable import Cubby

/// `SearchContent` (not `SearchView`) is the snapshot target: `SearchView` creates its
/// `SearchModel` and calls `start()` from a network-backed `.task`, which is not deterministic to
/// render synchronously. `SearchModel`'s `#if DEBUG` preview initializer seeds `phase`/`recents`
/// directly instead, matching the states `SearchView`'s own "Empty" and "Results" `#Preview`s show.
@MainActor
@Suite("SearchContent snapshots")
struct SearchViewSnapshotTests {
    @Test("Empty state, recents present")
    func emptyStateWithRecents() {
        let model = PreviewFixtures.signedInModel()
        let recents = PreviewFixtures.sampleRows.map { row in
            SearchModel.RecentRow(key: .product, row: row)
        }
        let search = SearchModel(client: model.client, previewPhase: .idle, previewRecents: recents)
        let view = NavigationStack { SearchContent(search: search) }
            .environment(model)
        assertSnapshot(
            of: view, as: .image(layout: SnapshotDevice.layout, traits: SnapshotDevice.traits))
    }

    @Test("Results state")
    func resultsState() {
        let model = PreviewFixtures.signedInModel()
        let hits = PreviewFixtures.sampleRows.map { row in
            SearchHit(
                id: row.id, entityType: "product", title: row.title, subtitle: row.subtitle,
                typeHint: nil, imageURL: row.imageURL, matchKind: "text", matchReason: "name")
        }
        let search = SearchModel(
            client: model.client,
            previewPhase: .results([SearchModel.ResultGroup(key: .product, hits: hits)]))
        let view = NavigationStack { SearchContent(search: search) }
            .environment(model)
        assertSnapshot(
            of: view, as: .image(layout: SnapshotDevice.layout, traits: SnapshotDevice.traits))
    }
}
