#if targetEnvironment(simulator)
    import CubbyKit
    import Foundation
    import ImageIO
    import Photos
    import Testing

    @testable import Cubby

    @MainActor
    @Suite(
        "PhotoKit upload parity", .serialized,
        .enabled(
            if: ProcessInfo.processInfo.environment["CUBBY_PHOTO_PARITY"] == "1",
            "Set CUBBY_PHOTO_PARITY=1 and seed the public simulator fixtures"))
    struct PhotoLibraryParityTests {
        nonisolated struct OriginalFixture: Sendable, CustomTestStringConvertible {
            let filename: String
            let contentType: String
            let width: Int
            let height: Int

            var testDescription: String { filename }
        }

        nonisolated static let originals = [
            OriginalFixture(
                filename: "cubby-parity-landscape-3200x1800.jpg",
                contentType: "image/jpeg", width: 3200, height: 1800),
            OriginalFixture(
                filename: "cubby-parity-oriented-1200x800.jpg",
                contentType: "image/jpeg", width: 800, height: 1200),
            OriginalFixture(
                filename: "cubby-parity-alpha-1024x768.png",
                contentType: "image/png", width: 1024, height: 768),
            OriginalFixture(
                filename: "cubby-parity-heic-2400x1600.heic",
                contentType: "image/heic", width: 2400, height: 1600),
        ]

        @Test("Unedited current renditions preserve every source byte", arguments: originals)
        func uneditedCurrentRenditionPreservesSource(_ fixture: OriginalFixture) async throws {
            try await requireFullPhotoAccess()
            let asset = try asset(named: fixture.filename)
            let sourceData = try Data(contentsOf: fixtureURL(named: fixture.filename))

            let file = try await PhotoLibraryIO.shared.file(for: asset)
            let currentData = try Data(contentsOf: file.url)

            #expect(currentData == sourceData)
            #expect(file.size == sourceData.count)
            #expect(file.contentType == fixture.contentType)
            #expect(file.width == fixture.width)
            #expect(file.height == fixture.height)
        }

        @Test(
            "PhotoKit's 256 px current image hashes like the full-quality current file", arguments: originals)
        func thumbnailHashMatchesFullQualityFile(_ fixture: OriginalFixture) async throws {
            try await requireFullPhotoAccess()
            let asset = try asset(named: fixture.filename)

            let thumbnail = try await PhotoLibraryIO.shared.thumbnail(for: asset, network: true)
            let file = try await PhotoLibraryIO.shared.file(for: asset)
            let thumbnailHash = try PerceptualHash64.compute(thumbnail)
            let uploadHash = try PreparedPhoto.prepare(file: file).perceptualHash

            #expect(thumbnailHash == uploadHash)
        }

        @Test("Orientation, alpha, and dimensions survive the PhotoKit path")
        func imagePropertiesSurvive() async throws {
            try await requireFullPhotoAccess()

            let orientedAsset = try asset(named: "cubby-parity-oriented-1200x800.jpg")
            let orientedFile = try await PhotoLibraryIO.shared.file(for: orientedAsset)
            let orientedImage = try orientedFile.decodeFullResolution()
            #expect(orientedFile.width == 800)
            #expect(orientedFile.height == 1200)
            #expect(orientedImage.width == 800)
            #expect(orientedImage.height == 1200)

            let alphaAsset = try asset(named: "cubby-parity-alpha-1024x768.png")
            let alphaFile = try await PhotoLibraryIO.shared.file(for: alphaAsset)
            let alphaData = try Data(contentsOf: alphaFile.url)
            let alphaSource = try #require(CGImageSourceCreateWithData(alphaData as CFData, nil))
            let alphaImage = try #require(CGImageSourceCreateImageAtIndex(alphaSource, 0, nil))
            #expect(alphaImage.alphaInfo != .none)
            #expect(alphaImage.alphaInfo != .noneSkipFirst)
            #expect(alphaImage.alphaInfo != .noneSkipLast)

            let largeAsset = try asset(named: "cubby-parity-landscape-3200x1800.jpg")
            let largeFile = try await PhotoLibraryIO.shared.file(for: largeAsset)
            let largeImage = try largeFile.decodeFullResolution()
            #expect(max(largeFile.width, largeFile.height) == 3200)
            #expect(max(largeImage.width, largeImage.height) == 3200)
        }

        @Test("A Photos edit is returned and hashed as the current rendition")
        func editedCurrentRenditionHasParity() async throws {
            try await requireFullPhotoAccess()
            let asset = try asset(named: "cubby-parity-edit-source-1440x960.jpg")
            let expectedData = try Data(
                contentsOf: fixtureURL(named: "expected-edit-rendition-1440x960.jpg"))
            let editingInput = try await contentEditingInput(for: asset)
            let output = PHContentEditingOutput(contentEditingInput: editingInput)
            try expectedData.write(to: output.renderedContentURL, options: .atomic)
            output.adjustmentData = PHAdjustmentData(
                formatIdentifier: "com.nickysemenza.cubby.photo-parity",
                formatVersion: "1",
                data: Data("synthetic fixture rendition".utf8))

            let sendableOutput = UncheckedSendableBox(output)
            try await PHPhotoLibrary.shared().performChanges {
                PHAssetChangeRequest(for: asset).contentEditingOutput = sendableOutput.value
            }

            let file = try await PhotoLibraryIO.shared.file(for: asset)
            let currentData = try Data(contentsOf: file.url)
            let thumbnail = try await PhotoLibraryIO.shared.thumbnail(for: asset, network: true)

            #expect(currentData == expectedData)
            #expect(file.width == 1440)
            #expect(file.height == 960)
            #expect(
                try PerceptualHash64.compute(thumbnail)
                    == PreparedPhoto.prepare(file: file).perceptualHash)
        }

        private func requireFullPhotoAccess() async throws {
            var status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
            if status == .notDetermined {
                status = await PHPhotoLibrary.requestAuthorization(for: .readWrite)
            }
            try #require(
                status == .authorized,
                "Grant Photos access before running: xcrun simctl privacy <udid> grant photos com.nickysemenza.cubby"
            )
        }

        private func asset(named filename: String) throws -> PHAsset {
            let options = PHFetchOptions()
            options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
            let assets = PHAsset.fetchAssets(with: .image, options: options)
            var match: PHAsset?
            assets.enumerateObjects { asset, _, stop in
                let ownsFixture = PHAssetResource.assetResources(for: asset).contains {
                    $0.originalFilename == filename
                }
                if ownsFixture {
                    match = asset
                    stop.pointee = true
                }
            }
            return try #require(
                match,
                "Seed \(filename) into the simulator with xcrun simctl addmedia before running this suite")
        }

        private func fixtureURL(named filename: String) throws -> URL {
            let url = Bundle(for: PhotoLibraryParityBundleToken.self).url(
                forResource: URL(fileURLWithPath: filename).deletingPathExtension().lastPathComponent,
                withExtension: URL(fileURLWithPath: filename).pathExtension)
            return try #require(url, "Missing bundled fixture \(filename)")
        }

        private func contentEditingInput(for asset: PHAsset) async throws -> PHContentEditingInput {
            let options = PHContentEditingInputRequestOptions()
            options.isNetworkAccessAllowed = true
            options.canHandleAdjustmentData = { adjustment in
                adjustment.formatIdentifier == "com.nickysemenza.cubby.photo-parity"
            }
            let input: UncheckedSendableBox<PHContentEditingInput> =
                try await withCheckedThrowingContinuation {
                    (continuation: CheckedContinuation<UncheckedSendableBox<PHContentEditingInput>, Error>) in
                    asset.requestContentEditingInput(with: options) { input, info in
                        if let error = info[PHContentEditingInputErrorKey] as? Error {
                            continuation.resume(throwing: error)
                        } else if let input {
                            continuation.resume(returning: UncheckedSendableBox(input))
                        } else {
                            continuation.resume(throwing: PhotoLibraryParityFailure.missingEditingInput)
                        }
                    }
                }
            return input.value
        }
    }

    private final class PhotoLibraryParityBundleToken: NSObject {}

    /// PhotoKit's editing types predate Sendable; the test confines them to its serialized suite.
    nonisolated private struct UncheckedSendableBox<Value>: @unchecked Sendable {
        let value: Value

        init(_ value: Value) {
            self.value = value
        }
    }

    private enum PhotoLibraryParityFailure: Error {
        case missingEditingInput
    }
#endif
