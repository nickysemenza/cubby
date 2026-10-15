import Foundation
import Testing

@testable import CubbyKit

/// The Photos "New ‹entity›" destination's create-editor prefill: uploaded ids always travel as
/// `pendingImageIds`, and the selection's earliest capture date fills any date field the catalog
/// defaults to today — so a batch of photos taken last week lands on last week's date.
@Suite("photoCreatePrefill")
struct PhotoCreatePrefillTests {
    @Test func gardenEntryLikeDescriptorGetsObservedOn() throws {
        let earliest = try #require(
            DateComponents(calendar: .init(identifier: .gregorian), year: 2026, month: 3, day: 5).date)
        let prefill = photoCreatePrefill(
            for: EntityCatalog[.gardenEntry],
            imageIDs: [ImageCode("IMG-1"), ImageCode("IMG-2")],
            earliestCapturedAt: earliest)

        #expect(prefill["pendingImageIds"] == .array([.string("IMG-1"), .string("IMG-2")]))
        #expect(prefill["observedOn"] == .string(PlainDate(earliest).rawValue))
    }

    @Test func taskLikeDescriptorGetsNoDate() throws {
        let prefill = photoCreatePrefill(
            for: EntityCatalog[.task], imageIDs: [ImageCode("IMG-1")], earliestCapturedAt: .now)

        #expect(prefill["pendingImageIds"] == .array([.string("IMG-1")]))
        #expect(prefill.keys.filter { $0 != "pendingImageIds" }.isEmpty)
    }

    @Test func imagesAlwaysTravelEvenWithoutACaptureDate() throws {
        let prefill = photoCreatePrefill(for: EntityCatalog[.task], imageIDs: [], earliestCapturedAt: nil)

        #expect(prefill["pendingImageIds"] == .array([]))
    }

    @Test func noCaptureDateLeavesDateFieldsUnset() throws {
        let prefill = photoCreatePrefill(
            for: EntityCatalog[.gardenEntry], imageIDs: [ImageCode("IMG-1")], earliestCapturedAt: nil)

        #expect(prefill["observedOn"] == nil)
    }
}
