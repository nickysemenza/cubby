import Foundation
import Synchronization
import Testing

@testable import CubbyKit

/// A `URLProtocol` stub scoped to this file, mirroring `RawClientTests.StubURLProtocol` but with
/// its own static handler state. Swift Testing schedules independent `@Suite` types concurrently
/// even when each is individually `.serialized`, so sharing one static handler across suites
/// (confirmed empirically while writing these tests) intermittently answers one suite's request
/// with another's stubbed response. A dedicated type per suite removes the shared mutable state
/// entirely instead of relying on ordering.
private final class ListStubURLProtocol: URLProtocol, @unchecked Sendable {
    typealias Handler = @Sendable (URLRequest) -> (Int, Data)
    static let handler = Mutex<Handler?>(nil)

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let handler = Self.handler.withLock({ $0 }) else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }
        let (status, data) = handler(request)
        let response = HTTPURLResponse(
            url: request.url!, statusCode: status, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    static func session() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ListStubURLProtocol.self]
        return URLSession(configuration: configuration)
    }
}

@Suite("GenericEntityListModel", .serialized)
@MainActor
struct GenericEntityListModelTests {
    private func makeClient(credential: CubbyCredential = .bearer("tok")) throws -> CubbyRawClient {
        let store = InMemorySessionTokenStore()
        try store.save(credential, for: "localhost:3000")
        let credentials = CredentialProvider(host: "localhost:3000", store: store)
        return CubbyRawClient(
            baseURL: URL(string: "http://localhost:3000")!,
            credentials: credentials,
            session: ListStubURLProtocol.session()
        )
    }

    @Test func loadsProductsIntoRows() async throws {
        defer { ListStubURLProtocol.handler.withLock { $0 = nil } }
        let payload = try Fixtures.data(named: "products-list.json")
        ListStubURLProtocol.handler.withLock { handler in
            handler = { _ in (200, payload) }
        }
        let model = GenericEntityListModel(descriptor: EntityCatalog[.product], client: try makeClient())
        await model.load()
        #expect(model.phase == .loaded)
        #expect(model.rows.count == 1)
        #expect(model.rows.first?.id == "PRD-2345")
        #expect(model.rows.first?.title == "Sample Product")
        #expect(model.meta?.totalCount == 1)
    }

    @Test func unavailableForADescriptorWithoutListNeverHitsTheNetwork() async throws {
        defer { ListStubURLProtocol.handler.withLock { $0 = nil } }
        ListStubURLProtocol.handler.withLock { handler in
            handler = { _ in
                Issue.record("unexpected network call for a descriptor with no .list action")
                return (500, Data())
            }
        }
        // usda-food's kernel contract carries no actions at all (see EntityCatalog.swift), so it's
        // a stable "definitely has no .list" fixture.
        let descriptor = EntityCatalog[.usdaFood]
        #expect(!descriptor.actions.contains(.list))

        let model = GenericEntityListModel(descriptor: descriptor, client: try makeClient())
        await model.load()

        #expect(model.phase == .unavailable("No list route for \(descriptor.plural)"))
        #expect(model.rows.isEmpty)
    }
}
