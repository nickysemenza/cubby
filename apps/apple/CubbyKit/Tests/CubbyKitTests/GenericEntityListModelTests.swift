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
        let calls = Mutex(0)
        ListStub.handler.withLock { handler in
            handler = { _ in
                calls.withLock { $0 += 1 }
                return (200, payload)
            }
        }
        let model = GenericEntityListModel(descriptor: EntityCatalog[.product], client: try makeClient())
        await model.loadInitial()
        await model.loadInitial()
        #expect(model.phase == .loaded)
        #expect(model.rows.count == 1)
        #expect(model.rows.first?.id == "PRD-2345")
        #expect(model.rows.first?.title == "Sample Product")
        #expect(model.meta?.totalCount == 1)
        #expect(calls.withLock { $0 } == 1)
    }

    @Test func accumulatesPagesAndCollapsesDuplicateNextPageTriggers() async throws {
        defer { ListStub.handler.withLock { $0 = nil } }
        let calls = Mutex<[Int]>([])
        let first = try productPage(id: "PRD-2345", name: "First", page: 1, total: 2)
        let second = try productPage(id: "PRD-3456", name: "Second", page: 2, total: 2)
        ListStub.handler.withLock { handler in
            handler = { request in
                let page = Self.page(in: request)
                calls.withLock { $0.append(page) }
                if page == 2 { Thread.sleep(forTimeInterval: 0.05) }
                return (200, page == 1 ? first : second)
            }
        }
        let model = GenericEntityListModel(
            descriptor: EntityCatalog[.product], client: try makeClient(), pageSize: 1)

        await model.loadInitial()
        async let firstTrigger: Void = model.loadNextPage()
        async let duplicateTrigger: Void = model.loadNextPage()
        _ = await (firstTrigger, duplicateTrigger)

        #expect(model.rows.map(\.id) == ["PRD-2345", "PRD-3456"])
        #expect(model.page == 2)
        #expect(model.hasMore == false)
        #expect(calls.withLock { $0.filter { $0 == 2 }.count } == 1)
    }

    @Test func failedPageCanRetryWithoutLosingAccumulatedRows() async throws {
        defer { ListStub.handler.withLock { $0 = nil } }
        let pageTwoCalls = Mutex(0)
        let first = try productPage(id: "PRD-2345", name: "First", page: 1, total: 2)
        let second = try productPage(id: "PRD-3456", name: "Second", page: 2, total: 2)
        let failure = Data(#"{"code":"TEST_FAILURE","message":"Try again"}"#.utf8)
        ListStub.handler.withLock { handler in
            handler = { request in
                guard Self.page(in: request) == 2 else { return (200, first) }
                let attempt = pageTwoCalls.withLock { value in
                    value += 1
                    return value
                }
                return attempt == 1 ? (500, failure) : (200, second)
            }
        }
        let model = GenericEntityListModel(
            descriptor: EntityCatalog[.product], client: try makeClient(), pageSize: 1)

        await model.loadInitial()
        await model.loadNextPage()
        #expect(model.rows.map(\.id) == ["PRD-2345"])
        #expect(model.page == 1)
        #expect(model.nextPageError?.contains("Try again") == true)

        await model.loadNextPage()
        #expect(model.rows.map(\.id) == ["PRD-2345", "PRD-3456"])
        #expect(model.nextPageError == nil)
    }

    @Test func overlappingFinalPageDeduplicatesAndStopsPagination() async throws {
        defer { ListStub.handler.withLock { $0 = nil } }
        let first = try productPage(id: "PRD-2345", name: "First", page: 1, total: 2)
        let overlappingFinal = try productPage(
            id: "PRD-2345", name: "First", page: 2, total: 2)
        ListStub.handler.withLock { handler in
            handler = { request in
                (200, Self.page(in: request) == 1 ? first : overlappingFinal)
            }
        }
        let model = GenericEntityListModel(
            descriptor: EntityCatalog[.product], client: try makeClient(), pageSize: 1)

        await model.loadInitial()
        #expect(model.hasMore)
        await model.loadNextPage()

        #expect(model.rows.map(\.id) == ["PRD-2345"])
        #expect(model.page == 2)
        #expect(model.hasMore == false)
    }

    @Test func refreshFailureRetainsLoadedContent() async throws {
        defer { ListStub.handler.withLock { $0 = nil } }
        let calls = Mutex(0)
        let first = try productPage(id: "PRD-2345", name: "First", page: 1, total: 1)
        let failure = Data(#"{"code":"REFRESH_FAILURE","message":"Still offline"}"#.utf8)
        ListStub.handler.withLock { handler in
            handler = { _ in
                let call = calls.withLock { value in
                    value += 1
                    return value
                }
                return call == 1 ? (200, first) : (503, failure)
            }
        }
        let model = GenericEntityListModel(descriptor: EntityCatalog[.product], client: try makeClient())

        await model.loadInitial()
        await model.refresh()

        #expect(model.phase == .loaded)
        #expect(model.rows.map(\.id) == ["PRD-2345"])
        #expect(model.refreshError?.contains("Still offline") == true)
    }

    @Test func refreshSupersedesALateNextPageResponse() async throws {
        defer { ListStub.handler.withLock { $0 = nil } }
        let pageOneCalls = Mutex(0)
        let pageTwoStarted = Mutex(false)
        let initial = try productPage(id: "PRD-2345", name: "Initial", page: 1, total: 2)
        let late = try productPage(id: "PRD-3456", name: "Late", page: 2, total: 2)
        let refreshed = try productPage(id: "PRD-4567", name: "Refreshed", page: 1, total: 1)
        ListStub.handler.withLock { handler in
            handler = { request in
                if Self.page(in: request) == 2 {
                    pageTwoStarted.withLock { $0 = true }
                    Thread.sleep(forTimeInterval: 0.08)
                    return (200, late)
                }
                let call = pageOneCalls.withLock { value in
                    value += 1
                    return value
                }
                return (200, call == 1 ? initial : refreshed)
            }
        }
        let model = GenericEntityListModel(
            descriptor: EntityCatalog[.product], client: try makeClient(), pageSize: 1)
        await model.loadInitial()

        let loadMore = Task { await model.loadNextPage() }
        for _ in 0..<10_000 {
            if pageTwoStarted.withLock({ $0 }) { break }
            await Task.yield()
        }
        #expect(pageTwoStarted.withLock { $0 })
        await model.refresh()
        await loadMore.value

        #expect(model.rows.map(\.id) == ["PRD-4567"])
        #expect(model.page == 1)
        #expect(model.hasMore == false)
    }

    @Test func detailRefreshFailureRetainsTheRow() async throws {
        defer { ListStub.handler.withLock { $0 = nil } }
        let calls = Mutex(0)
        let row = try Fixtures.data(named: "product-get.json")
        let failure = Data(#"{"code":"REFRESH_FAILURE","message":"Still offline"}"#.utf8)
        ListStub.handler.withLock { handler in
            handler = { _ in
                let call = calls.withLock { value in
                    value += 1
                    return value
                }
                return call == 1 ? (200, row) : (503, failure)
            }
        }
        let model = GenericEntityDetailModel(descriptor: EntityCatalog[.product], client: try makeClient())

        await model.loadInitial(id: "PRD-2345")
        await model.loadInitial(id: "PRD-2345")
        await model.refresh(id: "PRD-2345")

        #expect(model.phase == .loaded)
        #expect(model.row?.id == "PRD-2345")
        #expect(model.refreshError?.contains("Still offline") == true)
        #expect(calls.withLock { $0 } == 2)
    }

    nonisolated private static func page(in request: URLRequest) -> Int {
        URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?
            .first(where: { $0.name == "page" })?.value.flatMap(Int.init) ?? 1
    }

    private func productPage(id: String, name: String, page: Int, total: Int) throws -> Data {
        var object = try #require(
            JSONSerialization.jsonObject(with: Fixtures.data(named: "products-list.json"))
                as? [String: Any])
        var items = try #require(object["items"] as? [[String: Any]])
        items[0]["id"] = id
        items[0]["name"] = name
        object["items"] = items
        var meta = try #require(object["meta"] as? [String: Any])
        meta["pageIndex"] = page
        meta["pageSize"] = 1
        meta["totalCount"] = total
        object["meta"] = meta
        return try JSONSerialization.data(withJSONObject: object)
    }
}
