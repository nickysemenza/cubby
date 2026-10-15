import CoreGraphics
import Foundation
import ImageIO
import Testing
import UniformTypeIdentifiers

@testable import CubbyKit

/// Writes a small JPEG fixture with real EXIF/TIFF/GPS metadata, so `PhotoFile`'s EXIF read is
/// exercised against actual ImageIO-decoded bytes rather than a hand-built properties dictionary.
private enum EXIFFixture {
    static func write(
        cameraMake: String? = nil,
        cameraModel: String? = nil,
        lensModel: String? = nil,
        software: String? = nil,
        offsetTimeOriginal: String? = nil,
        dateTimeOriginal: String? = nil,
        gpsLatitude: Double? = nil,
        gpsLatitudeRef: String? = nil,
        gpsLongitude: Double? = nil,
        gpsLongitudeRef: String? = nil,
        gpsAltitude: Double? = nil,
        gpsAltitudeRef: Int? = nil,
        gpsHPositioningError: Double? = nil
    ) throws -> URL {
        let image = TestImages.canvas(width: 32, height: 24, subject: false)
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let url = directory.appendingPathComponent("exif-fixture.jpg")
        guard
            let destination = CGImageDestinationCreateWithURL(
                url as CFURL, UTType.jpeg.identifier as CFString, 1, nil)
        else { throw TestFailure.destinationFailed }

        var tiff: [CFString: Any] = [:]
        if let cameraMake { tiff[kCGImagePropertyTIFFMake] = cameraMake }
        if let cameraModel { tiff[kCGImagePropertyTIFFModel] = cameraModel }
        if let software { tiff[kCGImagePropertyTIFFSoftware] = software }

        var exif: [CFString: Any] = [:]
        if let lensModel { exif[kCGImagePropertyExifLensModel] = lensModel }
        if let offsetTimeOriginal { exif[kCGImagePropertyExifOffsetTimeOriginal] = offsetTimeOriginal }
        if let dateTimeOriginal { exif[kCGImagePropertyExifDateTimeOriginal] = dateTimeOriginal }

        var gps: [CFString: Any] = [:]
        if let gpsLatitude { gps[kCGImagePropertyGPSLatitude] = gpsLatitude }
        if let gpsLatitudeRef { gps[kCGImagePropertyGPSLatitudeRef] = gpsLatitudeRef }
        if let gpsLongitude { gps[kCGImagePropertyGPSLongitude] = gpsLongitude }
        if let gpsLongitudeRef { gps[kCGImagePropertyGPSLongitudeRef] = gpsLongitudeRef }
        if let gpsAltitude { gps[kCGImagePropertyGPSAltitude] = gpsAltitude }
        if let gpsAltitudeRef { gps[kCGImagePropertyGPSAltitudeRef] = gpsAltitudeRef }
        if let gpsHPositioningError { gps[kCGImagePropertyGPSHPositioningError] = gpsHPositioningError }

        var properties: [CFString: Any] = [:]
        if !tiff.isEmpty { properties[kCGImagePropertyTIFFDictionary] = tiff }
        if !exif.isEmpty { properties[kCGImagePropertyExifDictionary] = exif }
        if !gps.isEmpty { properties[kCGImagePropertyGPSDictionary] = gps }

        CGImageDestinationAddImage(destination, image, properties as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { throw TestFailure.finalizeFailed }
        return url
    }

    enum TestFailure: Error { case destinationFailed, finalizeFailed }
}

@Suite("PhotoFile EXIF")
struct PhotoFileEXIFTests {
    @Test func readsCameraMakeModelLensAndSoftware() throws {
        let url = try EXIFFixture.write(
            cameraMake: "Apple", cameraModel: "iPhone 17 Pro", lensModel: "iPhone 17 Pro back triple camera",
            software: "26.0")
        let file = try PhotoFile.importing(url)
        let camera = try #require(file.camera)
        #expect(camera.make == "Apple")
        #expect(camera.model == "iPhone 17 Pro")
        #expect(camera.lens == "iPhone 17 Pro back triple camera")
        #expect(camera.software == "26.0")
    }

    @Test func noCameraFieldsMeansNilNotAnEmptyStruct() throws {
        let url = try EXIFFixture.write()
        let file = try PhotoFile.importing(url)
        #expect(file.camera == nil)
    }

    @Test func readsGPSLocationApplyingHemisphereSigns() throws {
        let url = try EXIFFixture.write(
            gpsLatitude: 37.3349, gpsLatitudeRef: "S", gpsLongitude: 122.0090, gpsLongitudeRef: "W",
            gpsAltitude: 50, gpsAltitudeRef: 0, gpsHPositioningError: 5)
        let file = try PhotoFile.importing(url)
        let location = try #require(file.gpsLocation)
        #expect(location.latitude == -37.3349)
        #expect(location.longitude == -122.0090)
        #expect(location.altitude == 50)
        #expect(location.horizontalAccuracy == 5)
    }

    @Test func belowSeaLevelAltitudeRefNegatesTheAltitude() throws {
        let url = try EXIFFixture.write(
            gpsLatitude: 10, gpsLatitudeRef: "N", gpsLongitude: 10, gpsLongitudeRef: "E",
            gpsAltitude: 5, gpsAltitudeRef: 1)
        let file = try PhotoFile.importing(url)
        let location = try #require(file.gpsLocation)
        #expect(location.altitude == -5)
    }

    @Test func noGPSDictionaryMeansNilLocation() throws {
        let url = try EXIFFixture.write()
        let file = try PhotoFile.importing(url)
        #expect(file.gpsLocation == nil)
    }

    @Test func readsThePunctuatedOffsetAsMinutesEastOfUTC() throws {
        let url = try EXIFFixture.write(
            offsetTimeOriginal: "+02:00", dateTimeOriginal: "2026:09:20 15:04:00")
        let file = try PhotoFile.importing(url)
        #expect(file.captureTimeZoneOffsetMinutes == 120)
    }

    @Test func negativeOffsetIsNegativeMinutes() throws {
        let url = try EXIFFixture.write(
            offsetTimeOriginal: "-05:30", dateTimeOriginal: "2026:09:20 15:04:00")
        let file = try PhotoFile.importing(url)
        #expect(file.captureTimeZoneOffsetMinutes == -330)
    }

    // An unpunctuated offset ("+0900") is deliberately still handled by
    // `captureTimeZoneOffsetMinutes(from:)` (mirroring the pre-existing `captureDate(from:)`
    // leniency), but real Exif `OffsetTimeOriginal` is a fixed 7-byte ASCII field
    // (`"+HH:MM\0"`) — ImageIO's writer silently drops a differently-shaped string when
    // finalizing the fixture, so that branch cannot be exercised through this JPEG round trip
    // and is intentionally left uncovered here rather than asserted against a fixture that
    // cannot produce it.

    @Test func noOffsetFieldMeansNilNotZero() throws {
        let url = try EXIFFixture.write(dateTimeOriginal: "2026:09:20 15:04:00")
        let file = try PhotoFile.importing(url)
        #expect(file.captureTimeZoneOffsetMinutes == nil)
    }
}
