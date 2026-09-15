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
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count < 0 { throw stream.streamError ?? URLError(.cannotDecodeRawData) }
            if count == 0 { break }
            data.append(contentsOf: buffer.prefix(count))
        }
        return data
    }

    @Test func wholeBedCorrectionEncodesNullWhileAttachmentPatchesPreserveContent() async throws {
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
            try await client.updateGardenEntry(
                .init(
                    id: "GDE-2345", locationID: "LOC-2345", plantingID: nil, kind: .observation,
                    observedAt: Date(timeIntervalSince1970: 1_700_000_000), note: nil,
                    harvestAmount: nil, pendingImageIDs: [], removeImageIDs: []))
        }
        await #expect(throws: CubbyAPIError.self) {
            try await client.attachImages(
                [ImageCode("IMG-2345")], to: EntityCatalog[.gardenEntry], id: "GDE-2345")
        }
        let requests = seen.withLock { $0 }
        try #require(requests.count == 2)
        #expect(requests[0]["plantingId"] == JSONValue.null)
        #expect(requests[0]["note"] == JSONValue.null)
        #expect(requests[0]["harvestAmount"] == JSONValue.null)
        #expect(requests[1] == ["pendingImageIds": .array([.string("IMG-2345")])])
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

    /// `GardenModel.create(_:rememberSource:)` makes exactly these two calls when the "remember
    /// that this product grows this crop" toggle is on and the product's current association
    /// differs from the chosen crop: create the planting, then patch the product's association.
    /// This pins the wire shape of both — a regression a real save would hit.
    @Test func rememberedSourceWriteBackSendsCreateThenScopedProductPatch() async throws {
        defer { QueryStub.handler.withLock { $0 = nil } }
        let seen = Mutex<[(path: String, body: [String: JSONValue])]>([])
        QueryStub.handler.withLock { handler in
            handler = { request in
                let fields =
                    (try? JSONDecoder().decode([String: JSONValue].self, from: Self.requestBody(request)))
                    ?? [:]
                seen.withLock { $0.append((path: request.url?.path ?? "", body: fields)) }
                // The test only cares about outgoing request shape; reject before response mapping.
                return (400, Data("{}".utf8))
            }
        }
        let client = try makeClient()
        await #expect(throws: CubbyAPIError.self) {
            try await client.createGardenPlanting(
                .init(
                    ingredientID: "ING-2345", locationID: "LOC-2345", productID: "PRD-2345", status: .growing)
            )
        }
        await #expect(throws: CubbyAPIError.self) {
            try await client.setGardenProduct(id: "PRD-2345", growsIngredientID: "ING-2345")
        }
        let requests = seen.withLock { $0 }
        try #require(requests.count == 2)
        #expect(requests[0].path == "/api/v1/garden/createPlanting")
        #expect(requests[0].body["ingredientId"] == "ING-2345")
        #expect(requests[0].body["sourceProductId"] == "PRD-2345")
        #expect(requests[1].path == "/api/v1/products/PRD-2345")
        #expect(requests[1].body == ["growsIngredientId": "ING-2345"])
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
