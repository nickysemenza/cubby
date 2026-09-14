import CoreGraphics
import CubbyKit
import Foundation
import Synchronization
import Testing

@testable import Cubby

@MainActor
@Suite("Progressive photo matching", .serialized)
struct PhotoMatchStoreTests {
    @Test func incompleteRepairDoesNotBlockSelectedPhotos() async throws {
        let client = try client(
            index: """
                {"algorithmRevision":1,"items":[{"id":"IMG-2345","perceptualHash":null,"sourceFingerprint":null,"width":null,"height":null}],"repair":[{"id":"IMG-2345","url":"https://example.invalid/photo.jpg"}]}
                """)
        let store = PhotoMatchStore()
        let item = try selection(hash: "0123456789abcdef")
        try await store.check([item], client: client)
        #expect(store.hasIndex)
        #expect(store.remainingCount == 1)
        #expect(store.candidates[item.id]?.isEmpty == true)
    }

    @Test func selectedBatchMatchesSurviveIndexRefresh() async throws {
        let client = try client(index: "{\"algorithmRevision\":1,\"items\":[],\"repair\":[]}")
        let store = PhotoMatchStore()
        let first = try selection(hash: "0123456789abcdef")
        let second = try selection(hash: "0123456789abcdef")
        try await store.check([first, second], client: client)
        #expect(store.candidates[first.id]?.isEmpty == true)
        #expect(store.candidates[second.id]?.contains { $0.id.rawValue == "draft:\(first.id)" } == true)
        #expect(store.storedCandidates(for: second.id).isEmpty)
        await store.refresh(client: client)
        #expect(store.candidates[second.id]?.contains { $0.id.rawValue == "draft:\(first.id)" } == true)
    }

    @Test func storedContentAndSourceRecognitionRemainDistinct() async throws {
        let client = try client(
            index: """
                {"algorithmRevision":1,"items":[{"id":"IMG-2345","perceptualHash":"0123456789abcdef","sourceFingerprint":null,"width":2,"height":2},{"id":"IMG-6789","perceptualHash":"fedcba9876543210","sourceFingerprint":{"hash":"0123456789abcdef","aspectRatio":1},"width":2,"height":2}],"repair":[]}
                """)
        let store = PhotoMatchStore()
        let item = try selection(hash: "0123456789abcdef")
        try await store.check([item], client: client)
        #expect(
            store.candidates[item.id]?.contains { $0.id.rawValue == "IMG-2345" && $0.basis == .content }
                == true)
        #expect(
            store.candidates[item.id]?.contains { $0.id.rawValue == "IMG-6789" && $0.basis == .source }
                == true)
        store.reset()
        #expect(!store.hasIndex)
        #expect(store.candidates.isEmpty)
    }

    @Test func incompatibleIndexCannotApproveUploads() async throws {
        let client = try client(index: "{\"algorithmRevision\":2,\"items\":[],\"repair\":[]}")
        let store = PhotoMatchStore()
        do {
            try await store.check([try selection(hash: "0123456789abcdef")], client: client)
            Issue.record("An incompatible revision must fail selected-photo checking")
        } catch {
            #expect(!store.hasIndex)
        }
    }

    @Test func aCachedIndexDoesNotApproveAnIncompatibleRefresh() async throws {
        let client = try client(index: "{\"algorithmRevision\":1,\"items\":[],\"repair\":[]}")
        let store = PhotoMatchStore()
        let item = try selection(hash: "0123456789abcdef")
        try await store.check([item], client: client)
        PhotoMatchTestProtocol.response.withLock {
            $0 = Data("{\"algorithmRevision\":2,\"items\":[],\"repair\":[]}".utf8)
        }
        do {
            try await store.check([item], client: client)
            Issue.record("A cached revision-one index must not approve an incompatible refresh")
        } catch {
            #expect(store.error != nil)
        }
    }

    private func client(index: String) throws -> CubbyClient {
        PhotoMatchTestProtocol.response.withLock { $0 = Data(index.utf8) }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [PhotoMatchTestProtocol.self]
        let store = InMemorySessionTokenStore()
        try store.save(.bearer("test-photos-token"), for: "photos.example.invalid")
        return CubbyClient(
            baseURL: URL(string: "https://photos.example.invalid")!,
            credentials: CredentialProvider(
                host: "photos.example.invalid", store: store),
            session: URLSession(configuration: configuration))
    }

    private func selection(hash: String) throws -> PhotoSelectionItem {
        let image = try #require(
            CGContext(
                data: nil, width: 2, height: 2, bitsPerComponent: 8,
                bytesPerRow: 8, space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)?.makeImage())
        let file = try PhotoFile(
            url: URL(fileURLWithPath: "/unused-test-photo.png"), filename: "fixture.png",
            contentType: "image/png", size: 1, width: 2, height: 2)
        let hash = try PerceptualHash64(hex: hash)
        return PhotoSelectionItem(
            file: file, preview: image,
            query: HashQuery(
                perceptualHash: hash,
                aspectRatio: 1, sourceFingerprint: SourceFingerprint(hash: hash, aspectRatio: 1)))
    }
}

/// The synchronized response belongs only to this serialized suite; it never reaches a network.
nonisolated private final class PhotoMatchTestProtocol: URLProtocol, @unchecked Sendable {
    static let response = Mutex(Data())
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let response = HTTPURLResponse(
            url: request.url!, statusCode: 200, httpVersion: nil,
            headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Self.response.withLock { $0 })
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
