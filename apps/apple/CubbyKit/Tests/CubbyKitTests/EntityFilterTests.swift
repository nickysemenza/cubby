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

/// The generated `listPage`/`timeline` arms map every query-parameter schema shape in the HTTP
/// document onto the typed query; these pin the wire form each shape produces, one row per shape
/// the classifier covers (`scripts/generator/http-api/swift-operations.ts`).
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

    /// The query items of the one request `body` sends, as `name=value` pairs in request order.
    private func queryItems(_ body: (CubbyClient) async throws -> Void) async throws -> [String] {
        defer { FilterStub.handler.withLock { $0 = nil } }
        let seen = Mutex<[URL]>([])
        FilterStub.handler.withLock { handler in
            handler = { request in
                if let url = request.url { seen.withLock { $0.append(url) } }
                return (200, Self.emptyPage)
            }
        }
        try await body(try makeClient())
        let urls = seen.withLock { $0 }
        #expect(urls.count == 1)
        let components = try #require(
            urls.first.flatMap { URLComponents(url: $0, resolvingAgainstBaseURL: false) })
        return (components.queryItems ?? []).map { "\($0.name)=\($0.value ?? "")" }
    }

    struct Row: Sendable {
        let shape: String
        let entity: EntityKey
        let wire: String
        let value: EntityFilterValue
        let expected: [String]
    }

    static let rows: [Row] = [
        Row(
            shape: "string", entity: .product, wire: "nameFilter", value: .single("pan"),
            expected: ["nameFilter=pan"]),
        Row(
            shape: "number", entity: .product, wire: "expectedQuantityMin", value: .single("1.5"),
            expected: ["expectedQuantityMin=1.5"]),
        Row(
            shape: "integer", entity: .product, wire: "expenseCountMin", value: .single("2"),
            expected: ["expenseCountMin=2"]),
        Row(
            shape: "boolean", entity: .product, wire: "taskOpenOnly", value: .single("true"),
            expected: ["taskOpenOnly=true"]),
        Row(
            shape: "string enum", entity: .product, wire: "imagePresenceFilter", value: .single("none"),
            expected: ["imagePresenceFilter=none"]),
        Row(
            shape: "array<string>", entity: .product, wire: "tagFilters", value: .many(["a", "b"]),
            expected: ["tagFilters=a", "tagFilters=b"]),
        Row(
            shape: "array<enum>", entity: .product, wire: "categoryFeatureFilter",
            value: .many(["food", "tools"]),
            expected: ["categoryFeatureFilter=food", "categoryFeatureFilter=tools"]),
        Row(
            shape: "anyOf[string, const]", entity: .inventory, wire: "productIdFilter",
            value: .single("PRD-2345"), expected: ["productIdFilter=PRD-2345"]),
        Row(
            shape: "array<anyOf[string, const]>", entity: .product, wire: "locationIdFilter",
            value: .many(["LOC-2345", "__unresolvable_entity_filter__"]),
            expected: ["locationIdFilter=LOC-2345", "locationIdFilter=__unresolvable_entity_filter__"]),
        Row(
            shape: "array<anyOf[enum, enum]>", entity: .purchase, wire: "dataGap",
            value: .many(["order_id", "product_image"]),
            expected: ["dataGap=order_id", "dataGap=product_image"]),
        Row(
            shape: "array<string minLength>", entity: .financialAccount, wire: "source",
            value: .many(["chase"]), expected: ["source=chase"]),
    ]

    @Test(arguments: rows)
    func filterLandsOnTheListRoute(row: Row) async throws {
        let items = try await queryItems { client in
            _ = try await client.list(
                EntityCatalog[row.entity], page: 1, pageSize: 50,
                filters: EntityFilterState([row.wire: row.value]))
        }
        let filterItems = items.filter { !$0.hasPrefix("page=") && !$0.hasPrefix("pageSize=") }
        #expect(filterItems == row.expected, Comment(rawValue: row.shape))
    }

    /// A range descriptor binds two (or three) parameters; each travels under its own wire name.
    @Test func rangeWireNamesTravelSeparately() async throws {
        let filter = try #require(EntityCatalog[.ledgerTransfer].filter("date"))
        guard case .range(let from, let to, _) = filter.wire else {
            Issue.record("ledgerTransfer.date is not a range filter")
            return
        }
        let items = try await queryItems { client in
            _ = try await client.list(
                EntityCatalog[.ledgerTransfer],
                filters: EntityFilterState([from: .single("2026-01-01"), to: .single("2026-01-31")]))
        }
        #expect(items.contains("\(from)=2026-01-01"))
        #expect(items.contains("\(to)=2026-01-31"))
    }

    @Test func timelineTakesIdsAndOrderBesideTheListFilters() async throws {
        defer { FilterStub.handler.withLock { $0 = nil } }
        let seen = Mutex<URL?>(nil)
        FilterStub.handler.withLock { handler in
            handler = { request in
                seen.withLock { $0 = request.url }
                let body =
                    #"{"groups":[],"stats":[],"notes":[],"#
                    + #""meta":{"totalCount":0,"pageIndex":0,"pageSize":200}}"#
                return (200, Data(body.utf8))
            }
        }
        let client = try makeClient()
        let timeline = try await client.timeline(
            EntityCatalog[.product],
            filters: EntityFilterState([
                "ids": .many(["PRD-2345"]), "order": .single("desc"), "tagFilters": .single("a"),
            ]))
        #expect(timeline.groups.isEmpty)
        let url = try #require(seen.withLock { $0 })
        #expect(url.path.hasSuffix("/products/timeline"))
        let items = Set(
            (URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []).map {
                "\($0.name)=\($0.value ?? "")"
            })
        #expect(items == ["ids=PRD-2345", "order=desc", "tagFilters=a"])
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
                EntityCatalog[.product], filters: EntityFilterState(["nope": .single("x")]))
        }
        await #expect(throws: EntityFilterError.self) {
            _ = try await client.list(
                EntityCatalog[.product], filters: EntityFilterState(["imagePresenceFilter": .single("maybe")])
            )
        }
        await #expect(throws: EntityFilterError.self) {
            _ = try await client.list(
                EntityCatalog[.product], filters: EntityFilterState(["expenseCountMin": .single("two")]))
        }
    }
}
