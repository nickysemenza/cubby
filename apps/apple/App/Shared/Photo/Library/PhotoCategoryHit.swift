import CubbyKit
import Foundation

/// Classifier-hit → category scoring, shared by `PhotoImportManifest.prepareIfNeeded` and
/// Diagnostics (which run the full analysis, B2) and the classification sweep (which runs
/// classify-only, B3) — one place decides "which categories did this classification hit" so a
/// full analysis and the sweep never disagree on the same photo.
enum PhotoCategoryHit {
    /// A classification hit needs at least this much Vision confidence to count toward a
    /// category (Q3b/Q8b) — named so a scoring change is one edit, not a magic number.
    static let minimumCategoryConfidence = 0.3

    /// Every `PhotoImportCatalog.categories` key whose effective `classifierLabels` intersects
    /// `classifications` at or above `minimumCategoryConfidence`. Category names are never a
    /// Swift literal here — everything comes from the generated catalog.
    static func matchedCategories(for classifications: [PhotoClassification]) -> [String] {
        let hits = Set(
            classifications.filter { $0.confidence >= minimumCategoryConfidence }.map(\.identifier))
        guard !hits.isEmpty else { return [] }
        return PhotoImportCatalog.categories
            .filter { !Set($0.classifierLabels).isDisjoint(with: hits) }
            .map(\.key)
    }

    /// The highest-confidence `limit` labels, persisted with a photo-analysis snapshot.
    static func topLabels(for classifications: [PhotoClassification], limit: Int = 5) -> [PhotoLabelScore] {
        classifications.sorted { $0.confidence > $1.confidence }
            .prefix(limit)
            .map { PhotoLabelScore(identifier: $0.identifier, confidence: $0.confidence) }
    }
}
