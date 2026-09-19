import CoreGraphics
import Foundation
import ImageIO
import Testing
import UniformTypeIdentifiers

@testable import CubbyKit

@Suite("PerceptualHash64")
struct PerceptualHashTests {
    @Test func validatesHexAndCountsXORBits() throws {
        let left = try PerceptualHash64(hex: "000000000000000f")
        let right = try PerceptualHash64(hex: "00000000000000f0")
        #expect(left.hex == "000000000000000f")
        #expect(left.distance(to: right) == 8)
        #expect(throws: PerceptualHash64.Failure.invalidHex) {
            _ = try PerceptualHash64(hex: "abc")
        }
        #expect(throws: PerceptualHash64.Failure.invalidHex) {
            _ = try PerceptualHash64(hex: "000000000000000z")
        }
    }

    @Test func syntheticImageHasStableGoldenHash() throws {
        let context = CGContext(
            data: nil, width: 64, height: 64, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpace(name: CGColorSpace.sRGB)!,
            bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
        context.setFillColor(CGColor(gray: 1, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: 64, height: 64))
        context.setFillColor(CGColor(gray: 0, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: 32, height: 64))
        let image = context.makeImage()!
        #expect(try PerceptualHash64.compute(image).hex == "9321ec87c5b3b946")
    }

    @Test func transparentPixelsCompositeOverWhite() throws {
        let transparent = CGContext(
            data: nil, width: 40, height: 40, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpace(name: CGColorSpace.sRGB)!,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        transparent.clear(CGRect(x: 0, y: 0, width: 40, height: 40))

        let white = CGContext(
            data: nil, width: 40, height: 40, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpace(name: CGColorSpace.sRGB)!,
            bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
        white.setFillColor(CGColor(gray: 1, alpha: 1))
        white.fill(CGRect(x: 0, y: 0, width: 40, height: 40))

        #expect(
            try PerceptualHash64.compute(transparent.makeImage()!)
                == PerceptualHash64.compute(white.makeImage()!))
    }
}

@Suite("HashIndex")
struct HashIndexTests {
    @Test func appliesDistanceAndSymmetricRatioTiers() throws {
        let base = PerceptualHash64(value: 0)
        let near = PerceptualHash64(value: 0b111)
        let far = PerceptualHash64(value: 0b111_1111)
        let entries = [
            ImageHashEntry(
                id: ImageCode("IMG-CONTENT"), perceptualHash: near, width: 1000, height: 502),
            ImageHashEntry(
                id: ImageCode("IMG-POSSIBLE"), perceptualHash: near, width: 1000, height: 600),
            ImageHashEntry(
                id: ImageCode("IMG-SOURCE"),
                sourceFingerprint: SourceFingerprint(hash: base, aspectRatio: 0.5)),
            ImageHashEntry(id: ImageCode("IMG-FAR"), perceptualHash: far, width: 1000, height: 500),
        ]
        let index = try HashIndex(entries: entries)
        let candidates = index.candidates(
            for: HashQuery(
                perceptualHash: base,
                aspectRatio: 0.5,
                sourceFingerprint: SourceFingerprint(hash: base, aspectRatio: 2)))

        #expect(
            candidates.contains {
                $0.id == ImageCode("IMG-CONTENT") && $0.basis == .content
                    && $0.confidence == .strong && $0.distance == 3
            })
        #expect(
            candidates.contains {
                $0.id == ImageCode("IMG-POSSIBLE") && $0.confidence == .possible
            })
        #expect(
            candidates.contains {
                $0.id == ImageCode("IMG-SOURCE") && $0.basis == .source
                    && $0.confidence == .strong
            })
        #expect(!candidates.contains { $0.id == ImageCode("IMG-FAR") })
    }

    @Test func rejectsUnknownRevision() {
        #expect(throws: HashIndex.Failure.unsupportedRevision(2)) {
            _ = try HashIndex(entries: [], algorithmRevision: 2)
        }
    }

    @Test func comparesEditedSourcesAcrossStoredContentAndSourceFields() throws {
        let original = PerceptualHash64(value: 0)
        let edit = PerceptualHash64(value: 0xff00)
        let index = try HashIndex(entries: [
            ImageHashEntry(
                id: ImageCode("IMG-ORIGINAL"), perceptualHash: original, width: 600, height: 400),
            ImageHashEntry(
                id: ImageCode("IMG-EDIT"), perceptualHash: edit,
                sourceFingerprint: SourceFingerprint(hash: original, aspectRatio: 1.5),
                width: 600, height: 400),
        ])

        let editedQuery = HashQuery(
            perceptualHash: edit, aspectRatio: 1.5,
            sourceFingerprint: SourceFingerprint(hash: original, aspectRatio: 1.5))
        let editedMatches = index.candidates(for: editedQuery)
        #expect(
            editedMatches.contains {
                $0.id == ImageCode("IMG-ORIGINAL") && $0.basis == .content && $0.distance == 0
            })

        let originalQuery = HashQuery(
            perceptualHash: original, aspectRatio: 1.5,
            sourceFingerprint: SourceFingerprint(hash: original, aspectRatio: 1.5))
        let originalMatches = index.candidates(for: originalQuery)
        #expect(
            originalMatches.contains {
                $0.id == ImageCode("IMG-EDIT") && $0.basis == .source && $0.distance == 0
            })
    }

    @Test func exactContentMatchSortsAheadOfSourceEvidenceForTheSameImage() throws {
        let hash = PerceptualHash64(value: 42)
        let fingerprint = SourceFingerprint(hash: hash, aspectRatio: 1.5)
        let index = try HashIndex(entries: [
            ImageHashEntry(
                id: ImageCode("IMG-BOTH"), perceptualHash: hash,
                sourceFingerprint: fingerprint, width: 600, height: 400)
        ])

        let matches = index.candidates(
            for: HashQuery(
                perceptualHash: hash, aspectRatio: 1.5, sourceFingerprint: fingerprint))
        #expect(matches.first?.basis == .content)
    }
}

@Suite("PhotoFile")
struct PhotoFileTests {
    @Test func materializationPreservesBytesAndMetadata() throws {
        let bytes = try ImageEncoding.encode(
            TestImages.canvas(width: 321, height: 123, subject: true), as: .png)
        let photo = try PhotoFile.materialize(
            bytes, filename: "original.png", contentType: "image/png")
        #expect(try Data(contentsOf: photo.url) == bytes)
        #expect(photo.contentType == "image/png")
        #expect(photo.size == bytes.count)
        #expect(photo.width == 321)
        #expect(photo.height == 123)
        let thumbnail = try photo.thumbnail()
        #expect(thumbnail.width <= 256)
        #expect(thumbnail.height <= 256)
    }

    @Test func temporaryMaterializationLivesUntilItsLastValueCopy() throws {
        let bytes = try ImageEncoding.encode(
            TestImages.canvas(width: 64, height: 48, subject: true), as: .jpeg)
        var copies: [PhotoFile] = try {
            let file = try PhotoFile.materialize(
                bytes, filename: "leased.jpg", contentType: "image/jpeg")
            return [file, file]
        }()
        let url = try #require(copies.first?.url)

        copies.removeLast()
        #expect(FileManager.default.fileExists(atPath: url.path(percentEncoded: false)))
        copies.removeAll()
        #expect(!FileManager.default.fileExists(atPath: url.path(percentEncoded: false)))
    }

    @Test func importedSourceRemainsAfterPhotoFileValuesAreReleased() throws {
        let bytes = try ImageEncoding.encode(
            TestImages.canvas(width: 72, height: 41, subject: true), as: .png)
        let sourceURL = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString + "-owned-by-caller.png")
        try bytes.write(to: sourceURL, options: .atomic)
        defer { try? FileManager.default.removeItem(at: sourceURL) }

        var values = [try PhotoFile.importing(sourceURL)]
        values.removeAll()

        #expect(FileManager.default.fileExists(atPath: sourceURL.path(percentEncoded: false)))
        #expect(try Data(contentsOf: sourceURL) == bytes)
    }

    @Test func rejectsFilesOverFiftyMiBBeforeIO() {
        #expect(
            throws: PhotoFile.Failure.tooLarge(
                actual: PhotoFile.maximumByteCount + 1, maximum: PhotoFile.maximumByteCount)
        ) {
            _ = try PhotoFile(
                url: URL(fileURLWithPath: "/tmp/oversize.jpg"),
                filename: "oversize.jpg",
                contentType: "image/jpeg",
                size: PhotoFile.maximumByteCount + 1,
                width: 1,
                height: 1)
        }
    }

    @Test func readsExifCaptureDate() throws {
        let image = TestImages.canvas(width: 80, height: 40, subject: true)
        let data = NSMutableData()
        let destination = try #require(
            CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil))
        let properties: [CFString: Any] = [
            kCGImagePropertyExifDictionary: [
                kCGImagePropertyExifDateTimeOriginal: "2024:03:02 01:02:03",
                kCGImagePropertyExifOffsetTimeOriginal: "+02:30",
            ]
        ]
        CGImageDestinationAddImage(destination, image, properties as CFDictionary)
        #expect(CGImageDestinationFinalize(destination))
        let photo = try PhotoFile.materialize(
            data as Data, filename: "dated.jpg", contentType: "image/jpeg")
        #expect(photo.capturedAt == Date(timeIntervalSince1970: 1_709_332_323))
    }

    @Test func fullResolutionDecodeAppliesExifOrientation() throws {
        let image = TestImages.canvas(width: 80, height: 40, subject: true)
        let data = NSMutableData()
        let destination = try #require(
            CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil))
        CGImageDestinationAddImage(
            destination, image, [kCGImagePropertyOrientation: 6] as CFDictionary)
        #expect(CGImageDestinationFinalize(destination))
        let photo = try PhotoFile.materialize(
            data: data as Data, filename: "portrait.jpg", contentType: "image/jpeg")

        #expect(photo.width == 40)
        #expect(photo.height == 80)
        let decoded = try photo.decodeFullResolution()
        #expect(decoded.width == 40)
        #expect(decoded.height == 80)
    }

    @Test func fileAndPreviewHashPipelinesAreIdentical() throws {
        let bytes = try ImageEncoding.encode(
            TestImages.canvas(width: 1200, height: 803, subject: true), as: .jpeg)
        let file = try PhotoFile.materialize(
            data: bytes, filename: "pipeline.jpg", contentType: "image/jpeg")
        let prepared = try PreparedPhoto.prepare(file: file)
        let previewHash = try PerceptualHash64.compute(file.thumbnail())

        #expect(prepared.perceptualHash == previewHash)
        #expect(prepared.hashQuery.perceptualHash == previewHash)
        #expect(prepared.hashQuery.aspectRatio == file.aspectRatio)
        #expect(prepared.hashQuery.sourceFingerprint == prepared.sourceFingerprint)
    }

    @Test func detectedContainerTypeWinsOverAStaleDeclaredType() throws {
        let bytes = try ImageEncoding.encode(
            TestImages.canvas(width: 91, height: 47, subject: true), as: .png)
        let file = try PhotoFile.materialize(
            data: bytes, filename: "mistyped.jpg", contentType: "image/jpeg")

        #expect(file.contentType == "image/png")
        #expect(try Data(contentsOf: file.url) == bytes)
    }
}
