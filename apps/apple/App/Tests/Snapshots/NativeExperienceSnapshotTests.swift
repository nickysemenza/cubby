import CubbyKit
import SnapshotTesting
import SwiftUI
import Testing
import UIKit

@testable import Cubby

@MainActor
@Suite("Native appearance snapshots")
struct NativeExperienceSnapshotTests {
    @Test func detailDark() {
        let view = NavigationStack {
            EntityDetailContent(descriptor: EntityCatalog[.product], row: PreviewFixtures.sampleDetailRow)
        }.environment(PreviewFixtures.signedInModel())
        assertSnapshot(
            of: view,
            as: .image(
                layout: SnapshotDevice.layout,
                traits: UITraitCollection(userInterfaceStyle: .dark)))
    }

    @Test func todayPartialFailure() {
        let view = NavigationStack {
            TodayContent(
                dateText: "Monday, September 14", tasks: .loaded(PreviewFixtures.sampleTodayTasks),
                meals: .failed("Couldn't load meals."), problems: .loading, onRefresh: {}
            )
            .navigationTitle("Today")
        }.environment(PreviewFixtures.signedInModel())
        assertSnapshot(of: view, as: .image(layout: SnapshotDevice.layout, traits: SnapshotDevice.traits))
    }

    @Test func detailAccessibilityText() {
        let view = NavigationStack {
            EntityDetailContent(descriptor: EntityCatalog[.product], row: PreviewFixtures.sampleDetailRow)
                .dynamicTypeSize(.accessibility3)
        }.environment(PreviewFixtures.signedInModel())
        assertSnapshot(of: view, as: .image(layout: SnapshotDevice.layout, traits: SnapshotDevice.traits))
    }

    @Test func searchLoading() {
        let model = PreviewFixtures.signedInModel()
        let search = SearchModel(client: model.client, previewPhase: .searching)
        let view = NavigationStack { SearchContent(search: search) }.environment(model)
        assertSnapshot(of: view, as: .image(layout: SnapshotDevice.layout, traits: SnapshotDevice.traits))
    }
    @Test func adjustmentEditor() {
        let model = PreviewFixtures.signedInModel()
        let view = AdjustCountSheet(
            session: RecountSession(service: model.client),
            id: InventoryEntryCode("INV-1234"), amount: Amount(value: 1.5, unit: "units"))
        assertSnapshot(of: view, as: .image(layout: SnapshotDevice.layout, traits: SnapshotDevice.traits))
    }

    @Test func tabletDetail() {
        let view = NavigationStack {
            EntityDetailContent(descriptor: EntityCatalog[.product], row: PreviewFixtures.sampleDetailRow)
        }.environment(PreviewFixtures.signedInModel())
        assertSnapshot(
            of: view, as: .image(layout: .device(config: .iPadPro11), traits: SnapshotDevice.traits))
    }

}
