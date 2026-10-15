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

@Suite("Photo match diagnostics")
struct PhotoMatchDiagnosticsTests {
    @Test func evaluatorUsesSourceRatioAndProductionDimensions() {
        let base = PerceptualHash64(value: 0)
        let close = PerceptualHash64(value: 0b111)
        let entry = ImageHashEntry(
            id: ImageCode("IMG-OWNER"), perceptualHash: close,
            sourceFingerprint: SourceFingerprint(hash: close, aspectRatio: 2), width: 100, height: 100,
            directOwnerShortcodes: ["PRJ-FIXTURE"])
        let inputs = PhotoMatchDiagnosticReport.Inputs(
            file: .init(actualHash: base, width: 200, height: 100),
            thumbnail: .init(
                actualHash: base, width: 64, height: 64, originalWidth: 200, originalHeight: 100),
            materialized: .init(
                actualHash: base, width: 64, height: 64, originalWidth: 200, originalHeight: 100))
        let report = PhotoMatchDiagnostics.evaluate(
            .init(
                initial: .init(state: "fixture"), inputs: inputs, loadedServerEntries: [entry],
                expectedOwnerShortcode: "PRJ-FIXTURE"))

        let evaluation = report.entries.first
        #expect(evaluation?.selectedBecauseExpectedOwner == true)
        #expect(evaluation?.thumbnailToContent?.verdict.confidence == .possible)
        #expect(evaluation?.thumbnailToSource?.verdict.confidence == .strong)
    }

    @Test func verdictParityPreservesMissingDimensionAndDistanceTiers() {
        #expect(
            PhotoMatchVerdict.evaluate(distance: 3, leftAspectRatio: nil, rightAspectRatio: 2)
                == .init(confidence: .possible, reason: .missingAspectRatio))
        #expect(
            PhotoMatchVerdict.evaluate(distance: 7, leftAspectRatio: 2, rightAspectRatio: 2)
                == .init(confidence: .rejected, reason: .distanceTooLarge))
    }

    @Test(arguments: [0, 2, 3, 6, 7, 64], [Optional<Int>.none, 100, 150, 200])
    func diagnosticVerdictsMatchProduction(distance: Int, width: Int?) throws {
        let hash = PerceptualHash64(value: distance == 64 ? .max : (UInt64(1) << distance) - 1)
        let entry = ImageHashEntry(
            id: ImageCode("IMG-2345"), perceptualHash: hash,
            width: width, height: 100, directOwnerShortcodes: ["PRD-2345"])
        let query = HashQuery(perceptualHash: .init(value: 0), aspectRatio: 1.5)
        let input = PhotoMatchDiagnosticReport.HashInput(
            actualHash: query.perceptualHash, width: 150, height: 100)
        let report = PhotoMatchDiagnostics.report(
            initial: .init(state: "unchecked", registeredQuery: query),
            inputs: .init(file: input, thumbnail: input, materialized: input),
            loadedServerEntries: [entry], expectedOwnerShortcode: "PRD-2345")
        let evaluation = try #require(report.entries.first)
        let candidate = try HashIndex(entries: [entry]).candidates(for: query).first
        #expect(evaluation.thumbnailToContent?.distance == distance)
        #expect(evaluation.thumbnailToContent?.verdict.candidateConfidence == candidate?.confidence)
        #expect(evaluation.registeredQueryToContent?.verdict == evaluation.thumbnailToContent?.verdict)
        #expect(evaluation.thumbnailToSource == nil)
        #expect(evaluation.materializedToSource == nil)
        #expect(report.thumbnailToMaterializedDistance == 0)
    }

    @Test func freshIndexNeverOverwritesLoadedEvidenceAndExpectedOwnerIncludesRejectedMatches() throws {
        let loaded = ImageHashEntry(
            id: ImageCode("IMG-2345"), perceptualHash: .init(value: .max), width: 100, height: 100)
        let fresh = ImageHashEntry(
            id: loaded.id, perceptualHash: .init(value: 0), width: 100, height: 100,
            directOwnerShortcodes: ["GDE-2345"])
        let far = ImageHashEntry(
            id: ImageCode("IMG-6789"), perceptualHash: .init(value: .max),
            directOwnerShortcodes: ["GDE-2345"])
        let input = PhotoMatchDiagnosticReport.HashInput(actualHash: .init(value: 0), width: 100, height: 100)
        let issue = PhotoMatchDiagnosticReport.Issue(stage: .cacheRead, message: "Synthetic cache failure")
        let report = PhotoMatchDiagnostics.report(
            initial: .init(state: "unchecked"),
            inputs: .init(file: input, thumbnail: input, materialized: input),
            loadedServerEntries: [loaded, far],
            freshServerIndex: .init(status: .success, algorithmRevision: 1, entries: [fresh]),
            expectedOwnerShortcode: " gde-2345 ", issues: [issue])
        #expect(report.loadedServerEntries == [loaded, far])
        #expect(report.entries.map(\.entry.id) == [loaded.id, far.id, fresh.id])
        #expect(report.entries.map(\.indexSource) == [.loaded, .loaded, .fresh])
        #expect(
            report.entries.map { $0.thumbnailToContent?.verdict.confidence } == [
                .rejected, .rejected, .strong,
            ])
        #expect(report.entries.allSatisfy { $0.selectedBecauseExpectedOwner })
        #expect(report.issues.map(\.message) == [issue.message])
        let decoded = try JSONDecoder().decode(
            PhotoMatchDiagnosticReport.self, from: JSONEncoder().encode(report))
        #expect(decoded.entries.map(\.entry) == report.entries.map(\.entry))
    }

    @Test func materializedMatchesAreIncludedWhenThumbnailIsUnavailable() {
        let entry = ImageHashEntry(
            id: ImageCode("IMG-2345"), sourceFingerprint: .init(hash: .init(value: 0), aspectRatio: 2))
        let empty = PhotoMatchDiagnosticReport.HashInput(actualHash: nil, width: nil, height: nil)
        let input = PhotoMatchDiagnosticReport.HashInput(actualHash: .init(value: 7), width: 200, height: 100)
        let report = PhotoMatchDiagnostics.report(
            initial: .init(state: "unavailable"),
            inputs: .init(file: input, thumbnail: empty, materialized: input),
            loadedServerEntries: [entry])
        #expect(report.entries.first?.materializedToSource?.verdict.confidence == .strong)
        #expect(report.entries.first?.thumbnailToSource == nil)
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
