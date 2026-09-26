import Foundation
import Synchronization
import Testing

@testable import CubbyKit

/// Captures every request the stub session sees; `CubbyClient` methods make exactly one call
/// each, so the last-seen request is enough.
private final class QueryStub: URLProtocol, @unchecked Sendable {
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

/// `/api/v1` dropped ts-rest's `jsonQuery` convention (quoted, JSON-typed query values) for a
/// plain query-parameter API: scalars travel as their literal string, and an array repeats its
/// key rather than serializing as `["a","b"]`. These pin that shape at the wire, using
/// `CubbyClient`'s own public surface rather than the generated `Client` directly, so a
/// regression here is one a real call site would hit.
@Suite("CubbyClient query wire shape", .serialized)
struct ClientQueryTests {
    private func makeClient() throws -> CubbyClient {
        let store = InMemorySessionTokenStore()
        try store.save(.bearer("tok"), for: "localhost:3000")
        let credentials = CredentialProvider(host: "localhost:3000", store: store)
        return CubbyClient(
            baseURL: URL(string: "http://localhost:3000")!, credentials: credentials,
            session: QueryStub.session())
    }

    private func capture(returning payload: Data, _ body: (CubbyClient) async throws -> Void) async throws
        -> URLRequest
    {
        defer { QueryStub.handler.withLock { $0 = nil } }
        let seen = Mutex<URLRequest?>(nil)
        QueryStub.handler.withLock { handler in
            handler = { request in
                seen.withLock { $0 = request }
                return (200, payload)
            }
        }
        try await body(try makeClient())
        return try #require(seen.withLock { $0 })
    }

    private func queryItems(of request: URLRequest) -> [URLQueryItem] {
        URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems ?? []
    }

    private static func requestBody(_ request: URLRequest) throws -> Data {
        if let body = request.httpBody { return body }
        let stream = try #require(request.httpBodyStream)
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        // OpenAPI's Darwin transport writes this bound stream asynchronously. Read blocks until
        // bytes or EOF; `hasBytesAvailable` can still be false before the writer's first chunk.
        while true {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count < 0 { throw stream.streamError ?? URLError(.cannotDecodeRawData) }
            if count == 0 { break }
            data.append(contentsOf: buffer.prefix(count))
        }
        return data
    }

    @Test func auditHistoryUsesTypedPagedRead() async throws {
        let request = try await capture(returning: Data(#"{"entries":[],"nextCursor":"page-3"}"#.utf8)) {
            client in
            let page = try await client.auditHistory(cursor: "page-2", limit: 7)
            #expect(page.entries.isEmpty)
            #expect(page.nextCursor == "page-3")
        }
        #expect(request.url?.path == "/api/v1/auditLog/list")
        #expect(queryItems(of: request).contains(URLQueryItem(name: "cursor", value: "page-2")))
        #expect(queryItems(of: request).contains(URLQueryItem(name: "limit", value: "7.0")))
    }

    /// An attach patch carries only `pendingImageIds`: an omitted field means "leave as is", so
    /// attaching a photo must never clear the entry's content.
    @Test func attachmentPatchesPreserveContent() async throws {
        defer { QueryStub.handler.withLock { $0 = nil } }
        let seen = Mutex<[[String: JSONValue]]>([])
        QueryStub.handler.withLock { handler in
            handler = { request in
                do {
                    let fields = try JSONDecoder().decode(
                        [String: JSONValue].self, from: Self.requestBody(request))
                    seen.withLock { $0.append(fields) }
                } catch { Issue.record(error) }
                // The test captures request encoding; reject before any response mapping.
                return (400, Data("{}".utf8))
            }
        }
        let client = try makeClient()
        await #expect(throws: CubbyAPIError.self) {
            try await client.attachImages(
                [ImageCode("IMG-2345")], to: EntityCatalog[.gardenEntry], id: "GDE-2345")
        }
        let requests = seen.withLock { $0 }
        try #require(requests.count == 1)
        #expect(requests[0] == ["pendingImageIds": .array([.string("IMG-2345")])])
    }

    @Test func listSendsPlainPagingParamsWithTheBearerHeader() async throws {
        let request = try await capture(returning: try Fixtures.data(named: "products-list.json")) { client in
            _ = try await client.list(EntityCatalog[.product], page: 1, pageSize: 20, sort: "-name")
        }
        #expect(request.url?.path == "/api/v1/products")
        let items = queryItems(of: request)
        #expect(items.contains(URLQueryItem(name: "page", value: "1")))
        #expect(items.contains(URLQueryItem(name: "pageSize", value: "20")))
        // Not `"-name"` (JSON-quoted): the literal string, unadorned.
        #expect(items.contains(URLQueryItem(name: "sort", value: "-name")))
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer tok")
    }

    /// `row(_:id:)` answers a 404 with `nil` rather than throwing.
    @Test func rowReturnsNilOn404() async throws {
        defer { QueryStub.handler.withLock { $0 = nil } }
        let notFound = Data(#"{"code":"NOT_FOUND","message":"No product called PRD-0000"}"#.utf8)
        QueryStub.handler.withLock { handler in
            handler = { _ in (404, notFound) }
        }
        let row = try await makeClient().row(EntityCatalog[.product], id: "PRD-0000")
        #expect(row == nil)
    }

    @Test func stockedProductsSendsTheEnumFilterAsAPlainLiteral() async throws {
        let request = try await capture(returning: try Fixtures.data(named: "products-list.json")) { client in
            _ = try await client.stockedProducts(page: 2, pageSize: 20)
        }
        let items = queryItems(of: request)
        #expect(items.contains(URLQueryItem(name: "page", value: "2")))
        #expect(items.contains(URLQueryItem(name: "pageSize", value: "20")))
        // Not `"has"` (JSON-quoted).
        #expect(items.contains(URLQueryItem(name: "relatedInventoryPresenceFilter", value: "has")))
    }

    @Test func inventoryMoveReturnsTheSurvivingMergedEntry() async throws {
        defer { QueryStub.handler.withLock { $0 = nil } }
        let fixture = try JSONSerialization.jsonObject(
            with: Fixtures.data(named: "inventory-by-location.json"))
        var survivor = try #require((fixture as? [[String: Any]])?.first)
        survivor["id"] = "INV-2002"
        survivor["displayName"] = "Sample Product at Workshop"
        let response = try JSONSerialization.data(withJSONObject: [
            "items": [survivor],
            "sideEffects": ["backgroundBatches": []],
        ])
        let seen = Mutex<(path: String, body: [String: JSONValue])?>(nil)
        QueryStub.handler.withLock { handler in
            handler = { request in
                let fields = try? JSONDecoder().decode(
                    [String: JSONValue].self,
                    from: Self.requestBody(request)
                )
                if let fields {
                    seen.withLock { $0 = (request.url?.path ?? "", fields) }
                }
                return (200, response)
            }
        }

        let destination = try await makeClient().moveInventory("INV-1001", to: "LOC-1001")

        #expect(destination == EntityRef(entity: .inventory, id: "INV-2002"))
        let request = try #require(seen.withLock { $0 })
        #expect(request.path == "/api/v1/inventory/moveEntries")
        #expect(
            request.body["items"]
                == .array([
                    .object([
                        "inventoryEntryId": .string("INV-1001"),
                        "targetLocationId": .string("LOC-1001"),
                    ])
                ]))
    }

    @Test func searchRepeatsTheArrayKeyForEachEntityType() async throws {
        // An empty result page: only the outgoing request matters here, and `search-find.json`
        // (built for `SearchHitTests`'s lenient decode of an unknown `entityType`) would fail the
        // real typed decode this call makes.
        let request = try await capture(returning: Data("[]".utf8)) { client in
            _ = try await client.search("sample", kinds: [.product, .location], limit: 5)
        }
        let items = queryItems(of: request)
        #expect(items.contains(URLQueryItem(name: "query", value: "sample")))
        #expect(items.contains(URLQueryItem(name: "limit", value: "5")))
        // One repeated key, not a single JSON-array-encoded value.
        #expect(items.filter { $0.name == "entityTypes" }.map(\.value) == ["product", "location"])
        #expect(!items.contains { $0.value?.contains("[") == true })
    }
}
