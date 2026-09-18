import CoreGraphics
import Foundation
import Synchronization
import Testing

@testable import CubbyKit

/// A solid-colour canvas with an optional dark square in the middle: the simplest picture that
/// has an unambiguous foreground for Vision, or none at all.
enum TestImages {
    static func canvas(width: Int, height: Int, subject: Bool, alpha: Bool = false) -> CGImage {
        let context = CGContext(
            data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpace(name: CGColorSpace.sRGB)!,
            bitmapInfo: (alpha ? CGImageAlphaInfo.premultipliedLast : CGImageAlphaInfo.noneSkipLast).rawValue
        )!
        context.setFillColor(CGColor(srgbRed: 0.96, green: 0.96, blue: 0.95, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        if subject {
            // A shaded sphere with a soft shadow reads as an object to the foreground model,
            // where a flat square reads as pattern.
            let radius = Double(min(width, height)) / 4
            let center = CGPoint(x: Double(width) / 2, y: Double(height) / 2)
            context.saveGState()
            context.setShadow(
                offset: CGSize(width: radius / 6, height: -radius / 6), blur: radius / 3,
                color: CGColor(srgbRed: 0, green: 0, blue: 0, alpha: 0.45))
            context.setFillColor(CGColor(srgbRed: 0.15, green: 0.2, blue: 0.5, alpha: 1))
            context.fillEllipse(
                in: CGRect(x: center.x - radius, y: center.y - radius, width: radius * 2, height: radius * 2))
            context.restoreGState()
            let gradient = CGGradient(
                colorsSpace: CGColorSpace(name: CGColorSpace.sRGB)!,
                colors: [
                    CGColor(srgbRed: 0.55, green: 0.62, blue: 0.95, alpha: 1),
                    CGColor(srgbRed: 0.05, green: 0.08, blue: 0.3, alpha: 1),
                ] as CFArray,
                locations: [0, 1]
            )!
            context.saveGState()
            context.addEllipse(
                in: CGRect(x: center.x - radius, y: center.y - radius, width: radius * 2, height: radius * 2))
            context.clip()
            context.drawRadialGradient(
                gradient, startCenter: CGPoint(x: center.x - radius / 3, y: center.y + radius / 3),
                startRadius: 0,
                endCenter: center, endRadius: radius * 1.2, options: []
            )
            context.restoreGState()
        }
        return context.makeImage()!
    }
}

@Suite("ImageEncoding")
struct ImageEncodingTests {
    @Test func downscalesTheLongerSideAndKeepsAspect() throws {
        let image = TestImages.canvas(width: 4000, height: 3000, subject: false)
        let scaled = try ImageEncoding.downscaled(image, maxPixelSize: 2048)
        #expect(scaled.width == 2048)
        #expect(scaled.height == 1536)
        let small = TestImages.canvas(width: 640, height: 480, subject: false)
        #expect(try ImageEncoding.downscaled(small, maxPixelSize: 2048) === small)
    }

    @Test func encodesJPEGAndPNGWithTheDeclaredTypes() throws {
        let image = TestImages.canvas(width: 320, height: 200, subject: true)
        let jpeg = try ImageEncoding.encode(image, as: .jpeg)
        let png = try ImageEncoding.encode(image, as: .png)
        #expect(jpeg.prefix(3) == Data([0xFF, 0xD8, 0xFF]))
        #expect(png.prefix(4) == Data([0x89, 0x50, 0x4E, 0x47]))
        #expect(ImageEncoding.pixelSize(of: jpeg)! == (320, 200))
        #expect(ImageEncoding.Format.jpeg.contentType == "image/jpeg")
        #expect(ImageEncoding.Format.png.fileExtension == "png")
    }
}

@Suite("SubjectLift")
struct SubjectLiftTests {
    @Test func liftsADarkSquareOffAPaleCanvas() async throws {
        let image = TestImages.canvas(width: 600, height: 600, subject: true)
        let lifted = try await SubjectLift.lift(image, background: .white, cropToSubject: true)
        #expect(lifted.foundSubject)
        // Cropped to the subject's extent, so strictly smaller than the canvas.
        #expect(lifted.image.width < image.width)
        #expect(lifted.image.height < image.height)
        #expect(lifted.image.width > 0)
    }

    @Test func uniformCanvasHasNoSubjectAndComesBackUntouched() async throws {
        let image = TestImages.canvas(width: 400, height: 300, subject: false)
        let lifted = try await SubjectLift.lift(image)
        #expect(!lifted.foundSubject)
        #expect(lifted.image === image)
    }

    @Test func transparentBackgroundCarriesAlpha() async throws {
        let image = TestImages.canvas(width: 600, height: 600, subject: true)
        let lifted = try await SubjectLift.lift(image, background: .transparent, cropToSubject: false)
        #expect(lifted.foundSubject)
        #expect(
            lifted.image.alphaInfo != .none && lifted.image.alphaInfo != .noneSkipLast
                && lifted.image.alphaInfo != .noneSkipFirst)
    }
}

/// Records the exact call sequence; `failPut` makes the presigned PUT fail.
final class StubPhotoService: PhotoService, Sendable {
    enum Call: Equatable, Sendable {
        case create(ImageUploadRequest), put(URL, String, Int), mark(ImageCode)
        case attach([ImageCode], EntityKey, String), ids(EntityKey, String)
        case order([ImageCode], EntityKey, String)
    }

    let calls = Mutex<[Call]>([])
    let existing: [ImageCode]
    let remainingMarkFailures: Mutex<Int>

    init(existing: [ImageCode] = [], markFailures: Int = 0) {
        self.existing = existing
        remainingMarkFailures = Mutex(markFailures)
    }

    func record(_ call: Call) { calls.withLock { $0.append(call) } }

    func createUpload(_ request: ImageUploadRequest) async throws -> ImageUpload {
        record(.create(request))
        return ImageUpload(
            uploadUrl: URL(string: "https://uploads.example/x")!, imageId: ImageCode("IMG-2345"), key: "k",
            url: URL(string: "https://images.example/x.jpg")!)
    }

    func markUploaded(_ id: ImageCode) async throws {
        record(.mark(id))
        let shouldFail = remainingMarkFailures.withLock { count in
            guard count > 0 else { return false }
            count -= 1
            return true
        }
        if shouldFail { throw URLError(.networkConnectionLost) }
    }

    func attachImages(_ ids: [ImageCode], to entity: EntityKey, id: String) async throws {
        record(.attach(ids, entity, id))
    }

    func imageIDs(entity: EntityKey, id: String) async throws -> [ImageCode] {
        record(.ids(entity, id))
        return existing
    }

    func setImageOrder(_ order: [ImageCode], entity: EntityKey, id: String) async throws {
        record(.order(order, entity, id))
    }
}

@Suite("PhotoUploader")
struct PhotoUploaderTests {
    let image = TestImages.canvas(width: 3000, height: 1500, subject: true)

    @Test func temporarySourceSurvivesAnAsynchronousPut() async throws {
        let original = try ImageEncoding.encode(
            TestImages.canvas(width: 120, height: 80, subject: true), as: .png)
        let uploadedURL = Mutex<URL?>(nil)
        let pending = PendingImageUpload(service: StubPhotoService()) { fileURL, _, _ in
            uploadedURL.withLock { $0 = fileURL }
            await Task.yield()
            try await Task.sleep(for: .milliseconds(20))
            #expect(try Data(contentsOf: fileURL) == original)
        }
        _ = try await pending.upload(
            PreparedPhoto.prepare(
                file: PhotoFile.materialize(original, filename: "temporary.png")),
            entity: .gardenEntry)
        let url = try #require(uploadedURL.withLock { $0 })
        #expect(!FileManager.default.fileExists(atPath: url.path))
    }

    @Test func uploadsInTheServerOrderAndOrdersTheCoverSecond() async throws {
        let service = StubPhotoService(existing: [ImageCode("IMG-0001"), ImageCode("IMG-2345")])
        let uploader = PhotoUploader(service: service) { fileURL, url, contentType in
            service.record(.put(url, contentType, try Data(contentsOf: fileURL).count))
        }
        let steps = Mutex<[PhotoUploader.Step]>([])
        let outcome = try await uploader.upload(
            .init(
                image: image, format: .jpeg, entity: .product, entityID: "PRD-2345", makeCover: true,
                filenameBase: "shelf"),
            progress: { step in steps.withLock { $0.append(step) } }
        )
        let calls = service.calls.withLock { $0 }
        #expect(calls.count == 6)
        guard case .create(let request) = calls[0] else {
            Issue.record("expected create"); return
        }
        #expect(request.filename == "shelf.jpg")
        #expect(request.contentType == "image/jpeg")
        #expect(request.entity == .product)
        #expect(request.size == outcome.byteCount)
        #expect(request.width == 3000)
        #expect(request.height == 1500)
        #expect(request.algorithmRevision == 1)
        guard case .put(_, let putType, let putSize) = calls[1] else { Issue.record("expected put"); return }
        // The PUT carries exactly the bytes and content type that were presigned.
        #expect(putType == request.contentType)
        #expect(putSize == request.size)
        #expect(calls[2] == .mark(ImageCode("IMG-2345")))
        #expect(calls[3] == .attach([ImageCode("IMG-2345")], .product, "PRD-2345"))
        #expect(calls[4] == .ids(.product, "PRD-2345"))
        // New first, existing after, the new id not repeated.
        #expect(calls[5] == .order([ImageCode("IMG-2345"), ImageCode("IMG-0001")], .product, "PRD-2345"))
        #expect(steps.withLock { $0 } == PhotoUploader.Step.allCases)
        #expect(outcome.imageID == ImageCode("IMG-2345"))
        #expect(outcome.byteCount > 0)
    }

    @Test func withoutMakeCoverThereIsOnePatch() async throws {
        let service = StubPhotoService()
        let uploader = PhotoUploader(service: service) { _, _, _ in }
        _ = try await uploader.upload(.init(image: image, entity: .purchase, entityID: "PUR-2345"))
        let calls = service.calls.withLock { $0 }
        #expect(calls.count == 3)
        #expect(calls[1] == .mark(ImageCode("IMG-2345")))
        #expect(calls[2] == .attach([ImageCode("IMG-2345")], .purchase, "PUR-2345"))
    }

    @Test func existingImageAttachesAndOrdersWithoutUploadingOrMarking() async throws {
        let service = StubPhotoService(existing: [ImageCode("IMG-0001"), ImageCode("IMG-2345")])
        let uploader = PhotoUploader(service: service) { _, _, _ in
            Issue.record("existing image should not PUT bytes")
        }
        try await uploader.attachExisting(
            ImageCode("IMG-2345"), entity: .product, entityID: "PRD-2345", makeCover: true)

        #expect(
            service.calls.withLock { $0 } == [
                .attach([ImageCode("IMG-2345")], .product, "PRD-2345"),
                .ids(.product, "PRD-2345"),
                .order([ImageCode("IMG-2345"), ImageCode("IMG-0001")], .product, "PRD-2345"),
            ])
    }

    /// `makeCover` is not a product-only affordance: any entity whose update body takes
    /// `imageOrder` gets the same read-then-reorder pair, keyed by the request's own entity.
    @Test func setImageOrderSendsImageOrderForAnyEntity() async throws {
        let service = StubPhotoService(existing: [ImageCode("IMG-0001")])
        let uploader = PhotoUploader(service: service) { _, _, _ in }
        try await uploader.attachExisting(
            ImageCode("IMG-2345"), entity: .location, entityID: "LOC-2345", makeCover: true)

        #expect(
            service.calls.withLock { $0 } == [
                .attach([ImageCode("IMG-2345")], .location, "LOC-2345"),
                .ids(.location, "LOC-2345"),
                .order([ImageCode("IMG-2345"), ImageCode("IMG-0001")], .location, "LOC-2345"),
            ])
    }

    @Test func originalFileUploadsExactBytesAndActualContainerMetadata() async throws {
        let service = StubPhotoService()
        let original = try ImageEncoding.encode(
            TestImages.canvas(width: 413, height: 271, subject: true), as: .png)
        let file = try PhotoFile.materialize(
            data: original, filename: "original.png", contentType: "image/png")
        let uploaded = Mutex<Data?>(nil)
        let uploader = PhotoUploader(service: service) { fileURL, _, _ in
            uploaded.withLock { $0 = try? Data(contentsOf: fileURL) }
        }

        _ = try await uploader.upload(
            .init(file: file, entity: .purchase, entityID: "PUR-2345"))

        #expect(uploaded.withLock { $0 } == original)
        guard case .create(let request) = service.calls.withLock({ $0 }).first else {
            Issue.record("expected create")
            return
        }
        #expect(request.filename == "original.png")
        #expect(request.contentType == "image/png")
        #expect(request.size == original.count)
        #expect(request.width == 413)
        #expect(request.height == 271)
    }

    @Test func aFailedPutStopsBeforeMarking() async throws {
        let service = StubPhotoService()
        let uploader = PhotoUploader(service: service) { _, _, _ in
            throw CubbyAPIError(status: 403, operationID: "presigned.put", detail: nil)
        }
        await #expect(throws: PhotoUploader.Failure.self) {
            _ = try await uploader.upload(.init(image: image, entity: .product, entityID: "PRD-2345"))
        }
        #expect(service.calls.withLock { $0 }.count == 1)
    }

    @Test func retriesMarkingWithoutUploadingTheSuccessfulPhotoAgain() async throws {
        let service = StubPhotoService(markFailures: 1)
        let uploader = PhotoUploader(service: service) { fileURL, url, contentType in
            service.record(.put(url, contentType, try Data(contentsOf: fileURL).count))
        }
        let request = PhotoUploader.Request(image: image, entity: .product, entityID: "PRD-2345")
        var checkpoint: PhotoUploader.Checkpoint?
        do {
            _ = try await uploader.upload(request)
            Issue.record("Expected the first mark to fail")
        } catch let failure as PhotoUploader.Failure {
            checkpoint = failure.checkpoint
        }
        let resumed = try #require(checkpoint)
        _ = try await uploader.upload(request, resuming: resumed)
        let calls = service.calls.withLock { $0 }
        #expect(calls.filter { if case .create = $0 { true } else { false } }.count == 1)
        #expect(calls.filter { if case .put = $0 { true } else { false } }.count == 1)
        #expect(calls.filter { if case .mark = $0 { true } else { false } }.count == 2)
        #expect(calls.filter { if case .attach = $0 { true } else { false } }.count == 1)
    }

    @Test func imageUploadDecodes() throws {
        let upload = try Fixtures.decode(ImageUpload.self, from: "image-upload.json")
        #expect(upload.imageId == ImageCode("IMG-2345"))
        #expect(upload.uploadUrl.host() == "uploads.example")
    }

    @Test func acceptsImagesFollowsTheGeneratedTable() {
        #expect(EntityCatalog[.product].acceptsImages)
        #expect(EntityCatalog[.purchase].acceptsImages)
        // Vendor owns a single logo FK rather than an image-association gallery.
        #expect(!EntityCatalog[.vendor].acceptsImages)
    }
}

@Suite("PendingImageUploader")
struct PendingImageUploaderTests {
    /// The record mutation that attaches a pending batch marks it uploaded; this path must not.
    @Test func leavesCompletedPhotosPendingForTheEntryWorkflow() async throws {
        let service = StubPhotoService()
        let uploader = PendingImageUploader(entity: .gardenEntry, service: service) {
            fileURL, url, contentType in
            service.record(.put(url, contentType, try Data(contentsOf: fileURL).count))
        }
        let image = TestImages.canvas(width: 1200, height: 800, subject: true)
        let ids = try await uploader.upload([image, image])

        #expect(ids == [ImageCode("IMG-2345"), ImageCode("IMG-2345")])
        let calls = service.calls.withLock { $0 }
        #expect(calls.count == 4)
        #expect(calls.filter { if case .attach = $0 { true } else { false } }.isEmpty)
        #expect(calls.filter { if case .mark = $0 { true } else { false } }.isEmpty)
    }
}

private final class PresignedStub: URLProtocol, @unchecked Sendable {
    static let handler = Mutex<StubNetworking.Handler?>(nil)
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        StubNetworking.startLoading(
            request, client: client, target: self, handler: Self.handler.withLock { $0 })
    }
    override func stopLoading() {}
    static func session() -> URLSession { StubNetworking.session(protocolClass: self) }
}

@Suite("PresignedUpload", .serialized)
struct PresignedUploadTests {
    @Test func putSendsOnlyContentTypeAndTheBytes() async throws {
        let seen = Mutex<(method: String?, headers: [String: String], length: Int)?>(nil)
        PresignedStub.handler.withLock { handler in
            handler = { request in
                var length = request.httpBody?.count ?? 0
                if length == 0, let stream = request.httpBodyStream {
                    stream.open()
                    var buffer = [UInt8](repeating: 0, count: 4096)
                    while stream.hasBytesAvailable {
                        let read = stream.read(&buffer, maxLength: buffer.count)
                        if read <= 0 { break }
                        length += read
                    }
                    stream.close()
                }
                seen.withLock { $0 = (request.httpMethod, request.allHTTPHeaderFields ?? [:], length) }
                return (200, Data())
            }
        }
        let bytes = try ImageEncoding.encode(
            TestImages.canvas(width: 24, height: 12, subject: true), as: .jpeg)
        let file = try PhotoFile.materialize(
            bytes, filename: "transport.jpg", contentType: "image/jpeg")
        try await PresignedUpload.putFile(
            file.url, to: URL(string: "https://uploads.example/x")!, contentType: file.contentType,
            session: PresignedStub.session())
        let request = try #require(seen.withLock { $0 })
        #expect(request.method == "PUT")
        #expect(request.headers["Content-Type"] == "image/jpeg")
        #expect(request.headers["Authorization"] == nil)
        #expect(request.headers["x-api-key"] == nil)
        #expect(request.length == bytes.count)
    }

    @Test func rejectedPutThrowsWithTheStatus() async throws {
        PresignedStub.handler.withLock { $0 = { _ in (403, Data("<xml>AccessDenied</xml>".utf8)) } }
        do {
            try await PresignedUpload.put(
                Data([1]), to: URL(string: "https://uploads.example/x")!, contentType: "image/png",
                session: PresignedStub.session())
            Issue.record("expected a throw")
        } catch let error as CubbyAPIError {
            #expect(error.status == 403)
            #expect(error.detail == nil)
        }
    }
}

@Suite("PhotoDiagnostics")
struct PhotoDiagnosticsTests {
    private static func analysis(classifierIdentifier: String, confidence: Double) -> PhotoLocalAnalysis {
        PhotoLocalAnalysis(
            id: "photo", analyzedAt: Date(timeIntervalSince1970: 0), sha256: "sha",
            capturedAt: nil, contentType: "image/jpeg", width: 32, height: 24,
            classifications: [PhotoClassification(identifier: classifierIdentifier, confidence: confidence)],
            recognizedText: [], featurePrint: PhotoFeaturePrint(revision: "1", data: Data()),
            provenance: PhotoAnalysisProvenance(source: .files, filename: "photo.jpg"))
    }

    private static func file() throws -> PhotoFile {
        try PhotoFile.materialize(
            try ImageEncoding.encode(TestImages.canvas(width: 32, height: 24, subject: false), as: .jpeg),
            filename: "photo.jpg")
    }

    /// `PhotoDiagnostics.report` is what both `suggestedSource`'s "Suggested: …" chip and the CLI's
    /// `routing` dump are built from (this folds the former standalone `policyMatches` table test
    /// in, so there's one table test, not two): a match at/above a policy's `minimumScore` must
    /// flag only that entity — and win `suggestedSource` — while dropping just below must un-flag
    /// it without touching any other entity's verdict, and the report always carries exactly one
    /// verdict per routing policy.
    @Test("routing verdict tracks minimumScore", arguments: [true, false])
    func routingVerdictTracksMinimumScore(above: Bool) async throws {
        let (key, policy) = try #require(
            PhotoImportCatalog.routingPolicies.first { !$0.value.classifierLabels.isEmpty })
        let label = try #require(policy.classifierLabels.first)
        let identifier = "\(label)-detected"
        let confidence = above ? min(1, policy.minimumScore + 0.1) : max(0, policy.minimumScore - 0.1)

        let report = await PhotoDiagnostics.report(
            analysis: Self.analysis(classifierIdentifier: identifier, confidence: confidence),
            file: try Self.file(), includeFeaturePrintData: false, runSemantic: false)

        #expect(report.routing.count == PhotoImportCatalog.routingPolicies.count)
        let verdict = try #require(report.routing.first { $0.entity == key })
        #expect(verdict.meetsMinimumScore == above)
        #expect(verdict.classifierIdentifier == identifier)
        #expect(report.suggestedSource == (above ? key : nil))
    }
}
