import Foundation
import Synchronization
import Testing

@testable import CubbyKit

private final class ListStub: URLProtocol, @unchecked Sendable {
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

@Suite("GenericEntityListModel", .serialized)
@MainActor
struct GenericEntityListModelTests {
    private func makeClient(credential: CubbyCredential = .bearer("tok")) throws -> CubbyClient {
        let store = InMemorySessionTokenStore()
        try store.save(credential, for: "localhost:3000")
        let credentials = CredentialProvider(host: "localhost:3000", store: store)
        return CubbyClient(
            baseURL: URL(string: "http://localhost:3000")!,
            credentials: credentials,
            session: ListStub.session()
        )
    }

    @Test func loadsProductsIntoRows() async throws {
        defer { ListStub.handler.withLock { $0 = nil } }
        let payload = try Fixtures.data(named: "products-list.json")
        ListStub.handler.withLock { handler in
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

    /// `image` is exactly the case the guard exists for: the kernel roster grants it `.list`
    /// (`EntityCatalog[.image].actions.contains(.list)` is true), but the HTTP document has no
    /// `resources.image.list` route. `GenericEntityListModel.load()` must defer to
    /// `EntityKey.httpActions`, not the kernel roster, or it would fire a request that 404s.
    @Test func unavailableForADescriptorWithoutAnHTTPListRouteNeverHitsTheNetwork() async throws {
        defer { ListStub.handler.withLock { $0 = nil } }
        ListStub.handler.withLock { handler in
            handler = { _ in
                Issue.record("unexpected network call for a descriptor with no HTTP .list route")
                return (500, Data())
            }
        }
        let descriptor = EntityCatalog[.image]
        #expect(descriptor.actions.contains(.list))
        #expect(!descriptor.key.httpActions.contains(.list))

        let model = GenericEntityListModel(descriptor: descriptor, client: try makeClient())
        await model.load()

        #expect(model.phase == .unavailable("No list route for \(descriptor.plural)"))
        #expect(model.rows.isEmpty)
    }
}
