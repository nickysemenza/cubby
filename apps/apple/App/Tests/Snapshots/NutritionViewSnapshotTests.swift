import CubbyKit
import SnapshotTesting
import SwiftUI
import Testing

@testable import Cubby

@MainActor
@Suite("Nutrition view snapshots")
struct NutritionViewSnapshotTests {
    @Test("Standard iPhone")
    func standardPhone() {
        assertSnapshot(
            of: nutritionView, as: .image(layout: SnapshotDevice.layout, traits: SnapshotDevice.traits))
    }

    @Test("Accessibility Dynamic Type")
    func accessibilityDynamicType() {
        assertSnapshot(
            of: nutritionView.dynamicTypeSize(.accessibility3),
            as: .image(layout: SnapshotDevice.layout, traits: SnapshotDevice.traits))
    }

    private var nutritionView: some View {
        NavigationStack {
            ScrollView {
                MealNutritionPeopleView(
                    summary: PreviewFixtures.sampleMealNutrition, showMealHeadings: true
                )
                .padding()
            }
            .navigationTitle("Nutrition")
        }
    }
}
