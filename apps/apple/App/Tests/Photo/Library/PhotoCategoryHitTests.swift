import CubbyKit
import Testing

@testable import Cubby

/// `PhotoCategoryHit` is what `PhotoImportManifest.prepareIfNeeded`/Diagnostics (full analysis)
/// and `PhotoClassificationSweep` (classify-only) both call so a photo's categories never differ
/// depending on which path analysed it first.
@Suite("PhotoCategoryHit")
struct PhotoCategoryHitTests {
    @Test func matchedCategoriesRequiresTheConfidenceFloor() throws {
        let category = try #require(PhotoImportCatalog.categories.first { !$0.classifierLabels.isEmpty })
        let label = try #require(category.classifierLabels.first)
        let strongHit = [PhotoClassification(identifier: label, confidence: 0.9)]
        let weakHit = [PhotoClassification(identifier: label, confidence: 0.1)]
        #expect(PhotoCategoryHit.matchedCategories(for: strongHit).contains(category.key))
        #expect(!PhotoCategoryHit.matchedCategories(for: weakHit).contains(category.key))
        #expect(PhotoCategoryHit.matchedCategories(for: []).isEmpty)
    }

    @Test func topLabelsKeepsTheHighestConfidenceEntriesUpToTheLimit() {
        let classifications = (0..<8).map {
            PhotoClassification(identifier: "label-\($0)", confidence: Double($0) / 10)
        }
        let top = PhotoCategoryHit.topLabels(for: classifications, limit: 5)
        #expect(top.count == 5)
        #expect(top.first?.identifier == "label-7")
        #expect(top.map(\.confidence) == top.map(\.confidence).sorted(by: >))
    }
}
