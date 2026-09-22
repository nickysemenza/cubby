import Foundation
import Synchronization
import Testing

@testable import CubbyKit

private final class EntityOperationsStub: URLProtocol, @unchecked Sendable {
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

@Suite("Generated ↔ EntityRow operations", .serialized)
struct EntityOperationsTests {
    private func makeClient() throws -> CubbyClient {
        let store = InMemorySessionTokenStore()
        try store.save(.bearer("tok"), for: "localhost:3000")
        let credentials = CredentialProvider(host: "localhost:3000", store: store)
        return CubbyClient(
            baseURL: URL(string: "http://localhost:3000")!, credentials: credentials,
            session: EntityOperationsStub.session())
    }

    private func stub(_ payload: Data, status: Int = 200) {
        EntityOperationsStub.handler.withLock { handler in
            handler = { _ in (status, payload) }
        }
    }

    /// `EntityDescriptor.getRow`/`.listPage` are per-entity generated switches; this exercises one
    /// switch arm for `product` (via `CubbyClient.row`) end to end through a stubbed typed
    /// response, confirming the JSONValue projection still lands on a valid `EntityRow`.
    @Test func productRowComesBackAsAnEntityRowFromAStubbedTypedGet() async throws {
        defer { EntityOperationsStub.handler.withLock { $0 = nil } }
        stub(try Fixtures.data(named: "product-get.json"))
        let client = try makeClient()
        let row = try #require(await client.row(EntityCatalog[.product], id: "PRD-2345"))
        #expect(row.id == "PRD-2345")
        #expect(row.title == "Sample Product")
        #expect(row.subtitle == "Sample Manufacturer")
    }

    /// The same switch, a different arm: `ledgerParty` has no hand-authored `CubbyClient` method
    /// of its own — this is the whole point of the generic path — so it only ever runs through
    /// `EntityDescriptor.listPage`'s generated case.
    @Test func ledgerPartyRowsComeBackAsEntityRowsFromAStubbedTypedList() async throws {
        defer { EntityOperationsStub.handler.withLock { $0 = nil } }
        let payload = Data(
            """
            {
              "items": [
                { "id": "LPY-2345", "name": "Household", "kind": "household", "displayImages": [],
                  "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z",
                  "dataQuality": { "status": "complete", "score": 100, "facets": [], "gaps": [],
                    "exceptions": [], "relatedGaps": [], "relatedExceptions": [] } }
              ],
              "meta": { "pageIndex": 0, "pageSize": 20, "totalCount": 1 }
            }
            """.utf8
        )
        stub(payload)
        let client = try makeClient()
        let page = try await client.list(EntityCatalog[.ledgerParty])
        #expect(page.items.count == 1)
        #expect(page.items[0].id == "LPY-2345")
        #expect(page.items[0].title == "Household")
        #expect(page.meta.totalCount == 1)
    }

    /// `CubbyClient.row` translates a 404 into `nil`; every other status still throws.
    @Test func rowReturnsNilOn404() async throws {
        defer { EntityOperationsStub.handler.withLock { $0 = nil } }
        let notFound = Data(
            """
            {"code":"NOT_FOUND","message":"No product called PRD-0000"}
            """.utf8
        )
        stub(notFound, status: 404)
        let client = try makeClient()
        let row = try await client.row(EntityCatalog[.product], id: "PRD-0000")
        #expect(row == nil)
    }

    /// Image reads use declared typed RPCs rather than pretending the resource document exposes
    /// list/get. Resource update remains native; resource delete remains intentionally absent
    /// from the generated client.
    @Test func imageRPCReadsAreNativeWithoutClaimingResourceActions() {
        #expect(!EntityKey.image.httpActions.contains(.list))
        #expect(!EntityKey.image.httpActions.contains(.get))
        #expect(EntityKey.image.httpActions.contains(.update))
        #expect(EntityKey.image.httpActions.contains(.delete))
        #expect(EntityKey.image.nativeActions == [.get, .list, .update])
        #expect(EntityKey.product.nativeActions.isSubset(of: EntityKey.product.httpActions))
        #expect(!EntityKey.product.nativeActions.contains(.delete))
    }
}
