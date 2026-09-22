import Foundation
import Testing

@testable import CubbyKit

/// A plain fixture standing in for `PHAsset` — `LibraryAssetFacts` exists precisely so CubbyKit's
/// tests never need PhotoKit or a real device library.
private struct FixtureFacts: LibraryAssetFacts {
    var localIdentifier: String = "asset-1/L0/001"
    var originalFilename: String? = "IMG_0001.HEIC"
    var creationDate: Date? = Date(timeIntervalSince1970: 1_700_000_000)
    var addedDate: Date? = Date(timeIntervalSince1970: 1_700_000_100)
    var modificationDate: Date? = Date(timeIntervalSince1970: 1_700_000_200)
    var location: LibraryAssetMetadata.Location?
    var sourceType: ImageSightingSourceType = .userLibrary
    var mediaSubtypes: [String] = []
    var hasAdjustments: Bool = false
    var isFavorite: Bool = false
    var pixelWidth: Int = 3024
    var pixelHeight: Int = 4032
    var burstIdentifier: String?
    var camera: LibraryAssetMetadata.Camera?
    var captureTimeZoneOffsetMinutes: Int?
}

@Suite("LibrarySightingBuilder")
struct LibrarySightingBuilderTests {
    @Test func assetKeyPrefersTheCloudIdentifierWhenPresent() {
        let metadata = LibrarySightingBuilder.metadata(
            from: FixtureFacts(), cloudIdentifier: "cloud-abc")
        #expect(metadata.assetKey(installationID: "device-1") == "cloud-abc")
    }

    @Test func assetKeyFallsBackToADeviceScopedLocalKeyWithoutACloudIdentifier() {
        let metadata = LibrarySightingBuilder.metadata(from: FixtureFacts(), cloudIdentifier: nil)
        #expect(metadata.assetKey(installationID: "device-1") == "local:device-1:asset-1/L0/001")
    }

    @Test func reportFieldsCarryEveryFactThroughToTheWireShape() {
        let facts = FixtureFacts(
            location: LibraryAssetMetadata.Location(latitude: 1, longitude: 2),
            mediaSubtypes: ["screenshot", "hdr"],
            camera: LibraryAssetMetadata.Camera(make: "Apple", model: "iPhone 17 Pro"),
            captureTimeZoneOffsetMinutes: 120)
        let metadata = LibrarySightingBuilder.metadata(from: facts, cloudIdentifier: "cloud-1")
        let fields = LibrarySightingBuilder.reportFields(
            for: metadata, installationID: "device-1",
            observedAt: Date(timeIntervalSince1970: 1_700_000_300))

        #expect(fields.assetKey == "cloud-1")
        #expect(fields.cloudIdentifier == "cloud-1")
        #expect(fields.localIdentifier == facts.localIdentifier)
        #expect(fields.sourceType == .userLibrary)
        #expect(fields.mediaSubtypes == ["screenshot", "hdr"])
        #expect(fields.pixelWidth == 3024)
        #expect(fields.pixelHeight == 4032)
        #expect(fields.capturedAt == facts.creationDate)
        #expect(fields.capturedAtOffsetMinutes == 120)
        #expect(fields.addedAt == facts.addedDate)
        #expect(fields.location?.lat == 1)
        #expect(fields.location?.lng == 2)
        #expect(fields.camera?.make == "Apple")
        #expect(fields.camera?.model == "iPhone 17 Pro")
        // The commit path never carries match evidence — that only exists for a library-scan
        // match built via `createInput`.
        #expect(fields.hashDistance == nil)
        #expect(fields.aspectGate == nil)
    }

    @Test func reportFieldsOmitLocationAndCameraWhenNeitherIsKnown() {
        let metadata = LibrarySightingBuilder.metadata(from: FixtureFacts(), cloudIdentifier: nil)
        let fields = LibrarySightingBuilder.reportFields(for: metadata, installationID: "device-1")
        #expect(fields.location == nil)
        #expect(fields.camera == nil)
    }

    @Test func createInputSetsMatchKindToLibraryMatchWithItsEvidence() {
        let metadata = LibrarySightingBuilder.metadata(from: FixtureFacts(), cloudIdentifier: "cloud-1")
        let input = LibrarySightingBuilder.createInput(
            imageId: ImageCode("IMG-0001"), deviceId: "DEV-0001", metadata: metadata,
            installationID: "device-1", hashDistance: 4, aspectGate: true)

        #expect(input.imageId == ImageCode("IMG-0001"))
        #expect(input.deviceId == "DEV-0001")
        #expect(input.ledgerPartyId == nil)
        #expect(input.matchKind == .libraryMatch)
        #expect(input.hashDistance == 4)
        #expect(input.aspectGate == true)
        #expect(input.assetKey == "cloud-1")
    }

    @Test func sourceTypeMapsEachPhotoKitCase() {
        for sourceType: ImageSightingSourceType in [.userLibrary, .cloudShared, .iTunesSynced] {
            let facts = FixtureFacts(sourceType: sourceType)
            let metadata = LibrarySightingBuilder.metadata(from: facts, cloudIdentifier: nil)
            #expect(metadata.sourceType == sourceType)
        }
    }

    @Test func mergingFileEXIFPrefersPhotoKitFactsWhenBothArePresent() {
        let assetLocation = LibraryAssetMetadata.Location(latitude: 1, longitude: 1)
        let fileLocation = LibraryAssetMetadata.Location(latitude: 2, longitude: 2)
        let assetCamera = LibraryAssetMetadata.Camera(make: "PhotoKitMake")
        let fileCamera = LibraryAssetMetadata.Camera(make: "EXIFMake")
        let metadata = LibrarySightingBuilder.metadata(
            from: FixtureFacts(
                location: assetLocation, camera: assetCamera, captureTimeZoneOffsetMinutes: 60),
            cloudIdentifier: nil)

        let merged = metadata.mergingFileEXIF(
            camera: fileCamera, gpsLocation: fileLocation, captureTimeZoneOffsetMinutes: 90)

        #expect(merged.location?.latitude == 1)
        #expect(merged.camera?.make == "PhotoKitMake")
        #expect(merged.captureTimeZoneOffsetMinutes == 60)
    }

    @Test func mergingFileEXIFFillsGapsWhenPhotoKitHasNothing() {
        let fileLocation = LibraryAssetMetadata.Location(latitude: 2, longitude: 2)
        let fileCamera = LibraryAssetMetadata.Camera(make: "EXIFMake")
        let metadata = LibrarySightingBuilder.metadata(from: FixtureFacts(), cloudIdentifier: nil)

        let merged = metadata.mergingFileEXIF(
            camera: fileCamera, gpsLocation: fileLocation, captureTimeZoneOffsetMinutes: 90)

        #expect(merged.location?.latitude == 2)
        #expect(merged.camera?.make == "EXIFMake")
        #expect(merged.captureTimeZoneOffsetMinutes == 90)
    }
}
