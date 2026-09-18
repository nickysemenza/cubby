import Foundation
import Synchronization
import Testing

@testable import CubbyKit

/// `PhotoImportTransaction` never has two in-flight network calls at once (stage, commit, and
/// reconcile are each a single sequential `await`), so a FIFO queue of canned responses is enough
/// to script a whole scenario without routing by path. Unlike `StubNetworking`, this can also
/// script a transport-level failure (`URLError`), needed for the offline B3 case.
private final class PhotoImportStagerStub: URLProtocol, @unchecked Sendable {
    typealias Handler = @Sendable (URLRequest) -> Result<(status: Int, data: Data), URLError>
    static let handler = Mutex<Handler?>(nil)
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        guard let handler = Self.handler.withLock({ $0 }) else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }
        switch handler(request) {
        case .success(let (status, data)):
            let response = HTTPURLResponse(
                url: request.url!, statusCode: status, httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"]
            )!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        case .failure(let error):
            client?.urlProtocol(self, didFailWithError: error)
        }
    }
    override func stopLoading() {}
    static func session() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [PhotoImportStagerStub.self]
        return URLSession(configuration: configuration)
    }
}

/// One scripted response per expected request, consumed in call order; every request's path and
/// decoded JSON body is recorded for later assertions.
private final class RequestScript: @unchecked Sendable {
    private let queue = Mutex<[Result<(status: Int, data: Data), URLError>]>([])
    let seen = Mutex<[(path: String, fields: [String: JSONValue])]>([])

    func push(status: Int, json: String) {
        queue.withLock { $0.append(.success((status, Data(json.utf8)))) }
    }

    func pushFailure(_ code: URLError.Code) {
        queue.withLock { $0.append(.failure(URLError(code))) }
    }

    var handler: PhotoImportStagerStub.Handler {
        { [self] request in
            let fields =
                (try? JSONDecoder().decode(
                    [String: JSONValue].self, from: Self.body(of: request))) ?? [:]
            seen.withLock { $0.append((request.url?.path ?? "", fields)) }
            return queue.withLock { pending in
                guard !pending.isEmpty else { return .success((500, Data("{}".utf8))) }
                return pending.removeFirst()
            }
        }
    }

    /// The OpenAPI Darwin transport writes the request body via a bound stream asynchronously;
    /// `httpBody` is empty until it's read this way (mirrors `ClientQueryTests.requestBody`).
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

@Suite("PhotoImportTransaction recovery", .serialized)
struct PhotoImportStagerTests {
    private func makeClient() throws -> CubbyClient {
        let store = InMemorySessionTokenStore()
        try store.save(.bearer("tok"), for: "localhost:3000")
        let credentials = CredentialProvider(host: "localhost:3000", store: store)
        return CubbyClient(
            baseURL: URL(string: "http://localhost:3000")!, credentials: credentials,
            session: PhotoImportStagerStub.session())
    }

    /// A route whose source and target are both `.product`, so `reconcileAfterAmbiguousCommit`'s
    /// association check has a real `PhotoIngressRoute` to look up.
    private func item(
        clientID: String = "c1", duplicateChoice: PhotoImportDuplicateChoice = .automatic
    ) throws -> PhotoImportBatchItem {
        let file = try PhotoFile.materialize(
            try ImageEncoding.encode(TestImages.canvas(width: 32, height: 24, subject: false), as: .jpeg),
            filename: "\(clientID).jpg")
        let analysis = PhotoLocalAnalysis(
            id: clientID, analyzedAt: Date(timeIntervalSince1970: 0), sha256: "sha-\(clientID)",
            capturedAt: nil, contentType: "image/jpeg", width: 32, height: 24,
            classifications: [], recognizedText: [],
            featurePrint: PhotoFeaturePrint(revision: "1", data: Data()),
            provenance: PhotoAnalysisProvenance(source: .files, filename: "\(clientID).jpg"))
        return PhotoImportBatchItem(
            clientID: clientID, file: file, analysis: analysis, routeID: "product-self",
            sourceEntity: .product, sourceID: "PRD-0001", candidateID: "PRD-0001",
            duplicateChoice: duplicateChoice)
    }

    private func stageUploadResponse(clientID: String, imageID: String) -> String {
        """
        {"items": [{"kind": "upload", "clientId": "\(clientID)", "imageId": "\(imageID)", \
        "uploadUrl": "https://uploads.example/x", "key": "k", "url": "https://images.example/x.jpg"}]}
        """
    }

    private func commitSuccessResponse(imageID: String) -> String {
        """
        {"committedPhotoIds": ["\(imageID)"], "createdDestinations": [], \
        "committedAt": "2026-01-01T00:00:00.000Z"}
        """
    }

    private func reconcileResponse(imageID: String, status: String, missing: [String] = []) -> String {
        let missingJSON = missing.map { "\"\($0)\"" }.joined(separator: ", ")
        if status.isEmpty {
            return """
                {"items": [], "missing": [\(missingJSON)]}
                """
        }
        return """
            {"items": [{"imageId": "\(imageID)", "status": "\(status)", \
            "associations": [{"entityType": "product", "entityId": "PRD-0001", \
            "entityName": "Sample", "role": "attachment"}]}], "missing": [\(missingJSON)]}
            """
    }

    /// B1: a `.reuse` entry that survives a failed attempt must not be resent once the user
    /// switches to "keep both" — it has to re-stage as a fresh upload instead of retrying the
    /// reused (UPLOADED) id, which the server rejects forever.
    @Test func reuseThenKeepBothRestagesInsteadOfResendingTheReusedID() async throws {
        defer { PhotoImportStagerStub.handler.withLock { $0 = nil } }
        let script = RequestScript()
        PhotoImportStagerStub.handler.withLock { $0 = script.handler }

        let transaction = PhotoImportTransaction(client: try makeClient(), put: { _, _, _ in })

        // First attempt: `.reuse(IMG-OLD)` seeds `stagedByClientID` before any network call; the
        // commit itself is rejected with a 4xx whose reason isn't one that triggers reconciliation,
        // so it rethrows immediately and `stagedByClientID` still holds the reused entry.
        script.push(
            status: 409, json: #"{"code": "CONFLICT", "message": "unrelated conflict"}"#)
        let reused = try item(duplicateChoice: .reuse(ImageCode("IMG-OLD")))
        await #expect(throws: CubbyAPIError.self) {
            _ = try await transaction.commit([reused])
        }

        // Second attempt: the user picked "keep both". The stale reused entry must be dropped and
        // re-staged as a new upload, not resent as `IMG-OLD`.
        script.push(status: 200, json: stageUploadResponse(clientID: "c1", imageID: "IMG-NEW"))
        script.push(status: 200, json: commitSuccessResponse(imageID: "IMG-NEW"))
        let keptBoth = try item(duplicateChoice: .keepBoth)
        let committed = try await transaction.commit([keptBoth])
        #expect(committed == ["c1"])

        let requests = script.seen.withLock { $0 }
        #expect(requests.count == 3)
        #expect(requests[1].path.hasSuffix("/stage"))
        let commitImages = try #require(requests[2].fields["images"]?.arrayValue)
        #expect(commitImages.count == 1)
        #expect(commitImages[0]["imageId"]?.stringValue == "IMG-NEW")
        #expect(commitImages[0]["duplicateDecision"]?.stringValue == "keepBoth")
    }

    /// B2: a definite 412 with a reconcilable reason releases the dead staged id instead of
    /// retrying it forever, and a subsequent commit re-stages a fresh upload.
    @Test func preconditionFailedWithMissingReconciliationExpiresTheStagedImage() async throws {
        defer { PhotoImportStagerStub.handler.withLock { $0 = nil } }
        let script = RequestScript()
        PhotoImportStagerStub.handler.withLock { $0 = script.handler }

        let transaction = PhotoImportTransaction(client: try makeClient(), put: { _, _, _ in })
        script.push(status: 200, json: stageUploadResponse(clientID: "c1", imageID: "IMG-1"))
        script.push(
            status: 412,
            json:
                #"{"code": "PRECONDITION_FAILED", "reason": "IMAGE_PRECONDITION_FAILED", "message": "stale"}"#
        )
        script.push(status: 200, json: reconcileResponse(imageID: "IMG-1", status: "", missing: ["IMG-1"]))

        let first = try item()
        do {
            _ = try await transaction.commit([first])
            Issue.record("expected .stagedImagesExpired")
        } catch PhotoImportTransaction.Failure.stagedImagesExpired(let ids) {
            #expect(ids.map(\.rawValue) == ["IMG-1"])
        }

        // The expired entry is gone: a following commit re-stages instead of resending IMG-1.
        script.push(status: 200, json: stageUploadResponse(clientID: "c1", imageID: "IMG-2"))
        script.push(status: 200, json: commitSuccessResponse(imageID: "IMG-2"))
        let committed = try await transaction.commit([first])
        #expect(committed == ["c1"])
        let stagePaths = script.seen.withLock { $0 }.filter { $0.path.hasSuffix("/stage") }
        #expect(stagePaths.count == 2)
    }

    /// B2 negative: the same 412 reason, but reconciliation reports nothing missing — the original
    /// 412 must be rethrown verbatim, never a committed result and never a generic failure.
    @Test func preconditionFailedWithNothingMissingRethrowsTheOriginal412() async throws {
        defer { PhotoImportStagerStub.handler.withLock { $0 = nil } }
        let script = RequestScript()
        PhotoImportStagerStub.handler.withLock { $0 = script.handler }

        let transaction = PhotoImportTransaction(client: try makeClient(), put: { _, _, _ in })
        script.push(status: 200, json: stageUploadResponse(clientID: "c1", imageID: "IMG-1"))
        script.push(
            status: 412,
            json:
                #"{"code": "PRECONDITION_FAILED", "reason": "IMAGE_PRECONDITION_FAILED", "message": "stale"}"#
        )
        script.push(status: 200, json: reconcileResponse(imageID: "IMG-1", status: "PENDING"))

        let first = try item()
        do {
            _ = try await transaction.commit([first])
            Issue.record("expected the original 412 to be rethrown")
        } catch let error as CubbyAPIError {
            #expect(error.status == 412)
            #expect(error.reason == "IMAGE_PRECONDITION_FAILED")
        }
    }

    /// B3: an offline commit and an offline reconcile both surface as `.commitOutcomeUncertain`
    /// (never a dead end); a later successful `reconcile()` remembers the committed ids so a
    /// following `commit()` does not re-POST.
    @Test func offlineCommitBecomesUncertainThenReconcileUnblocksWithoutRePosting() async throws {
        defer { PhotoImportStagerStub.handler.withLock { $0 = nil } }
        let script = RequestScript()
        PhotoImportStagerStub.handler.withLock { $0 = script.handler }

        let transaction = PhotoImportTransaction(client: try makeClient(), put: { _, _, _ in })
        script.push(status: 200, json: stageUploadResponse(clientID: "c1", imageID: "IMG-1"))
        // The commit POST fails at the transport layer (offline); the ensuing reconcile attempt
        // also fails offline, so the ambiguous commit surfaces as `.commitOutcomeUncertain`.
        script.pushFailure(.notConnectedToInternet)
        script.pushFailure(.notConnectedToInternet)

        let first = try item()
        do {
            _ = try await transaction.commit([first])
            Issue.record("expected .commitOutcomeUncertain")
        } catch PhotoImportTransaction.Failure.commitOutcomeUncertain(let ids) {
            #expect(ids.map(\.rawValue) == ["IMG-1"])
        }

        // A later reconcile succeeds and confirms the commit went through.
        script.push(status: 200, json: reconcileResponse(imageID: "IMG-1", status: "UPLOADED"))
        let reconciled = try await transaction.reconcile([first])
        #expect(reconciled == ["c1"])

        let requestCountBeforeRetry = script.seen.withLock { $0 }.count
        let committed = try await transaction.commit([first])
        #expect(committed == ["c1"])
        // `commit(_:)` short-circuits on the already-set `committedClientIDs`: no additional POST.
        #expect(script.seen.withLock { $0 }.count == requestCountBeforeRetry)
    }
}
