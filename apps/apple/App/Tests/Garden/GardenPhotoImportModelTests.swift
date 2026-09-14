import CoreGraphics
import CubbyKit
import Foundation
import Testing

@testable import Cubby

@MainActor
@Suite("Garden photo import")
struct GardenPhotoImportModelTests {
    @Test func existingOnlySelectionIsAttached() async throws {
        var item = try selection(capturedAt: Date(timeIntervalSince1970: 1_700_000_000))
        item.existingImageID = ImageCode("IMG-EXISTING")
        var records: [RecordGardenEntry] = []
        let model = await model(
            items: [item],
            record: {
                records.append($0)
                return "GEN-1"
            })
        model.locationID = "LOC-1"

        #expect(await model.save())
        #expect(records.first?.pendingImageIDs == [ImageCode("IMG-EXISTING")])
        #expect(model.uploadedIDs == [ImageCode("IMG-EXISTING")])
    }

    @Test func earlierAliasResolvesLaterDaySourceWithoutDuplicateUpload() async throws {
        let later = try selection(capturedAt: Date(timeIntervalSince1970: 1_700_086_400))
        var earlierAlias = try selection(capturedAt: Date(timeIntervalSince1970: 1_700_000_000))
        earlierAlias.existingImageID = ImageCode("draft:\(later.id)")
        var uploadCount = 0
        var records: [RecordGardenEntry] = []
        let model = await model(
            items: [later, earlierAlias],
            upload: { _ in
                uploadCount += 1
                return ImageCode("IMG-UPLOADED")
            },
            record: {
                records.append($0)
                return "GEN-\(records.count)"
            })
        model.locationID = "LOC-1"

        #expect(await model.save())
        #expect(uploadCount == 1)
        #expect(records.count == 2)
        #expect(records.allSatisfy { $0.pendingImageIDs == [ImageCode("IMG-UPLOADED")] })
    }

    @Test func removingMatchedSourceBlocksSaveWithClearError() async throws {
        let source = try selection(capturedAt: Date(timeIntervalSince1970: 1_700_086_400))
        var alias = try selection(capturedAt: Date(timeIntervalSince1970: 1_700_000_000))
        alias.existingImageID = ImageCode("draft:\(source.id)")
        let model = await model(items: [source, alias])
        model.locationID = "LOC-1"
        let sourceDraft = try #require(model.drafts.first { $0.items.contains { $0.id == source.id } })

        model.remove(source.id, from: sourceDraft.id)

        #expect(!model.isReady)
        #expect(model.selectionError?.contains("was removed") == true)
    }

    @Test func retryKeepsConfirmedDayAndReusesUploadedPhoto() async throws {
        let first = try selection(capturedAt: Date(timeIntervalSince1970: 1_700_000_000))
        let second = try selection(capturedAt: Date(timeIntervalSince1970: 1_700_086_400))
        var uploadCount = 0
        var recordCount = 0
        var recordedLocations: [String] = []
        var failSecondRecord = true
        let model = await model(
            items: [first, second],
            upload: { _ in
                uploadCount += 1
                return ImageCode("IMG-\(uploadCount)")
            },
            record: { entry in
                recordCount += 1
                recordedLocations.append(entry.locationID)
                if recordCount == 2, failSecondRecord {
                    failSecondRecord = false
                    throw TestFailure.record
                }
                return "GEN-\(recordCount)"
            })
        model.locationID = "LOC-1"

        #expect(!(await model.save()))
        #expect(model.confirmedDraftIDs.count == 1)
        model.locationID = "LOC-2"
        #expect(await model.save())
        #expect(uploadCount == 2)
        #expect(recordCount == 3)
        #expect(recordedLocations == ["LOC-1", "LOC-1", "LOC-1"])
    }

    @Test func undatedPhotoRequiresExplicitDateConfirmation() async throws {
        let model = await model(items: [try selection(capturedAt: nil)])
        model.locationID = "LOC-1"
        let draft = try #require(model.drafts.first)
        #expect(!model.isReady)

        model.setDate(Date(timeIntervalSince1970: 1_700_000_000), for: draft.id)

        #expect(model.isReady)
    }

    private func model(
        items: [PhotoSelectionItem],
        upload: @escaping GardenPhotoImportModel.UploadPhoto = { _ in ImageCode("IMG-UPLOADED") },
        record: @escaping GardenPhotoImportModel.RecordEntry = { _ in "GEN-1" }
    ) async -> GardenPhotoImportModel {
        await GardenPhotoImportModel(
            items: items,
            loadOptions: {
                GardenOptions(ingredients: [], locations: [], products: [], plantings: [])
            },
            uploadPhoto: upload,
            recordEntry: record)
    }

    private func selection(capturedAt: Date?) throws -> PhotoSelectionItem {
        let preview = try #require(
            CGContext(
                data: nil, width: 2, height: 2, bitsPerComponent: 8,
                bytesPerRow: 8, space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)?.makeImage())
        let file = try PhotoFile(
            url: URL(fileURLWithPath: "/unused-garden-test-photo.png"), filename: "garden.png",
            contentType: "image/png", size: 1, width: 2, height: 2, capturedAt: capturedAt)
        return PhotoSelectionItem(file: file, preview: preview)
    }

    private enum TestFailure: Error { case record }
}
