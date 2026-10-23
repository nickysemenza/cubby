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

/// The shared operation route carries every input as JSON in a POST envelope. These pin that
/// shape through `CubbyClient`'s public surface, so a regression is one a real call site would hit.
@Suite("CubbyClient operation wire shape", .serialized)
struct ClientQueryTests {
    private func makeClient() throws -> CubbyClient {
        let store = InMemorySessionTokenStore()
        try store.save(.bearer("tok"), for: "localhost:3000")
        let credentials = CredentialProvider(host: "localhost:3000", store: store)
        return CubbyClient(
            baseURL: URL(string: "http://localhost:3000")!, credentials: credentials,
            session: QueryStub.session())
    }

    /// `capture` for a POST whose JSON body is the contract: the request and its decoded body.
    private func captureBody(returning payload: Data, _ body: (CubbyClient) async throws -> Void)
        async throws -> (request: URLRequest, body: JSONValue)
    {
        defer { QueryStub.handler.withLock { $0 = nil } }
        let seen = Mutex<(URLRequest, Data?)?>(nil)
        QueryStub.handler.withLock { handler in
            handler = { request in
                seen.withLock { $0 = (request, try? Self.requestBody(request)) }
                return (200, payload)
            }
        }
        try await body(try makeClient())
        let (request, data) = try #require(seen.withLock { $0 })
        #expect(request.httpMethod == "POST")
        let envelope = try JSONDecoder().decode(JSONValue.self, from: try #require(data))
        let operation = request.url?.lastPathComponent
        #expect(envelope["operation"]?.stringValue == operation)
        return (request, try #require(envelope["input"]))
    }

    private static func requestBody(_ request: URLRequest) throws -> Data {
        if let body = request.httpBody { return body }
        let stream = try #require(request.httpBodyStream)
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        // The Darwin transport writes this bound stream asynchronously. Read blocks until
        // bytes or EOF; `hasBytesAvailable` can still be false before the writer's first chunk.
        while true {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count < 0 { throw stream.streamError ?? URLError(.cannotDecodeRawData) }
            if count == 0 { break }
            data.append(contentsOf: buffer.prefix(count))
        }
        return data
    }

    /// Adoption must remain one atomic bulk write through the catalog, with duplicate bins
    /// removed before submission and the server's changed-row count preserved.
    @Test func adoptionUsesGenericBulkUpdate() async throws {
        let (request, body) = try await captureBody(
            returning: Data(
                #"{"action":"bulkUpdate","entity":"location","updatedReferences":[{"entity":"location","id":"LOC-2345"}],"sideEffects":{}}"#
                    .utf8)
        ) { client in
            let count = try await client.adopt(
                [LocationCode("LOC-2345"), LocationCode("LOC-2345")], into: LocationCode("LOC-3456"))
            #expect(count == 1)
        }
        #expect(request.url?.path == "/api/operations/entity.mutate")
        #expect(body["action"]?.stringValue == "bulkUpdate")
        #expect(body["entity"]?.stringValue == "location")
        #expect(body["ids"] == .array([.string("LOC-2345")]))
        #expect(body["data"] == .object(["parentId": .string("LOC-3456")]))
    }

    /// An explicit null moves a location to the root; omitting parentId would leave it unchanged.
    @Test func bulkUpdatePreservesExplicitRootParent() async throws {
        let (request, body) = try await captureBody(
            returning: Data(
                #"{"action":"bulkUpdate","entity":"location","updatedReferences":[{"entity":"location","id":"LOC-2345"}],"sideEffects":{}}"#
                    .utf8)
        ) { client in
            let count = try await client.bulkUpdate(
                EntityCatalog[.location], ids: ["LOC-2345"], data: ["parentId": .null])
            #expect(count == 1)
        }
        #expect(request.url?.path == "/api/operations/entity.mutate")
        #expect(body["action"]?.stringValue == "bulkUpdate")
        #expect(body["entity"]?.stringValue == "location")
        #expect(body["data"] == .object(["parentId": .null]))
    }

    @Test func relationRowsSendsTargetedPagination() async throws {
        let (request, body) = try await captureBody(
            returning: Data(
                #"{"entity":"purchase","relation":"products","id":"PUR-2345","items":[],"totalCount":0}"#.utf8
            )
        ) { client in
            let result = try await client.relationRows(
                source: EntityRef(entity: .purchase, id: "PUR-2345"), relation: "products",
                targetIDs: ["PRD-3456"], offset: 3, limit: 7)
            #expect(result["totalCount"]?.doubleValue == 0)
        }
        #expect(request.url?.path == "/api/operations/entity.relation")
        #expect(request.url?.query == nil)
        #expect(body["entity"] == "purchase")
        #expect(body["relation"] == "products")
        #expect(body["id"] == "PUR-2345")
        #expect(body["targetIds"] == ["PRD-3456"])
        #expect(body["offset"] == 3)
        #expect(body["limit"] == 7)
    }

    @Test func auditHistoryUsesTypedPagedRead() async throws {
        let (request, body) = try await captureBody(
            returning: Data(#"{"entries":[],"nextCursor":"page-3"}"#.utf8)
        ) {
            client in
            let page = try await client.auditHistory(cursor: "page-2", limit: 7)
            #expect(page.entries.isEmpty)
            #expect(page.nextCursor == "page-3")
        }
        #expect(request.url?.path == "/api/operations/auditLog.list")
        #expect(request.url?.query == nil)
        #expect(body["cursor"] == "page-2")
        #expect(body["limit"] == 7)
    }

    /// An attach patch's `data` carries only `pendingImageIds`: an omitted field means "leave as
    /// is", so attaching a photo must never clear the entry's content.
    @Test func attachmentPatchesPreserveContent() async throws {
        defer { QueryStub.handler.withLock { $0 = nil } }
        let seen = Mutex<[[String: JSONValue]]>([])
        QueryStub.handler.withLock { handler in
            handler = { request in
                do {
                    let envelope = try JSONDecoder().decode(
                        JSONValue.self, from: Self.requestBody(request))
                    let fields = try #require(envelope["input"]?.objectValue)
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
        #expect(
            requests[0] == [
                "action": "update", "entity": "gardenEntry", "id": "GDE-2345",
                "data": ["pendingImageIds": .array([.string("IMG-2345")])],
            ])
    }

    /// A 1-based native page travels as the kernel's 0-based `pageIndex`, and `-name` as a
    /// typed descending sort in the JSON operation input.
    @Test func listSendsJsonPagingInputWithTheBearerHeader() async throws {
        let (request, body) = try await captureBody(
            returning: try Fixtures.data(named: "products-list.json")
        ) { client in
            _ = try await client.list(EntityCatalog[.product], page: 1, pageSize: 20, sort: "-name")
        }
        #expect(request.url?.path == "/api/operations/entity.list")
        #expect(request.url?.query == nil)
        #expect(
            body == [
                "entity": "product", "filters": [:], "pagination": ["pageIndex": 0, "pageSize": 20],
                "sort": [["orderBy": "name", "direction": "desc"]],
            ])
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer tok")
    }

    /// A missing row is represented as nullable `data`, with the normal success status.
    @Test func rowReturnsNilFromNullableData() async throws {
        defer { QueryStub.handler.withLock { $0 = nil } }
        QueryStub.handler.withLock { handler in
            handler = { _ in (200, Data("null".utf8)) }
        }
        let row = try await makeClient().row(EntityCatalog[.product], id: "PRD-0000")
        #expect(row == nil)
    }

    /// The enum filter travels as a JSON string literal.
    @Test func stockedProductsSendsTheEnumFilterAsAPlainLiteral() async throws {
        let (request, body) = try await captureBody(
            returning: try Fixtures.data(named: "products-list.json")
        ) { client in
            _ = try await client.stockedProducts(page: 2, pageSize: 20)
        }
        #expect(request.url?.path == "/api/operations/entity.list")
        #expect(body["pagination"] == ["pageIndex": 1, "pageSize": 20])
        #expect(body["filters"] == ["relatedInventoryPresenceFilter": "has"])
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
            "sideEffects": [:],
        ])
        let seen = Mutex<(path: String, body: [String: JSONValue])?>(nil)
        QueryStub.handler.withLock { handler in
            handler = { request in
                let envelope = try? JSONDecoder().decode(JSONValue.self, from: Self.requestBody(request))
                let fields = envelope?["input"]?.objectValue
                if let fields {
                    seen.withLock { $0 = (request.url?.path ?? "", fields) }
                }
                return (200, response)
            }
        }

        let destination = try await makeClient().moveInventory("INV-1001", to: "LOC-1001")

        #expect(destination == EntityRef(entity: .inventory, id: "INV-2002"))
        let request = try #require(seen.withLock { $0 })
        #expect(request.path == "/api/operations/inventory.moveEntries")
        #expect(
            request.body["items"]
                == .array([
                    .object([
                        "inventoryEntryId": .string("INV-1001"),
                        "targetLocationId": .string("LOC-1001"),
                    ])
                ]))
    }

    @Test func searchSendsEntityKindsAsAJsonArray() async throws {
        // An empty result page: only the outgoing request matters here, and `search-find.json`
        // (built for `SearchHitTests`'s lenient decode of an unknown `entityKind`) would fail the
        // real typed decode this call makes.
        let (request, body) = try await captureBody(returning: Data("[]".utf8)) { client in
            _ = try await client.search("sample", kinds: [.product, .location], limit: 5)
        }
        #expect(request.url?.path == "/api/operations/search.find")
        #expect(request.url?.query == nil)
        #expect(body["query"] == "sample")
        #expect(body["limit"] == 5)
        #expect(body["entityKinds"] == ["product", "location"])
    }
}
