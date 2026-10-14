import CoreGraphics
import CubbyKit
import Foundation
import Testing

@testable import Cubby

@MainActor
@Suite("Photo import preparation")
struct PhotoImportRunPreparationTests {
    /// A cloud-fetch failure must retain both the failed selection and successful files;
    /// Retry acts on the failed photo, and no import starts until all failures are resolved
    /// or the member explicitly continues without them.
    @Test func preparationFailuresKeepSelectionsAndSuccessfulFiles() async throws {
        let first = try selection("first.jpg")
        let second = try selection("second.jpg")
        let flow = PhotoImportRunFlow(
            client: PreviewFixtures.signedInModel().client,
            waitForPreparationConditions: { _ in },
            materializePhoto: { item in
                if item.id == second.id { throw URLError(.networkConnectionLost) }
                guard case .file(let file) = item.source else { throw PhotoFile.Failure.unreadable }
                return file
            })
        flow.startNewRun(items: [first, second], client: PreviewFixtures.signedInModel().client)
        await flow.waitForPreparation()
        #expect(flow.step == .preparationNeedsAttention)
        #expect(flow.preparedPhotoIDs == [first.id])
        #expect(flow.failedPreparationItems.map(\.id) == [second.id])
        #expect(flow.selectedPhotos.map(\.id) == [first.id, second.id])
        #expect(flow.session.phase == .idle)

        flow.retryPreparation(second.id)
        await flow.waitForPreparation()
        #expect(flow.preparedPhotoIDs == [first.id])
        #expect(flow.failedPreparationItems.map(\.id) == [second.id])
        #expect(flow.session.phase == .idle)
    }

    private func selection(_ filename: String) throws -> PhotoSelectionItem {
        let image = try #require(
            CGContext(
                data: nil, width: 2, height: 2, bitsPerComponent: 8, bytesPerRow: 8,
                space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)?
                .makeImage())
        let file = try PhotoFile(
            url: URL(fileURLWithPath: "/unused-\(filename)"), filename: filename,
            contentType: "image/jpeg", size: 1, width: 2, height: 2)
        return PhotoSelectionItem(file: file, preview: image)
    }
}
