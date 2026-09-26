import CoreGraphics
import CryptoKit
import Foundation
import ImageIO
import Testing

@testable import CubbyKit

@Suite("Companion image processor")
struct CompanionImageProcessorTests {
    @Test("Uploads a transparent PNG derived from an unchanged source", .requiresVisionHardware)
    func uploadsTransparentPNGFromUnchangedSource() async throws {
        let sourceBytes = try ImageEncoding.encode(
            TestImages.canvas(width: 600, height: 600, subject: true), as: .png)
        let fixtureURL = FileManager.default.temporaryDirectory.appendingPathComponent(
            "\(UUID().uuidString).png")
        try sourceBytes.write(to: fixtureURL, options: .atomic)
        defer { try? FileManager.default.removeItem(at: fixtureURL) }
        let sourceURL = URL(string: "https://images.example.invalid/original.png")!
        let uploadURL = URL(string: "https://uploads.example.invalid/cutout.png")!
        let upload = UploadProbe()
        let processor = CompanionImageProcessor(
            download: { requestedURL in
                guard requestedURL == sourceURL else { throw URLError(.badURL) }
                return try Data(contentsOf: fixtureURL)
            },
            put: { data, url, contentType in
                await upload.record(data, url: url, contentType: contentType)
            })

        let result = try await processor.makeTransparentCutout(
            source: CompanionImageSource(
                url: sourceURL, sha256: Self.sha256(sourceBytes), contentType: "image/png"),
            output: CompanionImageOutput(uploadURL: uploadURL, contentType: "image/png"))

        guard case .completed(let artifact) = result else {
            Issue.record("Expected Vision to lift the generated foreground subject")
            return
        }
        let captured = try #require(await upload.latest)
        #expect(captured.url == uploadURL)
        #expect(captured.contentType == "image/png")
        #expect(captured.data.prefix(4) == Data([0x89, 0x50, 0x4E, 0x47]))
        #expect(captured.data != sourceBytes)
        #expect(artifact.sha256 == Self.sha256(captured.data))
        #expect(artifact.contentType == "image/png")
        let pixelSize = try #require(ImageEncoding.pixelSize(of: captured.data))
        #expect(pixelSize.width == artifact.width)
        #expect(pixelSize.height == artifact.height)
        #expect(artifact.diagnostics.decodeMilliseconds != nil)
        #expect(artifact.diagnostics.processingMilliseconds != nil)
        #expect(artifact.diagnostics.uploadMilliseconds != nil)
        #expect(artifact.diagnostics.width == artifact.width)
        #expect(artifact.diagnostics.height == artifact.height)
        let imageSource = try #require(CGImageSourceCreateWithData(captured.data as CFData, nil))
        let uploadedImage = try #require(CGImageSourceCreateImageAtIndex(imageSource, 0, nil))
        #expect(
            uploadedImage.alphaInfo != .none && uploadedImage.alphaInfo != .noneSkipFirst
                && uploadedImage.alphaInfo != .noneSkipLast)
        #expect(Self.containsTransparentPixel(uploadedImage))
        #expect(try Data(contentsOf: fixtureURL) == sourceBytes)
    }

    // Regression: full-resolution lifts from 48 MP photos exceeded the server's 64 MB decode
    // limit and every such cutout failed.
    @Test("Caps the uploaded cutout's longer side", .requiresVisionHardware)
    func capsCutoutPixelSize() async throws {
        let sourceBytes = try ImageEncoding.encode(
            TestImages.canvas(width: 5000, height: 5000, subject: true), as: .png)
        let upload = UploadProbe()
        let processor = CompanionImageProcessor(
            download: { _ in sourceBytes },
            put: { data, url, contentType in
                await upload.record(data, url: url, contentType: contentType)
            })

        let result = try await processor.makeTransparentCutout(
            source: CompanionImageSource(
                url: URL(string: "https://images.example.invalid/large.png")!,
                sha256: Self.sha256(sourceBytes), contentType: "image/png"),
            output: CompanionImageOutput(
                uploadURL: URL(string: "https://uploads.example.invalid/cutout.png")!,
                contentType: "image/png"))

        guard case .completed(let artifact) = result else {
            Issue.record("Expected Vision to lift the generated foreground subject")
            return
        }
        let captured = try #require(await upload.latest)
        let pixelSize = try #require(ImageEncoding.pixelSize(of: captured.data))
        #expect(max(pixelSize.width, pixelSize.height) == CompanionImageProcessor.maximumCutoutPixelSize)
        #expect(pixelSize.width == artifact.width)
        #expect(pixelSize.height == artifact.height)
    }

    @Test("Retains an already transparent original without uploading another cutout")
    func transparentOriginalDoesNotUpload() async throws {
        let context = try #require(
            CGContext(
                data: nil, width: 16, height: 16, bitsPerComponent: 8, bytesPerRow: 64,
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        context.clear(CGRect(x: 0, y: 0, width: 16, height: 16))
        context.setFillColor(CGColor(red: 1, green: 0, blue: 0, alpha: 1))
        context.fill(CGRect(x: 4, y: 4, width: 8, height: 8))
        let bytes = try ImageEncoding.encode(#require(context.makeImage()), as: .png)
        let upload = UploadProbe()
        let processor = CompanionImageProcessor(
            download: { _ in bytes },
            put: { data, url, contentType in await upload.record(data, url: url, contentType: contentType) })
        let result = try await processor.makeTransparentCutout(
            source: CompanionImageSource(
                url: URL(string: "https://images.example.invalid/transparent.png")!,
                sha256: Self.sha256(bytes), contentType: "image/png"),
            output: CompanionImageOutput(
                uploadURL: URL(string: "https://uploads.example.invalid/cutout.png")!,
                contentType: "image/png"))
        #expect(result == .alreadyTransparent)
        #expect(await upload.count == 0)
    }

    @Test("Returns no subject without uploading a uniform canvas")
    func uniformCanvasDoesNotUpload() async throws {
        let sourceBytes = try ImageEncoding.encode(
            TestImages.canvas(width: 400, height: 300, subject: false), as: .png)
        let upload = UploadProbe()
        let processor = CompanionImageProcessor(
            download: { _ in sourceBytes },
            put: { data, url, contentType in
                await upload.record(data, url: url, contentType: contentType)
            })

        let result = try await processor.makeTransparentCutout(
            source: CompanionImageSource(
                url: URL(string: "https://images.example.invalid/uniform.png")!,
                sha256: Self.sha256(sourceBytes), contentType: "image/png"),
            output: CompanionImageOutput(
                uploadURL: URL(string: "https://uploads.example.invalid/cutout.png")!,
                contentType: "image/png"))

        #expect(result == .noSubject)
        #expect(await upload.count == 0)
    }

    @Test(
        "Applies orientation when decoding JPEG and HEIC originals",
        arguments: [
            ("public.jpeg", "image/jpeg", "jpg"),
            ("public.heic", "image/heic", "heic"),
        ])
    func appliesExifOrientation(type: String, contentType: String, fileExtension: String) async throws {
        let rawImage = TestImages.canvas(width: 80, height: 40, subject: true)
        let sourceBytes = try Self.encoded(rawImage, type: type, orientation: 6)
        let upload = UploadProbe()
        let processor = CompanionImageProcessor(
            download: { _ in sourceBytes },
            put: { data, url, contentType in
                await upload.record(data, url: url, contentType: contentType)
            })

        let decoded = try await processor.decodedSourceImage(
            CompanionImageSource(
                url: URL(string: "https://images.example.invalid/oriented.\(fileExtension)")!,
                sha256: Self.sha256(sourceBytes), contentType: contentType))

        #expect(decoded.image.width == 40)
        #expect(decoded.image.height == 80)
        #expect(decoded.diagnostics.orientation == 6)
        #expect(decoded.diagnostics.width == 40)
        #expect(decoded.diagnostics.height == 80)
        #expect(await upload.count == 0)
    }

    @Test("Rejects changed source bytes before decoding or upload")
    func rejectsChecksumMismatch() async throws {
        let bytes = Data("not the expected image".utf8)
        let upload = UploadProbe()
        let processor = CompanionImageProcessor(
            download: { _ in bytes },
            put: { data, url, contentType in
                await upload.record(data, url: url, contentType: contentType)
            })
        let source = CompanionImageSource(
            url: URL(string: "https://images.example.invalid/original.heic")!,
            sha256: String(repeating: "0", count: 64), contentType: "image/heic")
        let output = CompanionImageOutput(
            uploadURL: URL(string: "https://uploads.example.invalid/variant.png")!,
            contentType: "image/png")

        await #expect(throws: CompanionImageProcessor.Failure.sourceChecksumMismatch) {
            try await processor.makeTransparentCutout(source: source, output: output)
        }
        #expect(await upload.count == 0)
    }

    @Test("Rejects a non-PNG derivative before downloading")
    func rejectsNonPNGOutput() async throws {
        let download = DownloadProbe()
        let processor = CompanionImageProcessor(
            download: { url in try await download.fetch(url) },
            put: { _, _, _ in })
        let source = CompanionImageSource(
            url: URL(string: "https://images.example.invalid/original.jpg")!,
            sha256: Self.sha256(Data()), contentType: "image/jpeg")
        let output = CompanionImageOutput(
            uploadURL: URL(string: "https://uploads.example.invalid/variant.jpg")!,
            contentType: "image/jpeg")

        await #expect(
            throws: CompanionImageProcessor.Failure.unsupportedOutputContentType("image/jpeg")
        ) {
            try await processor.makeTransparentCutout(source: source, output: output)
        }
        #expect(await download.count == 0)
    }

    private static func sha256(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    private static func encoded(_ image: CGImage, type: String, orientation: Int) throws -> Data {
        let data = NSMutableData()
        let destination = try #require(
            CGImageDestinationCreateWithData(
                data, type as CFString, 1, nil))
        CGImageDestinationAddImage(
            destination, image, [kCGImagePropertyOrientation: orientation] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else {
            throw ImageEncoding.Failure.cannotEncode
        }
        return data as Data
    }

    private static func containsTransparentPixel(_ image: CGImage) -> Bool {
        var pixels = [UInt8](repeating: 0, count: image.width * image.height * 4)
        return pixels.withUnsafeMutableBytes { buffer in
            guard
                let context = CGContext(
                    data: buffer.baseAddress, width: image.width, height: image.height,
                    bitsPerComponent: 8, bytesPerRow: image.width * 4,
                    space: CGColorSpace(name: CGColorSpace.sRGB)!,
                    bitmapInfo: CGBitmapInfo.byteOrder32Big.rawValue
                        | CGImageAlphaInfo.premultipliedLast.rawValue)
            else { return false }
            context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
            let bytes = buffer.bindMemory(to: UInt8.self)
            return stride(from: 3, to: bytes.count, by: 4).contains { bytes[$0] < 255 }
        }
    }
}

@Suite("Companion result outbox")
struct CompanionResultOutboxTests {
    private struct PendingResult: Codable, Sendable, Equatable {
        let value: String
    }

    @Test("Persists results until the matching acknowledgement")
    func persistsUntilAcknowledged() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
            UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("outbox.json")
        let first = CompanionResultOutbox<PendingResult>(fileURL: url)

        try await first.record(PendingResult(value: "finished"), for: "job:attempt")

        let restored = CompanionResultOutbox<PendingResult>(fileURL: url)
        #expect(try await restored.result(for: "job:attempt") == PendingResult(value: "finished"))
        try await restored.acknowledge("job:attempt")
        #expect(try await restored.pending().isEmpty)
    }

    @Test("Retries loading after a replay file decode failure")
    func retriesAfterDecodeFailure() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
            UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("outbox.json")
        try Data("invalid".utf8).write(to: url)
        let outbox = CompanionResultOutbox<PendingResult>(fileURL: url)

        await #expect(throws: DecodingError.self) {
            _ = try await outbox.pending()
        }
        try JSONEncoder.companionImageProcessing.encode([
            "job:attempt": PendingResult(value: "finished")
        ]).write(to: url, options: .atomic)

        #expect(try await outbox.result(for: "job:attempt") == PendingResult(value: "finished"))
    }
}

private actor UploadProbe {
    struct Entry: Sendable {
        let data: Data
        let url: URL
        let contentType: String
    }

    private var uploads: [Entry] = []

    var count: Int { uploads.count }
    var latest: Entry? { uploads.last }

    func record(_ data: Data, url: URL, contentType: String) {
        uploads.append(Entry(data: data, url: url, contentType: contentType))
    }
}

private actor DownloadProbe {
    private(set) var count = 0

    func fetch(_: URL) throws -> Data {
        count += 1
        return Data()
    }
}
