import Foundation
import Synchronization
import Testing

@testable import CubbyKit

private final class NativeListStub: URLProtocol, @unchecked Sendable {
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

@Suite("Native list adapters", .timeLimit(.minutes(1)), .serialized)
@MainActor
struct NativeListAdaptersTests {
    private func makeClient() throws -> CubbyClient {
        let store = InMemorySessionTokenStore()
        try store.save(.bearer("tok"), for: "localhost:3000")
        let credentials = CredentialProvider(host: "localhost:3000", store: store)
        return CubbyClient(
            baseURL: URL(string: "http://localhost:3000")!, credentials: credentials,
            session: NativeListStub.session())
    }

    /// Regression: native cookbooks sorted a client-side copy through a hand-kept field allow-list
    /// that threw `invalidValue` for the manifest's `createdAt` sort. Cookbook now reads the
    /// kernel list like every other entity, so a declared sort reaches the server.
    @Test func cookbookListSendsDeclaredSortsToTheServer() async throws {
        defer { NativeListStub.handler.withLock { $0 = nil } }
        let requests = Mutex<[(String, Data?)]>([])
        NativeListStub.handler.withLock { handler in
            handler = { request in
                requests.withLock { $0.append((request.url?.path ?? "", try? Self.requestBody(request))) }
                return (200, Self.pagePayload(Self.cookbooks))
            }
        }

        let descriptor = EntityCatalog[.cookbook]
        let page = try await makeClient().list(
            descriptor, page: 2, pageSize: 1, sort: "updatedAt,-createdAt")

        #expect(page.items.map(\.id) == ["CKB-1", "CKB-2"])
        let (path, body) = try #require(requests.withLock { $0.first })
        #expect(path == "/api/v1/entity/list")
        let input = try JSONDecoder().decode(JSONValue.self, from: try #require(body))
        #expect(input["entity"] == "cookbook")
        #expect(input["pagination"] == ["pageIndex": 1, "pageSize": 1])
        #expect(
            input["sort"]
                == .array([
                    ["orderBy": "updatedAt", "direction": "asc"],
                    ["orderBy": "createdAt", "direction": "desc"],
                ]))
    }

    /// A flat filter name is re-nested and typed from the kernel catalog; an unknown one never
    /// reaches the server.
    @Test func kernelFiltersAreTypedFromTheCatalog() async throws {
        let descriptor = EntityCatalog[.product]
        var filters = EntityFilterState()
        filters.set(.single("has"), for: "imagePresenceFilter")
        filters.set(.single("LOC-AAAA"), for: "locationIdFilter")
        let input = try descriptor.listInput(page: 1, pageSize: 20, sort: nil, filters: filters)
        #expect(input["filters"] == ["imagePresenceFilter": "has", "locationIdFilter": ["LOC-AAAA"]])
        #expect(descriptor.filterValues(for: "imagePresenceFilter") == ["has", "none"])

        filters.set(.single("sometimes"), for: "imagePresenceFilter")
        #expect(throws: EntityFilterError.self) {
            _ = try descriptor.listInput(page: 1, pageSize: 20, sort: nil, filters: filters)
        }
        #expect(throws: EntityFilterError.unknownParameter(.product, "noSuchFilter")) {
            _ = try descriptor.listInput(
                page: 1, pageSize: 20, sort: nil, filters: EntityFilterState(["noSuchFilter": .single("x")]))
        }
    }

    @Test func usdaListKeepsNumericIdentityAndTypedFilters() async throws {
        defer { NativeListStub.handler.withLock { $0 = nil } }
        let body = Mutex<Data?>(nil)
        NativeListStub.handler.withLock { handler in
            handler = { request in
                body.withLock { $0 = try? Self.requestBody(request) }
                return (200, Self.usdaPage)
            }
        }

        var filters = EntityFilterState()
        filters.set(.single("12345"), for: "nameFilter")
        filters.set(.single("branded_food"), for: "dataTypeFilter")
        filters.set(.single("false"), for: "foodsOnly")
        filters.set(.single("true"), for: "linkedProductsOnly")
        let page = try await makeClient().list(
            EntityCatalog[.usdaFood], page: 2, pageSize: 4, sort: "-fdc_id", filters: filters)

        #expect(page.items.map(\.id) == ["12345"])
        #expect(page.items.first?.title == "Numeric food")
        let encoded = try #require(body.withLock { $0 })
        let object = try #require(
            JSONDecoder().decode(JSONValue.self, from: encoded).objectValue)
        let expectedFilters: JSONValue = [
            "nameFilter": "12345",
            "dataTypeFilter": "branded_food",
            "foodsOnly": false,
            "linkedProductsOnly": true,
        ]
        #expect(object["filters"] == expectedFilters)
        #expect(object["pagination"] == ["pageIndex": 1, "pageSize": 4])
    }

    @Test func usdaListPreservesTypedServerErrorsForRetryableScreens() async throws {
        defer { NativeListStub.handler.withLock { $0 = nil } }
        NativeListStub.handler.withLock { handler in
            handler = { _ in
                (
                    503,
                    Data(
                        #"{"code":"USDA_UNAVAILABLE","message":"Food service is unavailable"}"#.utf8)
                )
            }
        }

        do {
            _ = try await makeClient().list(EntityCatalog[.usdaFood])
            Issue.record("Expected the USDA list request to fail")
        } catch let error as CubbyAPIError {
            #expect(error.status == 503)
            #expect(error.detail?.code == "USDA_UNAVAILABLE")
            #expect(error.errorDescription == "Food service is unavailable")
        } catch {
            Issue.record("Expected CubbyAPIError, got \(error)")
        }
    }

    @Test func cookbookDetailUsesTheKernelGetAndUsdaKeepsItsTypedRPC() async throws {
        defer { NativeListStub.handler.withLock { $0 = nil } }
        let urls = Mutex<[URL]>([])
        NativeListStub.handler.withLock { handler in
            handler = { request in
                if let url = request.url { urls.withLock { $0.append(url) } }
                switch request.url?.path {
                case "/api/v1/entity/detail": return (200, Self.cookbookDetailPayload)
                case "/api/v1/usda-food/detail": return (200, Self.usdaDetailPayload)
                default: return (500, Data())
                }
            }
        }

        let client = try makeClient()
        let cookbook = try #require(await client.row(EntityCatalog[.cookbook], id: "CKB-1"))
        #expect(cookbook.id == "CKB-1")
        #expect(cookbook.title == "Alpha Cookbook")

        let food = try #require(await client.row(EntityCatalog[.usdaFood], id: "12345"))
        #expect(food.id == "12345")
        #expect(food.title == "Numeric food")
        #expect(food.raw["id"] == "12345")

        let queryItems = urls.withLock { urls in
            urls.map { URLComponents(url: $0, resolvingAgainstBaseURL: false)?.queryItems ?? [] }
        }
        try #require(queryItems.count == 2)
        #expect(queryItems[1].contains(URLQueryItem(name: "id", value: "12345")))
    }

    nonisolated private static let usdaFood = FoodSummaryWithLinkedProducts(
        fdcId: 12345,
        description: "Numeric food",
        foodInfo: FoodInfo(dataType: .brandedFood, description: "Numeric food"),
        nutritionInfo: NutritionInfo(
            nutrientSummary: [], nutrientsPer100: NutrientsPer100()),
        portionInfoRaw: [], inferredUnitMappings: [], linkedProducts: [])

    nonisolated private static let usdaPage: Data = pagePayload([
        UsdaFoodListRow(
            fdcId: 12345,
            description: "Numeric food",
            foodInfo: FoodInfo(dataType: .brandedFood, description: "Numeric food"),
            nutritionInfo: .init(nutrientsPer100: NutrientsPer100()),
            portionInfoRaw: [], inferredUnitMappings: [], linkedProducts: [])
    ])

    nonisolated private static let usdaDetailPayload: Data = {
        try! JSONEncoder.cubby().encode(usdaFood)
    }()

    nonisolated private static func pagePayload<Item: Encodable>(_ items: [Item]) -> Data {
        let encodedItems = items.map { try! JSONValue(encoding: $0) }
        let payload = JSONValue.object([
            "meta": .object([
                "pageIndex": .number(0),
                "pageSize": .number(20),
                "totalCount": .number(Double(encodedItems.count)),
            ]),
            "items": .array(encodedItems),
        ])
        return try! JSONEncoder.cubby().encode(payload)
    }

    nonisolated private static func cookbook(_ id: String, _ name: String) -> JSONValue {
        [
            "id": .string(id), "name": .string(name), "author": ["Author"], "subjects": [],
            "recipeCount": 1, "sourceRecipeCount": 1, "needsReextract": false,
            "createdAt": "1970-01-01T00:00:00.000Z", "updatedAt": "1970-01-01T00:00:00.000Z",
            "dataQuality": [
                "status": "complete", "score": 100, "facets": [], "gaps": [], "exceptions": [],
                "relatedGaps": [], "relatedExceptions": [],
            ],
            "displayImages": [],
        ]
    }

    nonisolated private static let cookbooks = [
        cookbook("CKB-1", "Alpha Cookbook"), cookbook("CKB-2", "Beta Cookbook"),
    ]

    /// The kernel `get` adds the shared detail media to the cookbook summary.
    nonisolated private static let cookbookDetailPayload: Data = {
        let summary = try! JSONEncoder.cubby().encode(cookbooks[0])
        var object = try! JSONSerialization.jsonObject(with: summary) as! [String: Any]
        object["attachments"] = [Any]()
        object["redirectedFrom"] = NSNull()
        object["previousShortcodes"] = [Any]()
        object["sources"] = [Any]()
        return try! JSONSerialization.data(withJSONObject: object)
    }()

    nonisolated private static func requestBody(_ request: URLRequest) throws -> Data {
        if let body = request.httpBody { return body }
        let stream = try #require(request.httpBodyStream)
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while true {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count < 0 { throw stream.streamError ?? URLError(.cannotDecodeRawData) }
            if count == 0 { return data }
            data.append(contentsOf: buffer.prefix(count))
        }
    }
}
