import Foundation
import Synchronization
import Testing

@testable import CubbyKit

/// Per-suite network stub (`Tests/CubbyKitTests/Support/StubURLProtocol.swift`'s doc comment):
/// Swift Testing runs `@Suite` types concurrently even when each is `.serialized`, so a handler
/// shared across suites intermittently answers one suite's request with another's response.
private final class PhotoImportRunUploaderStub: URLProtocol, @unchecked Sendable {
    static let handler = Mutex<StubNetworking.Handler?>(nil)
    static let cancelNextResponse = Mutex<String?>(nil)
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let cancel = Self.cancelNextResponse.withLock { suffix in
            guard let value = suffix, request.url?.path.hasSuffix(value) == true else { return false }
            suffix = nil
            return true
        }
        if cancel {
            _ = Self.handler.withLock { $0 }?(request)
            client?.urlProtocol(self, didFailWithError: URLError(.cancelled))
            return
        }
        StubNetworking.startLoading(
            request, client: client, target: self, handler: Self.handler.withLock { $0 })
    }
    override func stopLoading() {}
    static func session() -> URLSession { StubNetworking.session(protocolClass: self) }
}

/// Routes by path rather than a strict call-order queue: a chunking test alone issues well over a
/// hundred requests (stage/finalize chunks plus one `recordAnalysis` per photo), so scripting every
/// response individually the way `PhotoImportStagerTests`' `RequestScript` does would not scale.
/// `failNextFinalize` lets a single test still control one specific finalize outcome.
private final class RunUploaderScript: @unchecked Sendable {
    struct Seen: Sendable {
        let path: String
        let fields: [String: JSONValue]
    }

    struct DeviceWorkReport: Sendable, Equatable {
        let image: String
        let state: String
        let error: String?
    }

    private let admittedBatchID = Mutex<String?>(nil)
    private let admissionOffset: Int
    init(admissionOffset: Int = 0) { self.admissionOffset = admissionOffset }

    private let seenBox = Mutex<[Seen]>([])
    private let failNextFinalize = Mutex<Bool>(false)
    private let failNextCreateRun = Mutex<Bool>(false)
    private let analysisCalls = Mutex<[String: Int]>([:])
    private let deviceWorkReportsBox = Mutex<[DeviceWorkReport]>([])
    private let failDeviceWorkReports = Mutex<Bool>(false)

    var seen: [Seen] { seenBox.withLock { $0 } }
    func requests(matching suffix: String) -> [Seen] { seen.filter { $0.path.hasSuffix(suffix) } }
    /// Number of `recordAnalysis` calls seen for one image id, keyed by the id `stage` assigned it
    /// (`"IMG-\(clientId)"` below).
    func analysisCallCount(forImageID imageID: String) -> Int {
        analysisCalls.withLock { $0[imageID] ?? 0 }
    }

    /// Every `run.reportDeviceWork` call seen for one image id, in request order — the state
    /// sequence `PhotoImportRunUploader` posted while processing it.
    func deviceWorkReports(forImageID imageID: String) -> [DeviceWorkReport] {
        deviceWorkReportsBox.withLock { $0.filter { $0.image == imageID } }
    }

    /// The next `finalize` call answers 500 instead of confirming; the call after that (a retry)
    /// reports every requested id in `alreadyFinalized` rather than `finalized`, exercising the
    /// idempotent-replay path a retry after a transport error relies on.
    func failNextFinalizeCall() { failNextFinalize.withLock { $0 = true } }
    func failNextCreateRunCall() { failNextCreateRun.withLock { $0 = true } }
    /// Every `run.reportDeviceWork` call answers 500 for the rest of this script's lifetime —
    /// used to prove a reporting failure never blocks or fails analysis.
    func failDeviceWorkReportsAlways() { failDeviceWorkReports.withLock { $0 = true } }

    var handler: StubNetworking.Handler {
        { [self] request in
            let fields =
                (try? JSONDecoder().decode(
                    [String: JSONValue].self, from: Self.body(of: request))) ?? [:]
            let path = request.url?.path ?? ""
            seenBox.withLock { $0.append(Seen(path: path, fields: fields)) }

            if path.hasSuffix("/photoImport/createRun") {
                admittedBatchID.withLock { $0 = fields["clientBatchId"]?.stringValue }
                let shouldFail = failNextCreateRun.withLock { pending in
                    defer { pending = false }
                    return pending
                }
                if shouldFail { return (500, Data(#"{"code":"INTERNAL","message":"try again"}"#.utf8)) }
                admittedBatchID.withLock { $0 = fields["clientBatchId"]?.stringValue }
                return (200, Data(#"{"runId": "RUN-TEST"}"#.utf8))
            }
            if path.hasSuffix("/photoImport/admitBatch") || path.hasSuffix("/photoImport/sealBatch") {
                if path.hasSuffix("/photoImport/admitBatch") {
                    admittedBatchID.withLock { $0 = fields["clientBatchId"]?.stringValue }
                } else if fields["clientBatchId"]?.stringValue != admittedBatchID.withLock({ $0 }) {
                    return (400, Data(#"{"code":"VALIDATION","message":"Unknown upload batch"}"#.utf8))
                }
                return (
                    200,
                    Data(
                        #"{"runId":"RUN-TEST","clientBatchId":"00000000-0000-0000-0000-000000000001","positionOffset":\#(admissionOffset),"lifecycle":{"processor":"cubby","phase":"waiting_for_upload","plannedImageCount":1,"openBatchCount":0,"finalizedImageCount":0,"describedImageCount":0,"failedImageIds":[],"skippedImageCount":0,"proposedGroupCount":0,"committedGroupCount":0,"dispatchError":null}}"#
                            .utf8)
                )
            }
            if path.hasSuffix("/photoImport/stage") {
                let items = fields["items"]?.arrayValue ?? []
                let responseItems = items.map { item -> String in
                    let clientID = item["clientId"]?.stringValue ?? ""
                    return """
                        {"kind": "upload", "clientId": "\(clientID)", "imageId": "IMG-\(clientID)", \
                        "uploadUrl": "https://uploads.example/x", "key": "k", \
                        "url": "https://images.example/x.jpg"}
                        """
                }
                return (200, Data(#"{"items": [\#(responseItems.joined(separator: ","))]}"#.utf8))
            }
            if path.hasSuffix("/photoImport/finalize") {
                let ids = (fields["images"]?.arrayValue ?? []).compactMap { $0["imageId"]?.stringValue }
                let shouldFail = failNextFinalize.withLock { pending in
                    let was = pending
                    pending = false
                    return was
                }
                if shouldFail {
                    return (500, Data(#"{"code": "INTERNAL", "message": "boom"}"#.utf8))
                }
                let idsJSON = ids.map { "\"\($0)\"" }.joined(separator: ", ")
                // Every id that reaches here on a call following a failed one is a replay: the
                // server's real behavior is to report a previously-finalized id in
                // `alreadyFinalized`, never resending it as freshly `finalized`.
                let json = #"{"finalized": [], "alreadyFinalized": [\#(idsJSON)], "submissionId": "sub-1"}"#
                return (200, Data(json.utf8))
            }
            if path.hasSuffix("/image/recordAnalysis") {
                if let imageID = fields["id"]?.stringValue {
                    analysisCalls.withLock { $0[imageID, default: 0] += 1 }
                }
                return (200, Data(#"{"saved": true}"#.utf8))
            }
            if path.hasSuffix("/run/reportDeviceWork") {
                if let image = fields["image"]?.stringValue, let state = fields["state"]?.stringValue {
                    deviceWorkReportsBox.withLock {
                        $0.append(
                            DeviceWorkReport(image: image, state: state, error: fields["error"]?.stringValue))
                    }
                }
                if failDeviceWorkReports.withLock({ $0 }) {
                    return (500, Data(#"{"code": "INTERNAL", "message": "boom"}"#.utf8))
                }
                return (200, Data(#"{"recorded": true}"#.utf8))
            }
            return (404, Data("{}".utf8))
        }
    }

    /// The OpenAPI Darwin transport writes the request body via a bound stream asynchronously;
    /// `httpBody` is empty until it's read this way (mirrors `PhotoImportStagerTests`).
    private static func body(of request: URLRequest) -> Data {
        if let body = request.httpBody, !body.isEmpty { return body }
        guard let stream = request.httpBodyStream else { return Data() }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while true {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count <= 0 { break }
            data.append(contentsOf: buffer.prefix(count))
        }
        return data
    }
}

@Suite("PhotoImportRunUploader", .timeLimit(.minutes(1)), .serialized)
struct PhotoImportRunUploaderTests {
    private func makeClient() throws -> CubbyClient {
        let store = InMemorySessionTokenStore()
        try store.save(.bearer("tok"), for: "localhost:3000")
        let credentials = CredentialProvider(host: "localhost:3000", store: store)
        return CubbyClient(
            baseURL: URL(string: "http://localhost:3000")!, credentials: credentials,
            session: PhotoImportRunUploaderStub.session())
    }

    private func photo(_ id: String) throws -> PhotoImportRunPhoto {
        let file = try PhotoFile.materialize(
            try ImageEncoding.encode(TestImages.canvas(width: 8, height: 8, subject: false), as: .jpeg),
            filename: "\(id).jpg")
        return PhotoImportRunPhoto(
            id: id, file: file,
            provenance: PhotoAnalysisProvenance(source: .files, filename: "\(id).jpg"))
    }

    private func fakeAnalysis(for id: String) -> PhotoLocalAnalysis {
        PhotoLocalAnalysis(
            id: id, analyzedAt: Date(timeIntervalSince1970: 0), sha256: "sha-\(id)",
            capturedAt: nil, contentType: "image/jpeg", width: 8, height: 8,
            classifications: [], recognizedText: [],
            featurePrint: PhotoFeaturePrint(revision: "1", data: Data()),
            provenance: PhotoAnalysisProvenance(source: .files, filename: "\(id).jpg"))
    }

    /// A 25-photo chunk must expose each completed PUT while the next PUT is blocked;
    /// finalized count stays zero until the server confirms the chunk.
    @Test func twentyFivePhotosReportTransfersBeforeFinalize() async throws {
        defer { PhotoImportRunUploaderStub.handler.withLock { $0 = nil } }
        let script = RunUploaderScript()
        PhotoImportRunUploaderStub.handler.withLock { $0 = script.handler }
        let gate = Gate()
        let calls = Mutex<Int>(0)
        let uploader = PhotoImportRunUploader(
            client: try makeClient(), maximumConcurrentUploads: 1,
            put: { _, _, _ in
                let count = calls.withLock {
                    $0 += 1; return $0
                }
                if count == 2 { try await gate.pass() }
            })
        let photos = try (0..<25).map { try photo("photo-\($0)") }
        let task = Task {
            try await uploader.upload(photos, runID: "RUN-TEST", performLocalAnalysis: false)
        }
        await gate.arrivals()
        let progress = await uploader.progress
        #expect(progress.transferred == 1)
        #expect(progress.uploaded == 0)
        #expect(script.requests(matching: "/photoImport/finalize").isEmpty)
        gate.open()
        _ = try await task.value
        #expect(await uploader.progress.transferred == 25)
        #expect(await uploader.progress.uploaded == 25)
    }

    /// Termination after PUT but before finalize must recover the same staged image without
    /// another PUT. Explicit cancellation must remove the journal from automatic recovery.
    @Test func durableRecoveryRetainsTransferredPhotosAndCancellation() async throws {
        defer { PhotoImportRunUploaderStub.handler.withLock { $0 = nil } }
        let script = RunUploaderScript()
        script.failNextFinalizeCall()
        PhotoImportRunUploaderStub.handler.withLock { $0 = script.handler }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let checkpoint = directory.appendingPathComponent("import.json")
        let puts = Mutex<Int>(0)
        let put: PresignedUpload.FilePut = { _, _, _ in puts.withLock { $0 += 1 } }
        let first = PhotoImportRunUploader(client: try makeClient(), checkpointURL: checkpoint, put: put)
        do {
            _ = try await first.upload(
                [try photo("recovery")], runID: "RUN-TEST", performLocalAnalysis: false)
            Issue.record("Expected finalize to fail")
        } catch {}
        let second = PhotoImportRunUploader(
            client: try makeClient(), checkpointURL: checkpoint, put: put,
            analyze: { input in fakeAnalysis(for: input.id) })
        #expect(try await second.recover() == "RUN-TEST")
        #expect(puts.withLock { $0 } == 1)
        try await second.cancelRemaining()
        #expect(try PhotoImportRunCheckpoint.pending(in: directory).isEmpty)
    }

    /// Unfavorable conditions block all new work until the gate is released. Cancelling the
    /// wait interrupts immediately without starting an upload or silently overriding policy.
    @Test func conditionWaitIsCancellableWithoutUploading() async throws {
        defer { PhotoImportRunUploaderStub.handler.withLock { $0 = nil } }
        let script = RunUploaderScript()
        PhotoImportRunUploaderStub.handler.withLock { $0 = script.handler }
        let gate = Gate()
        let puts = Mutex<Int>(0)
        let uploader = PhotoImportRunUploader(
            client: try makeClient(), waitForConditions: { _ in try await gate.pass() },
            waitingReason: { "Waiting for Wi-Fi" },
            put: { _, _, _ in puts.withLock { $0 += 1 } })
        let photos = [try photo("waiting")]
        let task = Task { try await uploader.upload(photos, runID: "RUN-TEST", performLocalAnalysis: false) }
        await gate.arrivals()
        #expect(await uploader.progress.waitingReason == "Waiting for Wi-Fi")
        #expect(puts.withLock { $0 } == 0)
        task.cancel()
        await #expect(throws: CancellationError.self) { _ = try await task.value }
        #expect(script.requests(matching: "/photoImport/stage").isEmpty)
    }

    /// One failed transfer must not abandon successful photos in its chunk. Retrying the
    /// failed photo stages only that photo and preserves the original positions.
    @Test func individualRetryKeepsSuccessfulPhotosImported() async throws {
        defer { PhotoImportRunUploaderStub.handler.withLock { $0 = nil } }
        let script = RunUploaderScript()
        PhotoImportRunUploaderStub.handler.withLock { $0 = script.handler }
        let fail = Mutex<Bool>(true)
        let puts = Mutex<Int>(0)
        let uploader = PhotoImportRunUploader(
            client: try makeClient(),
            put: { file, _, _ in
                puts.withLock { $0 += 1 }
                if file.lastPathComponent.hasSuffix("-bad.jpg"),
                    fail.withLock({ pending in
                        let previous = pending
                        pending = false
                        return previous
                    })
                {
                    throw URLError(.networkConnectionLost)
                }
            }, analyze: { input in fakeAnalysis(for: input.id) })
        let photos = try [photo("bad")] + (0..<104).map { try photo("good-\($0)") }
        await #expect(throws: PhotoImportRunUploader.Failure.self) {
            _ = try await uploader.upload(photos, runID: "RUN-TEST", performLocalAnalysis: false)
        }
        #expect(await uploader.progress.uploaded == 99)
        #expect(await uploader.failedUploadPhotos.map(\.id) == ["bad"])
        try await uploader.retryPhoto("bad")
        #expect(await uploader.progress.uploaded == 105)
        #expect(puts.withLock { $0 } == 106)
        let staged = script.requests(matching: "/photoImport/stage")
        #expect(staged.count == 3)
        #expect(staged[1].fields["items"]?.arrayValue?.count == 1)
        #expect(staged.last?.fields["items"]?.arrayValue?.count == 5)
    }

    /// Excluding a failed first-chunk photo must still upload untouched later chunks.
    @Test func excludingFailureUploadsUntouchedLaterChunks() async throws {
        defer { PhotoImportRunUploaderStub.handler.withLock { $0 = nil } }
        let script = RunUploaderScript()
        PhotoImportRunUploaderStub.handler.withLock { $0 = script.handler }
        let uploader = PhotoImportRunUploader(
            client: try makeClient(),
            put: { file, _, _ in
                if file.lastPathComponent.hasSuffix("-bad.jpg") { throw URLError(.networkConnectionLost) }
            }, analyze: { input in fakeAnalysis(for: input.id) })
        let photos = try [photo("bad")] + (0..<104).map { try photo("later-\($0)") }
        await #expect(throws: PhotoImportRunUploader.Failure.self) {
            _ = try await uploader.upload(photos, runID: "RUN-TEST", performLocalAnalysis: false)
        }
        #expect(await uploader.progress.uploaded == 99)
        try await uploader.continueWithoutFailedUploads()
        #expect(await uploader.progress.uploaded == 104)
        #expect(await uploader.progress.remaining == 0)
        #expect(await uploader.progress.excluded == 1)
        #expect(script.requests(matching: "/photoImport/sealBatch").count == 1)
    }

    /// One missing journal-owned original must leave other originals importable and the
    /// missing photo explicitly retryable/excludable rather than failing the whole chunk.
    @Test func missingOriginalFailsOnlyItsPhoto() async throws {
        defer { PhotoImportRunUploaderStub.handler.withLock { $0 = nil } }
        let script = RunUploaderScript()
        PhotoImportRunUploaderStub.handler.withLock { $0 = script.handler }
        let missing = try photo("missing")
        try FileManager.default.removeItem(at: missing.file.url)
        let uploader = PhotoImportRunUploader(
            client: try makeClient(), put: { _, _, _ in }, analyze: { input in fakeAnalysis(for: input.id) })
        await #expect(throws: PhotoImportRunUploader.Failure.self) {
            _ = try await uploader.upload(
                [missing, try photo("present")], runID: "RUN-TEST", performLocalAnalysis: false)
        }
        #expect(await uploader.progress.uploaded == 1)
        #expect(await uploader.failedUploadPhotos.map(\.id) == ["missing"])
        try await uploader.continueWithoutFailedUploads()
        #expect(await uploader.progress.remaining == 0)
        #expect(await uploader.progress.excluded == 1)
    }

    /// Recovery renews only a proven expired AWS presign after consuming the background
    /// result. A 403 on a still-valid URL remains attention, never an unconditional replay.
    @Test(arguments: [true, false]) func recoveryRenewsOnlyExpiredPresigns(expired: Bool) async throws {
        defer { PhotoImportRunUploaderStub.handler.withLock { $0 = nil } }
        let script = RunUploaderScript()
        PhotoImportRunUploaderStub.handler.withLock { $0 = script.handler }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let checkpoint = directory.appendingPathComponent("import.json")
        let first = PhotoImportRunUploader(
            client: try makeClient(), checkpointURL: checkpoint,
            put: { file, _, _ in
                if file.lastPathComponent == "0" { throw CancellationError() }
            })
        await #expect(throws: PhotoImportRunUploader.Failure.self) {
            _ = try await first.upload(
                [try photo("pending"), try photo("confirmed")], runID: "RUN-TEST", performLocalAnalysis: false
            )
        }
        var journal = try JSONDecoder().decode(
            PhotoImportRunCheckpoint.self, from: Data(contentsOf: checkpoint))
        journal.pending["pending"]?.url = try #require(
            URL(
                string:
                    "https://uploads.example/x?X-Amz-Date=\(expired ? "20000101" : "20990101")T000000Z&X-Amz-Expires=60"
            ))
        try journal.save(at: checkpoint)
        let renewed = PhotoImportRunUploader(
            client: try makeClient(), checkpointURL: checkpoint,
            put: { _, url, _ in
                if url.query != nil {
                    throw CubbyAPIError(status: 403, operationID: "presigned.put", detail: nil)
                }
            }, analyze: { input in fakeAnalysis(for: input.id) })
        if expired {
            #expect(try await renewed.recover() == "RUN-TEST")
            #expect(await renewed.progress.uploaded == 2)
            #expect(script.requests(matching: "/photoImport/stage").count == 2)
        } else {
            await #expect(throws: PhotoImportRunUploader.Failure.self) { _ = try await renewed.recover() }
            #expect(await renewed.progress.uploaded == 1)
            #expect(script.requests(matching: "/photoImport/stage").count == 1)
        }
    }

    /// Cancellation after the server admitted a batch but its response was lost must
    /// replay the durable intent and seal before deleting the journal.
    @Test(arguments: [true, false]) func cancellationSettlesAmbiguousAdmission(newRun: Bool) async throws {
        defer { PhotoImportRunUploaderStub.handler.withLock { $0 = nil } }
        let script = RunUploaderScript()
        PhotoImportRunUploaderStub.handler.withLock { $0 = script.handler }
        PhotoImportRunUploaderStub.cancelNextResponse.withLock {
            $0 = newRun ? "/photoImport/createRun" : "/photoImport/admitBatch"
        }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let checkpoint = directory.appendingPathComponent("import.json")
        let uploader = PhotoImportRunUploader(
            client: try makeClient(), checkpointURL: checkpoint, put: { _, _, _ in })
        let create = PhotoImportCreateRunInput(
            processor: .cubby, clientBatchId: UUID().uuidString, imageCount: 1)
        await #expect(throws: (any Error).self) {
            _ = try await uploader.upload(
                [try photo("admission")], runID: newRun ? nil : "RUN-TEST", createRun: newRun ? create : nil)
        }
        try await uploader.recordCancellationIntent()
        let state = try JSONDecoder().decode(
            PhotoImportRunCheckpoint.self, from: Data(contentsOf: checkpoint))
        #expect(state.needsCancellationSettlement)
        let recovered = PhotoImportRunUploader(
            client: try makeClient(), checkpointURL: checkpoint, put: { _, _, _ in })
        try await recovered.settleCancellation()
        #expect(script.requests(matching: "/photoImport/sealBatch").count == 1)
        #expect(!FileManager.default.fileExists(atPath: checkpoint.path))
        #expect(
            script.requests(matching: newRun ? "/photoImport/createRun" : "/photoImport/admitBatch").count
                == 2)
    }

    /// Done may wait on cancellation settlement: a completed transfer is finalized and
    /// reflected in confirmed selection IDs, while the blocked remaining transfer is excluded.
    @Test @MainActor func cancellationWaitsForSettlementAndRefreshesConfirmedIDs() async throws {
        defer { PhotoImportRunUploaderStub.handler.withLock { $0 = nil } }
        let script = RunUploaderScript()
        PhotoImportRunUploaderStub.handler.withLock { $0 = script.handler }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let checkpoint = directory.appendingPathComponent("import.json")
        let gate = Gate()
        let puts = Mutex<Int>(0)
        let session = PhotoImportRunSession(
            uploader: PhotoImportRunUploader(
                client: try makeClient(), checkpointURL: checkpoint, maximumConcurrentUploads: 1,
                put: { _, _, _ in
                    let next = puts.withLock {
                        $0 += 1; return $0
                    }
                    if next == 2 { try await gate.pass() }
                }))
        session.start([try photo("confirmed"), try photo("remaining")], runID: "RUN-TEST")
        await gate.arrivals()
        await observe { session.progress.transferred == 1 }
        session.cancel()
        #expect(session.hasActiveWork)
        await session.waitUntilIdle()
        #expect(session.phase == .cancelled)
        #expect(session.importedPhotoIDs == ["confirmed"])
        #expect(session.progress.uploaded == 1)
        #expect(session.progress.excluded == 1)
        #expect(script.requests(matching: "/photoImport/sealBatch").count == 1)
        #expect(!FileManager.default.fileExists(atPath: checkpoint.path))
    }

    /// A reason transition while work stays suspended must reach progress immediately;
    /// it cannot keep claiming that the network is unavailable after the network recovers.
    @Test func waitingReasonChangesWhileConditionsRemainBlocked() async throws {
        defer { PhotoImportRunUploaderStub.handler.withLock { $0 = nil } }
        let script = RunUploaderScript()
        PhotoImportRunUploaderStub.handler.withLock { $0 = script.handler }
        let gate = Gate()
        let uploader = PhotoImportRunUploader(
            client: try makeClient(),
            waitForConditions: { changed in
                await changed("Waiting for Low Power Mode to turn off")
                try await gate.pass()
            }, waitingReason: { "Waiting for unmetered Wi-Fi or Ethernet" }, put: { _, _, _ in })
        let task = Task {
            try await uploader.upload([try photo("waiting")], runID: "RUN-TEST", performLocalAnalysis: false)
        }
        await gate.arrivals()
        #expect(await uploader.progress.waitingReason == "Waiting for Low Power Mode to turn off")
        #expect(script.requests(matching: "/photoImport/stage").isEmpty)
        task.cancel()
        await #expect(throws: CancellationError.self) { _ = try await task.value }
    }

    /// Capture facts must travel in finalize, before optional Vision analysis, including a
    /// recovery after the finalize response fails.
    @Test func libraryCaptureFactsSurviveDurableFinalizeRetry() async throws {
        defer { PhotoImportRunUploaderStub.handler.withLock { $0 = nil } }
        let script = RunUploaderScript()
        script.failNextFinalizeCall()
        PhotoImportRunUploaderStub.handler.withLock { $0 = script.handler }
        let original = try photo("metadata")
        let capturedAt = Date(timeIntervalSince1970: 1_700_000_000)
        let metadata = LibraryAssetMetadata(
            localIdentifier: "synthetic-asset", creationDate: capturedAt,
            location: .init(latitude: 10, longitude: 20), sourceType: .userLibrary,
            pixelWidth: 8, pixelHeight: 8, captureTimeZoneOffsetMinutes: -420)
        let library = LibrarySightingBuilder.reportFields(
            for: metadata, installationID: "synthetic-installation", observedAt: capturedAt)
        let selected = PhotoImportRunPhoto(
            id: original.id, file: original.file,
            provenance: original.provenance, library: library)
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let checkpoint = directory.appendingPathComponent("import.json")
        let first = PhotoImportRunUploader(
            client: try makeClient(), checkpointURL: checkpoint, put: { _, _, _ in })
        await #expect(throws: CubbyAPIError.self) {
            _ = try await first.upload([selected], runID: "RUN-TEST", performLocalAnalysis: false)
        }
        let second = PhotoImportRunUploader(
            client: try makeClient(), checkpointURL: checkpoint,
            put: { _, _, _ in }, analyze: { input in fakeAnalysis(for: input.id) })
        _ = try await second.recover()
        let finalized = try #require(script.requests(matching: "/photoImport/finalize").last)
        let facts = try #require(finalized.fields["images"]?.arrayValue?.first?["library"])
        #expect(facts["capturedAt"]?.stringValue != nil)
        #expect(facts["capturedAtOffsetMinutes"]?.doubleValue == -420)
        #expect(facts["location"]?["lat"]?.doubleValue == 10)
    }

    @Test func appendAdmissionOffsetSurvivesRecovery() async throws {
        defer { PhotoImportRunUploaderStub.handler.withLock { $0 = nil } }
        let script = RunUploaderScript(admissionOffset: 40)
        script.failNextFinalizeCall()
        PhotoImportRunUploaderStub.handler.withLock { $0 = script.handler }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let checkpoint = directory.appendingPathComponent("import.json")
        let photos = try [photo("first"), photo("second")]
        let first = PhotoImportRunUploader(
            client: try makeClient(), checkpointURL: checkpoint, put: { _, _, _ in })
        await #expect(throws: CubbyAPIError.self) {
            _ = try await first.upload(photos, runID: "RUN-TEST", performLocalAnalysis: false)
        }
        let restored = PhotoImportRunUploader(
            client: try makeClient(), checkpointURL: checkpoint,
            put: { _, _, _ in }, analyze: { input in fakeAnalysis(for: input.id) })
        _ = try await restored.recover()
        let positions = script.requests(matching: "/photoImport/finalize").flatMap {
            ($0.fields["images"]?.arrayValue ?? []).compactMap { $0["position"]?.doubleValue }
        }
        #expect(positions == [40, 41, 40, 41])
        #expect(script.requests(matching: "/photoImport/admitBatch").count == 1)
    }

    /// The headless path has no journal URL; creating and sealing must still use the same
    /// durable batch identity supplied by the caller.
    @Test func newRunUsesSameBatchIdentityWithoutCheckpoint() async throws {
        defer { PhotoImportRunUploaderStub.handler.withLock { $0 = nil } }
        let script = RunUploaderScript()
        PhotoImportRunUploaderStub.handler.withLock { $0 = script.handler }
        let batchID = UUID().uuidString
        let uploader = PhotoImportRunUploader(
            client: try makeClient(), put: { _, _, _ in }, analyze: { input in fakeAnalysis(for: input.id) })
        _ = try await uploader.upload(
            [try photo("headless")],
            createRun: .init(processor: .cubby, clientBatchId: batchID, imageCount: 1),
            performLocalAnalysis: false)
        let seal = try #require(script.requests(matching: "/photoImport/sealBatch").first)
        #expect(seal.fields["clientBatchId"]?.stringValue == batchID)
        #expect(script.requests(matching: "/photoImport/admitBatch").isEmpty)
    }

    @Test @MainActor func sessionRetryRetainsNewRunDetailsAfterCreationFails() async throws {
        defer { PhotoImportRunUploaderStub.handler.withLock { $0 = nil } }
        let script = RunUploaderScript()
        script.failNextCreateRunCall()
        PhotoImportRunUploaderStub.handler.withLock { $0 = script.handler }
        let photos = try [photo("retry")]
        let session = PhotoImportRunSession(
            uploader: PhotoImportRunUploader(
                client: try makeClient(), put: { _, _, _ in },
                analyze: { input in fakeAnalysis(for: input.id) }))

        session.start(
            photos,
            createRun: PhotoImportCreateRunInput(
                processor: .cubby, clientBatchId: UUID().uuidString, imageCount: photos.count))
        #expect(session.progress.total == 1)
        await session.idle()
        #expect(session.canRetry)

        session.start(photos)
        await session.idle()
        #expect(session.phase == .complete)
        #expect(session.runID == "RUN-TEST")
        #expect(script.requests(matching: "/photoImport/createRun").count == 2)
    }

    @Test @MainActor func sessionCanFinishUploadingWhileAnalysisContinues() async throws {
        defer { PhotoImportRunUploaderStub.handler.withLock { $0 = nil } }
        let script = RunUploaderScript()
        PhotoImportRunUploaderStub.handler.withLock { $0 = script.handler }
        let gate = Gate()
        let session = PhotoImportRunSession(
            uploader: PhotoImportRunUploader(
                client: try makeClient(), put: { _, _, _ in },
                analyze: { input in
                    await gate.hold()
                    return fakeAnalysis(for: input.id)
                }))

        session.start([try photo("slow-analysis")], runID: "RUN-TEST")
        await gate.arrivals(1)
        await observe { session.phase == .complete }
        #expect(session.runID == "RUN-TEST")
        #expect(session.progress.uploaded == 1)
        #expect(session.progress.analyzed == 0)
        #expect(script.analysisCallCount(forImageID: "IMG-slow-analysis") == 0)

        gate.open()
        await session.idle()
        #expect(script.analysisCallCount(forImageID: "IMG-slow-analysis") == 1)
    }

    /// The server caps `finalize` at 100 images per call; the uploader must chunk the ordered
    /// selection accordingly while keeping each photo's `position` its index in the *original*
    /// selection, not an index reset per chunk.
    @Test func chunksBy100PreservingGlobalPositions() async throws {
        defer { PhotoImportRunUploaderStub.handler.withLock { $0 = nil } }
        let script = RunUploaderScript()
        PhotoImportRunUploaderStub.handler.withLock { $0 = script.handler }

        let photos = try (0..<130).map { try photo("p\($0)") }
        let uploader = PhotoImportRunUploader(
            client: try makeClient(), put: { _, _, _ in },
            analyze: { input in fakeAnalysis(for: input.id) })

        let runID = try await uploader.upload(photos, runID: "RUN-TEST")
        #expect(runID == "RUN-TEST")

        let stageRequests = script.requests(matching: "/photoImport/stage")
        let finalizeRequests = script.requests(matching: "/photoImport/finalize")
        #expect(stageRequests.count == 2)
        #expect(finalizeRequests.count == 2)
        #expect(finalizeRequests[0].fields["images"]?.arrayValue?.count == 100)
        #expect(finalizeRequests[1].fields["images"]?.arrayValue?.count == 30)

        let allImages = finalizeRequests.flatMap { $0.fields["images"]?.arrayValue ?? [] }
        let positions = allImages.compactMap { $0["position"]?.doubleValue.map(Int.init) }.sorted()
        #expect(positions == Array(0..<130))

        // Global order, not per-chunk: photo "p105" is the 106th selected, so its position must be
        // 105 regardless of which chunk (the second) carried it.
        let position105 = allImages.first { $0["imageId"]?.stringValue == "IMG-p105" }?["position"]?
            .doubleValue
        #expect(position105 == 105)

        let finalProgress = await uploader.progress
        #expect(finalProgress.uploaded == 130)
    }

    /// `finalize` is idempotent server-side: a retry after a transport error must not re-stage or
    /// re-PUT bytes for photos that already staged, and the retry's finalize response reporting
    /// the ids in `alreadyFinalized` (rather than `finalized`) still counts as success.
    @Test func retryAfterFinalizeFailureSucceedsViaAlreadyFinalizedReplay() async throws {
        defer { PhotoImportRunUploaderStub.handler.withLock { $0 = nil } }
        let script = RunUploaderScript()
        PhotoImportRunUploaderStub.handler.withLock { $0 = script.handler }
        script.failNextFinalizeCall()

        let photos = try [photo("a"), photo("b")]
        let uploader = PhotoImportRunUploader(
            client: try makeClient(), put: { _, _, _ in },
            analyze: { input in fakeAnalysis(for: input.id) })

        await #expect(throws: CubbyAPIError.self) {
            _ = try await uploader.upload(photos, runID: "RUN-TEST")
        }
        // Staged once; the failed finalize must not have discarded the staged upload state.
        #expect(script.requests(matching: "/photoImport/stage").count == 1)
        #expect(script.requests(matching: "/photoImport/finalize").count == 1)
        var progress = await uploader.progress
        #expect(progress.uploaded == 0)
        #expect(progress.failedIDs == ["a", "b"])

        // Retry: same photos, no re-stage, the second finalize call succeeds via the replay path.
        let runID = try await uploader.upload(photos, runID: "RUN-TEST")
        #expect(runID == "RUN-TEST")
        #expect(script.requests(matching: "/photoImport/stage").count == 1)
        #expect(script.requests(matching: "/photoImport/finalize").count == 2)
        progress = await uploader.progress
        #expect(progress.uploaded == 2)
        #expect(progress.failedIDs.isEmpty)
    }

    /// Background analysis posts each image's result exactly once, and a repeat `upload(_:)` call
    /// for photos already analyzed (a resumed session, or a caller re-driving the same batch) must
    /// not post it again.
    @Test func analysisIsPostedOncePerImage() async throws {
        defer { PhotoImportRunUploaderStub.handler.withLock { $0 = nil } }
        let script = RunUploaderScript()
        PhotoImportRunUploaderStub.handler.withLock { $0 = script.handler }

        let photos = try [photo("x"), photo("y"), photo("z")]
        let counter = Mutex<Int>(0)
        let uploader = PhotoImportRunUploader(
            client: try makeClient(), put: { _, _, _ in },
            analyze: { input in
                counter.withLock { $0 += 1 }
                return fakeAnalysis(for: input.id)
            })

        _ = try await uploader.upload(photos, runID: "RUN-TEST")
        #expect(counter.withLock { $0 } == 3)
        for id in ["x", "y", "z"] {
            #expect(script.analysisCallCount(forImageID: "IMG-\(id)") == 1)
        }

        // Re-driving the same batch (e.g. a UI retry after the run otherwise completed) must not
        // re-analyze or re-post photos already recorded.
        _ = try await uploader.upload(photos, runID: "RUN-TEST")
        #expect(counter.withLock { $0 } == 3)
        for id in ["x", "y", "z"] {
            #expect(script.analysisCallCount(forImageID: "IMG-\(id)") == 1)
        }
    }

    /// A successfully analyzed photo reports `queued` (entering the analysis queue) then `running`
    /// (`analyzeOne` starting) and never `completed` — the server already marks that target
    /// completed when `recordImageAnalysis` succeeds, so the device-side report would be redundant.
    @Test func reportsQueuedThenRunningForSuccessfulAnalysis() async throws {
        defer { PhotoImportRunUploaderStub.handler.withLock { $0 = nil } }
        let script = RunUploaderScript()
        PhotoImportRunUploaderStub.handler.withLock { $0 = script.handler }

        let uploader = PhotoImportRunUploader(
            client: try makeClient(), put: { _, _, _ in },
            analyze: { input in fakeAnalysis(for: input.id) })

        _ = try await uploader.upload([try photo("ok")], runID: "RUN-TEST")
        // Reports are fire-and-forget; the upload returns before they land.
        await uploader.reportsSettled()

        let reports = script.deviceWorkReports(forImageID: "IMG-ok")
        #expect(reports.map(\.state) == ["queued", "running"])
        #expect(reports.allSatisfy { $0.error == nil })
    }

    /// A photo whose local analysis throws reports `queued`, `running`, then `failed` with a
    /// short, non-empty error description — and the failure is recorded locally (`progress`)
    /// without the uploader itself throwing, matching `analyzeOne`'s best-effort catch.
    @Test func reportsFailedWithErrorDescriptionWhenAnalysisThrows() async throws {
        defer { PhotoImportRunUploaderStub.handler.withLock { $0 = nil } }
        let script = RunUploaderScript()
        PhotoImportRunUploaderStub.handler.withLock { $0 = script.handler }
        enum TestFailure: Error { case boom }

        let uploader = PhotoImportRunUploader(
            client: try makeClient(), put: { _, _, _ in },
            analyze: { _ in throw TestFailure.boom })

        let runID = try await uploader.upload([try photo("bad")], runID: "RUN-TEST")
        #expect(runID == "RUN-TEST")
        await uploader.reportsSettled()

        let reports = script.deviceWorkReports(forImageID: "IMG-bad")
        #expect(reports.map(\.state) == ["queued", "running", "failed"])
        let failureError = reports.last?.error
        #expect(failureError != nil && !(failureError ?? "").isEmpty)
        #expect((failureError ?? "").count < 200)

        let progress = await uploader.progress
        #expect(progress.failedIDs == ["bad"])
        #expect(progress.analyzed == 0)
    }

    /// A `reportDeviceWork` call that itself fails (transport error or non-2xx) must never abort
    /// or fail the analysis it is reporting on: this is the "best-effort, never blocks the
    /// pipeline" contract, exercised by making every device-work report 500 and confirming
    /// analysis still completes and posts the real result.
    @Test func deviceWorkReportFailureDoesNotBreakAnalysis() async throws {
        defer { PhotoImportRunUploaderStub.handler.withLock { $0 = nil } }
        let script = RunUploaderScript()
        script.failDeviceWorkReportsAlways()
        PhotoImportRunUploaderStub.handler.withLock { $0 = script.handler }

        let uploader = PhotoImportRunUploader(
            client: try makeClient(), put: { _, _, _ in },
            analyze: { input in fakeAnalysis(for: input.id) })

        let runID = try await uploader.upload([try photo("resilient")], runID: "RUN-TEST")
        #expect(runID == "RUN-TEST")

        let progress = await uploader.progress
        #expect(progress.analyzed == 1)
        #expect(progress.failedIDs.isEmpty)
        #expect(script.analysisCallCount(forImageID: "IMG-resilient") == 1)
    }
}
