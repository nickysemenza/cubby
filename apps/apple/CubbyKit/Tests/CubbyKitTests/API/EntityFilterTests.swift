import Foundation
import Synchronization
import Testing

@testable import CubbyKit

private final class FilterStub: URLProtocol, @unchecked Sendable {
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

/// `listPage`/`timeline` re-nest each flat filter name under the kernel body's `filters` and
/// type its value from `Generated/entity-kernel.json`; these pin the JSON each parameter kind
/// produces, one row per kind the catalog declares
/// (`apps/web/generator/http-api/entity-kernel.ts`).
@Suite("Entity filters on the wire", .serialized)
struct EntityFilterTests {
    private static let emptyPage = Data(
        #"{"items":[],"meta":{"pageIndex":0,"pageSize":50,"totalCount":0}}"#.utf8)

    private func makeClient() throws -> CubbyClient {
        let store = InMemorySessionTokenStore()
        try store.save(.bearer("tok"), for: "localhost:3000")
        let credentials = CredentialProvider(host: "localhost:3000", store: store)
        return CubbyClient(
            baseURL: URL(string: "http://localhost:3000")!, credentials: credentials,
            session: FilterStub.session())
    }

    /// The JSON body of the one request `body` sends, answered with `response`.
    private func requestBody(
        answering response: Data = emptyPage, path: String = "/api/v1/entity/list",
        _ body: (CubbyClient) async throws -> Void
    ) async throws -> JSONValue {
        defer { FilterStub.handler.withLock { $0 = nil } }
        let seen = Mutex<[(method: String?, path: String, body: Data?)]>([])
        FilterStub.handler.withLock { handler in
            handler = { request in
                seen.withLock {
                    $0.append((request.httpMethod, request.url?.path ?? "", try? Self.bodyData(request)))
                }
                return (200, response)
            }
        }
        try await body(try makeClient())
        let requests = seen.withLock { $0 }
        #expect(requests.count == 1)
        let request = try #require(requests.first)
        #expect(request.method == "POST")
        #expect(request.path == path)
        return try JSONDecoder().decode(JSONValue.self, from: try #require(request.body))
    }

    private static func bodyData(_ request: URLRequest) throws -> Data {
        if let body = request.httpBody { return body }
        let stream = try #require(request.httpBodyStream)
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while true {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count < 0 { throw stream.streamError ?? URLError(.cannotDecodeRawData) }
            if count == 0 { break }
            data.append(contentsOf: buffer.prefix(count))
        }
        return data
    }

    struct Row: Sendable {
        let shape: String
        let entity: EntityKey
        let wire: String
        let value: [String]
        /// The whole `filters` object the list body carries.
        let expected: JSONValue
    }

    static let rows: [Row] = [
        Row(
            shape: "string", entity: .product, wire: "nameFilter", value: ["pan"],
            expected: ["nameFilter": "pan"]),
        Row(
            shape: "number", entity: .product, wire: "expectedQuantityMin", value: ["1.5"],
            expected: ["expectedQuantityMin": 1.5]),
        Row(
            shape: "integer", entity: .product, wire: "expenseCountMin", value: ["2"],
            expected: ["expenseCountMin": 2]),
        Row(
            shape: "boolean", entity: .product, wire: "taskOpenOnly", value: ["true"],
            expected: ["taskOpenOnly": true]),
        Row(
            shape: "string enum", entity: .product, wire: "imagePresenceFilter", value: ["none"],
            expected: ["imagePresenceFilter": "none"]),
        Row(
            shape: "strings", entity: .product, wire: "tagFilters", value: ["a", "b"],
            expected: ["tagFilters": ["a", "b"]]),
        Row(
            shape: "strings enum", entity: .product, wire: "categoryFeatureFilter",
            value: ["food", "tools"], expected: ["categoryFeatureFilter": ["food", "tools"]]),
        Row(
            shape: "strings id", entity: .inventory, wire: "productIdFilter",
            value: ["PRD-2345"], expected: ["productIdFilter": ["PRD-2345"]]),
        Row(
            shape: "strings with the unresolvable sentinel", entity: .product, wire: "locationIdFilter",
            value: ["LOC-2345", "__unresolvable_entity_filter__"],
            expected: ["locationIdFilter": ["LOC-2345", "__unresolvable_entity_filter__"]]),
        Row(
            shape: "strings enum (union)", entity: .purchase, wire: "dataGap",
            value: ["order_id", "product_image"], expected: ["dataGap": ["order_id", "product_image"]]),
        Row(
            shape: "strings minLength", entity: .financialAccount, wire: "source",
            value: ["synthetic-bank"], expected: ["source": ["synthetic-bank"]]),
        Row(
            shape: "nested", entity: .expense, wire: "projectScopeKinds",
            value: ["garden"], expected: ["projectScope": ["kinds": ["garden"]]]),
    ]

    @Test(arguments: rows)
    func filterLandsOnTheListRoute(row: Row) async throws {
        let body = try await requestBody { client in
            _ = try await client.list(
                EntityCatalog[row.entity], page: 1, pageSize: 50,
                filters: EntityFilterState([row.wire: row.value]))
        }
        #expect(body["entity"] == .string(row.entity.rawValue))
        #expect(body["pagination"] == ["pageIndex": 0, "pageSize": 50])
        #expect(body["filters"] == row.expected, Comment(rawValue: row.shape))
    }

    /// A range descriptor binds two (or three) parameters; each travels under its own name.
    @Test func rangeWireNamesTravelSeparately() async throws {
        let filter = try #require(EntityCatalog[.ledgerTransfer].filter("date"))
        guard case .range(let from, let to, _) = filter.wire else {
            Issue.record("ledgerTransfer.date is not a range filter")
            return
        }
        let body = try await requestBody { client in
            _ = try await client.list(
                EntityCatalog[.ledgerTransfer],
                filters: EntityFilterState([from: ["2026-01-01"], to: ["2026-01-31"]]))
        }
        #expect(body["filters"] == .object([from: "2026-01-01", to: "2026-01-31"]))
    }

    /// The timeline's `ids`, `order`, `from` and `to` land under `window`, beside the list
    /// filters; a list body never accepts them.
    @Test func timelineTakesIdsAndOrderBesideTheListFilters() async throws {
        let response =
            #"{"groups":[],"stats":[],"notes":[],"#
            + #""meta":{"totalCount":0,"pageIndex":0,"pageSize":200}}"#
        let filters = EntityFilterState([
            "ids": ["PRD-2345"], "order": ["desc"], "tagFilters": ["a"],
        ])
        let body = try await requestBody(answering: Data(response.utf8), path: "/api/v1/entity/timeline") {
            client in
            let timeline = try await client.timeline(EntityCatalog[.product], filters: filters)
            #expect(timeline.groups.isEmpty)
        }
        #expect(
            body
                == [
                    "entity": "product", "filters": ["tagFilters": ["a"]],
                    "window": ["ids": ["PRD-2345"], "order": "desc"], "pagination": [:],
                ])

        FilterStub.handler.withLock { handler in
            handler = { _ in
                Issue.record("unexpected network call")
                return (500, Data())
            }
        }
        defer { FilterStub.handler.withLock { $0 = nil } }
        await #expect(throws: EntityFilterError.unknownParameter(.product, "ids")) {
            _ = try await makeClient().list(EntityCatalog[.product], filters: filters)
        }
    }

    /// A wire name outside the route, or a value its enum rejects, fails before any request.
    @Test func invalidFiltersNeverReachTheNetwork() async throws {
        defer { FilterStub.handler.withLock { $0 = nil } }
        FilterStub.handler.withLock { handler in
            handler = { _ in
                Issue.record("unexpected network call")
                return (500, Data())
            }
        }
        let client = try makeClient()
        await #expect(throws: EntityFilterError.unknownParameter(.product, "nope")) {
            _ = try await client.list(
                EntityCatalog[.product], filters: EntityFilterState(["nope": ["x"]]))
        }
        await #expect(throws: EntityFilterError.self) {
            _ = try await client.list(
                EntityCatalog[.product], filters: EntityFilterState(["imagePresenceFilter": ["maybe"]])
            )
        }
        await #expect(throws: EntityFilterError.self) {
            _ = try await client.list(
                EntityCatalog[.product], filters: EntityFilterState(["expenseCountMin": ["two"]]))
        }
    }
}
