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

@Suite("Native list adapters", .serialized)
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

    @Test func cookbookListFiltersLocallyAndPagesTheCompleteResponse() async throws {
        defer { NativeListStub.handler.withLock { $0 = nil } }
        NativeListStub.handler.withLock { handler in
            handler = { _ in (200, Self.cookbooksPayload) }
        }

        let model = GenericEntityListModel(
            descriptor: EntityCatalog[.cookbook], client: try makeClient(), pageSize: 1)
        await model.loadInitial()

        #expect(model.rows.map(\.id) == ["CKB-1"])
        #expect(model.rows.first?.title == "Alpha Cookbook")
        #expect(model.hasMore)

        await model.loadNextPage()
        #expect(model.rows.map(\.id) == ["CKB-1", "CKB-2"])
        #expect(model.hasMore == false)

        model.setSearchQuery("Beta")
        #expect(await waitUntil { model.searchModel?.phase == .loaded })
        #expect(model.searchModel?.rows.map(\.id) == ["CKB-2"])
        #expect(model.searchModel?.rows.first?.title == "Beta Cookbook")
    }

    @Test func cookbookListSortsBeforeTakingTheLocalPage() async throws {
        defer { NativeListStub.handler.withLock { $0 = nil } }
        NativeListStub.handler.withLock { handler in
            handler = { _ in (200, Self.cookbooksPayload) }
        }

        let model = GenericEntityListModel(
            descriptor: EntityCatalog[.cookbook], client: try makeClient(), pageSize: 1,
            sort: "-book")
        await model.loadInitial()
        #expect(model.rows.map(\.id) == ["CKB-2"])

        await model.loadNextPage()
        #expect(model.rows.map(\.id) == ["CKB-2", "CKB-1"])
    }

    @Test func imageListSendsTypedFiltersAndOneBasedPagingAsTheGeneratedInput() async throws {
        defer { NativeListStub.handler.withLock { $0 = nil } }
        let body = Mutex<Data?>(nil)
        NativeListStub.handler.withLock { handler in
            handler = { request in
                body.withLock { $0 = try? Self.requestBody(request) }
                return (200, Self.imagesPage)
            }
        }

        var filters = EntityFilterState()
        filters.set(.single("PENDING"), for: "status")
        filters.set(.single("cover"), for: "nameFilter")
        let page = try await makeClient().list(
            EntityCatalog[.image], page: 3, pageSize: 7, sort: "-createdAt", filters: filters)

        #expect(page.items.map(\.id) == ["IMG-1", "IMG-2"])
        #expect(page.items.first?.imageURL == nil)
        #expect(page.items.dropFirst().first?.imageURL == URL(string: "https://images.example/ready.jpg"))
        let encoded = try #require(body.withLock { $0 })
        let object = try #require(
            JSONDecoder().decode(JSONValue.self, from: encoded).objectValue)
        let expectedFilters = JSONValue.object([
            "nameFilter": .string("cover"),
            "status": .array([.string("PENDING")]),
        ])
        #expect(object["filters"] == expectedFilters)
        #expect(object["pagination"] == ["pageIndex": 2, "pageSize": 7])
        #expect(object["sort"] != nil)
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

    @Test func cookbookAndUsdaDetailsUseTypedRPCsAndNormalizeRowIdentity() async throws {
        defer { NativeListStub.handler.withLock { $0 = nil } }
        let urls = Mutex<[URL]>([])
        NativeListStub.handler.withLock { handler in
            handler = { request in
                if let url = request.url { urls.withLock { $0.append(url) } }
                switch request.url?.path {
                case "/api/v1/cookbook/detail": return (200, Self.cookbookDetailPayload)
                case "/api/v1/usda-food/detail": return (200, Self.usdaDetailPayload)
                default: return (500, Data())
                }
            }
        }

        let client = try makeClient()
        let cookbook = try #require(await client.row(EntityCatalog[.cookbook], id: "CKB-1"))
        #expect(cookbook.id == "CKB-1")
        #expect(cookbook.title == "Alpha Cookbook")
        #expect(cookbook.raw["shortcode"] == "CKB-1")

        let food = try #require(await client.row(EntityCatalog[.usdaFood], id: "12345"))
        #expect(food.id == "12345")
        #expect(food.title == "Numeric food")
        #expect(food.raw["id"] == "12345")

        let queryItems = urls.withLock { urls in
            urls.map { URLComponents(url: $0, resolvingAgainstBaseURL: false)?.queryItems ?? [] }
        }
        try #require(queryItems.count == 2)
        #expect(queryItems[0].contains(URLQueryItem(name: "shortcode", value: "CKB-1")))
        #expect(queryItems[1].contains(URLQueryItem(name: "id", value: "12345")))
    }

    private func waitUntil(_ condition: @MainActor () -> Bool) async -> Bool {
        for _ in 0..<1_000 {
            if condition() { return true }
            try? await Task.sleep(nanoseconds: 1_000_000)
        }
        return condition()
    }

    nonisolated private static let imagesPage: Data = {
        let date = Date(timeIntervalSince1970: 1_700_000_000)
        let pending = ImageWithEntity(
            id: ImageCode("IMG-1"), url: "https://images.example/pending.jpg", key: "pending-key",
            filename: "pending.jpg", size: 1, contentType: "image/jpeg", status: .pending, source: .unknown,
            useOriginal: false, createdAt: date, updatedAt: date, associations: [])
        let uploaded = ImageWithEntity(
            id: ImageCode("IMG-2"), url: "https://images.example/ready.jpg", key: "ready-key",
            filename: "ready.jpg", size: 1, contentType: "image/jpeg", status: .uploaded, source: .unknown,
            useOriginal: false, createdAt: date, updatedAt: date, associations: [])
        return pagePayload([pending, uploaded])
    }()

    nonisolated private static let usdaFood = FoodSummaryWithLinkedProducts(
        fdcId: 12345,
        description: "Numeric food",
        foodInfo: FoodInfo(dataType: .brandedFood, description: "Numeric food"),
        nutritionInfo: NutritionInfo(
            nutrientSummary: [], nutrientsPer100: NutrientsPer100()),
        portionInfoRaw: [], inferredUnitMappings: [], linkedProducts: [])

    nonisolated private static let usdaPage: Data = pagePayload([usdaFood])

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

    nonisolated private static let completeDataQuality = DataQuality(
        status: .complete, score: 100, facets: [], gaps: [], exceptions: [],
        relatedGaps: [], relatedExceptions: [])

    nonisolated private static let cookbooks = [
        CookbookSummary(
            id: "CKB-1", book: "Alpha Cookbook", author: ["Author A"], subjects: ["Soup"],
            recipeCount: 1, sourceRecipeCount: 1, needsReextract: false,
            dataQuality: completeDataQuality, displayImages: []),
        CookbookSummary(
            id: "CKB-2", book: "Beta Cookbook", author: ["Author B"], subjects: ["Bread"],
            recipeCount: 2, sourceRecipeCount: 2, needsReextract: false,
            dataQuality: completeDataQuality, displayImages: []),
    ]

    nonisolated private static let cookbooksPayload: Data = {
        try! JSONEncoder.cubby().encode(cookbooks)
    }()

    nonisolated private static let cookbookDetailPayload: Data = {
        try! JSONEncoder.cubby().encode(cookbooks[0])
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
