import Foundation
import Synchronization
import Testing

@testable import CubbyKit

/// Per-suite network stub (`Tests/CubbyKitTests/Support/StubURLProtocol.swift`'s doc comment):
/// Swift Testing runs `@Suite` types concurrently even when each is `.serialized`, so a handler
/// shared across suites intermittently answers one suite's request with another's response.
private final class PhotoImportRunUploaderStub: URLProtocol, @unchecked Sendable {
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

/// Routes by path rather than a strict call-order queue: a chunking test alone issues well over a
/// hundred requests (stage/finalize chunks plus one `recordAnalysis` per photo), so scripting every
/// response individually the way `PhotoImportStagerTests`' `RequestScript` does would not scale.
/// `failNextFinalize` lets a single test still control one specific finalize outcome.
private final class RunUploaderScript: @unchecked Sendable {
    struct Seen: Sendable {
        let path: String
        let fields: [String: JSONValue]
    }

    private let seenBox = Mutex<[Seen]>([])
    private let failNextFinalize = Mutex<Bool>(false)
    private let failNextCreateRun = Mutex<Bool>(false)
    private let analysisCalls = Mutex<[String: Int]>([:])

    var seen: [Seen] { seenBox.withLock { $0 } }
    func requests(matching suffix: String) -> [Seen] { seen.filter { $0.path.hasSuffix(suffix) } }
    /// Number of `recordAnalysis` calls seen for one image id, keyed by the id `stage` assigned it
    /// (`"IMG-\(clientId)"` below).
    func analysisCallCount(forImageID imageID: String) -> Int {
        analysisCalls.withLock { $0[imageID] ?? 0 }
    }

    /// The next `finalize` call answers 500 instead of confirming; the call after that (a retry)
    /// reports every requested id in `alreadyFinalized` rather than `finalized`, exercising the
    /// idempotent-replay path a retry after a transport error relies on.
    func failNextFinalizeCall() { failNextFinalize.withLock { $0 = true } }
    func failNextCreateRunCall() { failNextCreateRun.withLock { $0 = true } }

    var handler: StubNetworking.Handler {
        { [self] request in
            let fields =
                (try? JSONDecoder().decode(
                    [String: JSONValue].self, from: Self.body(of: request))) ?? [:]
            let path = request.url?.path ?? ""
            seenBox.withLock { $0.append(Seen(path: path, fields: fields)) }

            if path.hasSuffix("/photoImport/createRun") {
                let shouldFail = failNextCreateRun.withLock { pending in
                    defer { pending = false }
                    return pending
                }
                if shouldFail { return (500, Data(#"{"code":"INTERNAL","message":"try again"}"#.utf8)) }
                return (200, Data(#"{"runId": "RUN-TEST"}"#.utf8))
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

private actor AnalysisGate {
    private var open = false
    private var waiter: CheckedContinuation<Void, Never>?

    func wait() async {
        if open { return }
        await withCheckedContinuation { waiter = $0 }
    }

    func release() {
        open = true
        waiter?.resume()
        waiter = nil
    }
}

@Suite("PhotoImportRunUploader", .serialized)
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

        session.start(photos, createRun: PhotoImportCreateRunInput())
        #expect(session.progress.total == 1)
        while session.isRunning { try await Task.sleep(for: .milliseconds(10)) }
        #expect(session.canRetry)

        session.start(photos)
        while session.isRunning { try await Task.sleep(for: .milliseconds(10)) }
        #expect(session.phase == .complete)
        #expect(session.runID == "RUN-TEST")
        #expect(script.requests(matching: "/photoImport/createRun").count == 2)
    }

    @Test @MainActor func sessionCanFinishUploadingWhileAnalysisContinues() async throws {
        defer { PhotoImportRunUploaderStub.handler.withLock { $0 = nil } }
        let script = RunUploaderScript()
        PhotoImportRunUploaderStub.handler.withLock { $0 = script.handler }
        let gate = AnalysisGate()
        let session = PhotoImportRunSession(
            uploader: PhotoImportRunUploader(
                client: try makeClient(), put: { _, _, _ in },
                analyze: { input in
                    await gate.wait()
                    return fakeAnalysis(for: input.id)
                }))

        session.start([try photo("slow-analysis")], runID: "RUN-TEST")
        for _ in 0..<200 {
            if session.phase == .complete { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        #expect(session.phase == .complete)
        #expect(session.runID == "RUN-TEST")
        #expect(session.progress.uploaded == 1)
        #expect(session.progress.analyzed == 0)
        #expect(script.analysisCallCount(forImageID: "IMG-slow-analysis") == 0)

        await gate.release()
        for _ in 0..<200 {
            if script.analysisCallCount(forImageID: "IMG-slow-analysis") == 1 { break }
            try await Task.sleep(for: .milliseconds(10))
        }
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
}
