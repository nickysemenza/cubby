import CubbyKit
import Foundation
import Testing

@testable import Cubby

@Suite("Photo record search")
struct PhotoRecordSearchTests {
    @Test func recognizedTextKeepsCombinedProductNameAndExactShortcode() {
        let analysis = PhotoLocalAnalysis(
            id: "photo", analyzedAt: .now, sha256: "hash", capturedAt: nil,
            contentType: "image/jpeg", width: 1, height: 1, classifications: [],
            recognizedText: [
                PhotoRecognizedText(text: "Hero Flour Tortillas", confidence: 0.9),
                PhotoRecognizedText(text: "PRD-2D6R", confidence: 0.8),
            ], featurePrint: PhotoFeaturePrint(revision: "test", data: Data()),
            provenance: PhotoAnalysisProvenance(source: .files, filename: "photo.jpg"))

        let queries = PhotoRecordSearch.queries(for: analysis)

        #expect(queries.contains("Hero Flour Tortillas PRD-2D6R"))
        #expect(queries.contains("Hero Flour Tortillas"))
        #expect(queries.contains("PRD-2D6R"))
    }

    @Test func recognizedTextDropsBlankAndTooShortTerms() {
        let analysis = PhotoLocalAnalysis(
            id: "photo", analyzedAt: .now, sha256: "hash", capturedAt: nil,
            contentType: "image/jpeg", width: 1, height: 1, classifications: [],
            recognizedText: [
                PhotoRecognizedText(text: "  ", confidence: 1),
                PhotoRecognizedText(text: "8", confidence: 1),
            ], featurePrint: PhotoFeaturePrint(revision: "test", data: Data()),
            provenance: PhotoAnalysisProvenance(source: .files, filename: "photo.jpg"))

        #expect(PhotoRecordSearch.queries(for: analysis).isEmpty)
    }
}
