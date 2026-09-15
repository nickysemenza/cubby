import CoreGraphics
import CubbyKit
import Foundation
import Testing

@testable import Cubby

@MainActor
@Suite("Photo import flow")
struct PhotoImportFlowTests {
    @Test func entityFlowKeepsReviewedSelectionsWhenNavigatingBack() throws {
        let selected = try selection(filename: "first.jpg")
        let flow = PhotoImportFlowModel(items: [selected])

        flow.chooseEntity(.product, id: "PRD-2345")
        #expect(flow.path == [.review])

        var reviewed = selected
        reviewed.existingImageID = ImageCode("IMG-2345")
        flow.completeReview([reviewed])
        #expect(flow.path == [.review, .entityUpload("product", "PRD-2345")])

        flow.path.removeLast()
        #expect(flow.reviewItems.map(\.id) == [selected.id])
        #expect(flow.reviewItems.first?.existingImageID?.rawValue == "IMG-2345")
        #expect(flow.destination == .entity(.product, id: "PRD-2345"))
    }

    @Test func gardenFlowUsesTheSameOrderedSelectionAfterBackNavigation() throws {
        let first = try selection(filename: "first.jpg")
        let second = try selection(filename: "second.jpg")
        let flow = PhotoImportFlowModel(items: [first, second])

        flow.chooseGarden()
        flow.completeReview([first, second])
        #expect(flow.path == [.review, .gardenImport])

        flow.path.removeLast()
        #expect(flow.reviewItems.map(\.id) == [first.id, second.id])
        #expect(flow.destination == .garden)
    }

    @Test func unfinishedMatchChoiceSurvivesBackAndForwardNavigation() throws {
        let selected = try selection(filename: "choice.jpg")
        let flow = PhotoImportFlowModel(items: [selected])
        let match = ImageCode("IMG-2345")

        flow.chooseGarden()
        flow.reviewDraft.chooseExisting(match, for: selected.id)
        flow.path.removeLast()
        flow.chooseGarden()

        #expect(flow.path == [.review])
        #expect(flow.reviewDraft.decisions[selected.id] == match)
        #expect(flow.reviewDraft.isDirty)
    }

    private func selection(filename: String) throws -> PhotoSelectionItem {
        let image = try #require(
            CGContext(
                data: nil, width: 2, height: 2, bitsPerComponent: 8,
                bytesPerRow: 8, space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)?.makeImage())
        let file = try PhotoFile(
            url: URL(fileURLWithPath: "/unused-\(filename)"), filename: filename,
            contentType: "image/jpeg", size: 1, width: 2, height: 2)
        return PhotoSelectionItem(file: file, preview: image)
    }
}
