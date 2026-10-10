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
            request, client: client, target: self, handler: Self.handler.withLock { $0 }, detached: true)
    }
    override func stopLoading() {}
    static func session() -> URLSession { StubNetworking.session(protocolClass: self) }
}

@Suite("GenericEntityListModel", .timeLimit(.minutes(1)), .serialized)
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

    /// A header sort must restart server paging, retain filters, and use the same order for
    /// subsequent pages. Sorting just the loaded rows gives the wrong global order.
    @Test func sortRestartsPagingAndRetainsFilters() async throws {
        defer { ListStub.handler.withLock { $0 = nil } }
        let requests = Mutex<[[URLQueryItem]]>([])
        let first = try productPage(id: "PRD-2345", name: "First", page: 1, total: 2)
        let second = try productPage(id: "PRD-3456", name: "Second", page: 2, total: 2)
        ListStub.handler.withLock { handler in
            handler = { request in
                let items = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems ?? []
                requests.withLock { $0.append(items) }
                return (200, Self.page(in: request) == 1 ? first : second)
            }
        }
        let model = GenericEntityListModel(
            descriptor: EntityCatalog[.product], client: try makeClient(), pageSize: 1,
            filters: EntityFilterState(["upcFilter": .single("000000000000")]), progressive: false)
        await model.loadInitial()
        await model.loadNextPage()
        await model.apply(sort: "undeclaredField")
        #expect(model.page == 2)
        #expect(requests.withLock { $0.count } == 2)
        await model.apply(sort: "-name")
        #expect(model.page == 1)
        #expect(model.rows.map(\.id) == ["PRD-2345"])
        await model.loadNextPage()
        let sortedRequests = requests.withLock { Array($0.dropFirst(2)) }
        #expect(sortedRequests.count == 2)
        #expect(
            sortedRequests.allSatisfy { items in
                items.contains(URLQueryItem(name: "sort", value: "-name"))
                    && items.contains(URLQueryItem(name: "upcFilter", value: "000000000000"))
            })
        #expect(model.rows.map(\.id) == ["PRD-2345", "PRD-3456"])
    }

    /// A pending search in the previous order must not replace the newly sorted result.
    @Test func sortReplaysPendingSearchInTheNewOrder() async throws {
        defer { ListStub.handler.withLock { $0 = nil } }
        let search = try #require(EntityCatalog[.product].primarySearch)
        let staleGate = Gate()
        let base = try productPage(id: "PRD-2345", name: "Base", page: 1, total: 1)
        let stale = try productPage(id: "PRD-3456", name: "Old order", page: 1, total: 1)
        let sorted = try productPage(id: "PRD-4567", name: "New order", page: 1, total: 1)
        ListStub.handler.withLock { handler in
            handler = { request in
                let items = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems ?? []
                guard items.contains(URLQueryItem(name: search.key, value: "sample")) else {
                    return (200, base)
                }
                if items.contains(URLQueryItem(name: "sort", value: "-name")) { return (200, sorted) }
                staleGate.holdBlocking()
                return (200, stale)
            }
        }
        let model = GenericEntityListModel(
            descriptor: EntityCatalog[.product], client: try makeClient(), progressive: false,
            searchDebounceNanoseconds: 0)
        await model.loadInitial()
        model.setSearchQuery("sample")
        await staleGate.arrivals(1)
        await model.apply(sort: "-name")
        let searchModel = try #require(model.searchModel)
        await observe { searchModel.phase == .loaded }
        #expect(searchModel.query == "sample")
        #expect(searchModel.rows.map(\.id) == ["PRD-4567"])
        staleGate.open()
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
        let model = GenericEntityListModel(
            descriptor: EntityCatalog[.product], client: try makeClient(), progressive: false)
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
        let pageTwo = Gate()
        let first = try productPage(id: "PRD-2345", name: "First", page: 1, total: 2)
        let second = try productPage(id: "PRD-3456", name: "Second", page: 2, total: 2)
        ListStub.handler.withLock { handler in
            handler = { request in
                let page = Self.page(in: request)
                calls.withLock { $0.append(page) }
                if page == 2 { pageTwo.holdBlocking() }
                return (200, page == 1 ? first : second)
            }
        }
        let model = GenericEntityListModel(
            descriptor: EntityCatalog[.product], client: try makeClient(), pageSize: 1, progressive: false)

        await model.loadInitial()
        let firstTrigger = Task.immediate { await model.loadNextPage() }
        let duplicateTrigger = Task.immediate { await model.loadNextPage() }
        await pageTwo.arrivals(1)
        pageTwo.open()
        await firstTrigger.waitUnlessCancelled()
        await duplicateTrigger.waitUnlessCancelled()

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
            descriptor: EntityCatalog[.product], client: try makeClient(), pageSize: 1, progressive: false)

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
            descriptor: EntityCatalog[.product], client: try makeClient(), pageSize: 1, progressive: false)

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
        let model = GenericEntityListModel(
            descriptor: EntityCatalog[.product], client: try makeClient(), progressive: false)

        await model.loadInitial()
        await model.refresh()

        #expect(model.phase == .loaded)
        #expect(model.rows.map(\.id) == ["PRD-2345"])
        #expect(model.refreshError?.contains("Still offline") == true)
        #expect(model.meta != nil)
        #expect(model.summaryMeta == nil)
    }

    @Test func changedFiltersDoNotKeepPreviousTotalsAfterFailure() async throws {
        defer { ListStub.handler.withLock { $0 = nil } }
        let calls = Mutex(0)
        let first = try productPage(
            id: "PRD-2345", name: "First", page: 1, total: 1, sums: ["price": 25])
        let failure = Data(#"{"code":"FILTER_FAILURE","message":"Try again"}"#.utf8)
        ListStub.handler.withLock { handler in
            handler = { _ in
                let call = calls.withLock { value in
                    value += 1
                    return value
                }
                return call == 1 ? (200, first) : (503, failure)
            }
        }
        let model = GenericEntityListModel(
            descriptor: EntityCatalog[.product], client: try makeClient(), progressive: false)
        await model.loadInitial()
        #expect(model.meta?.sums?.additionalProperties["price"] == 25)

        let search = try #require(EntityCatalog[.product].primarySearch)
        await model.apply(filters: EntityFilterState([search.key: .single("new")]))

        #expect(model.rows.map(\.id) == ["PRD-2345"])
        #expect(model.refreshError?.contains("Try again") == true)
        #expect(model.meta == nil)
    }

    @Test func refreshSupersedesALateNextPageResponse() async throws {
        defer { ListStub.handler.withLock { $0 = nil } }
        let pageOneCalls = Mutex(0)
        let pageTwo = Gate()
        let initial = try productPage(id: "PRD-2345", name: "Initial", page: 1, total: 2)
        let late = try productPage(id: "PRD-3456", name: "Late", page: 2, total: 2)
        let refreshed = try productPage(id: "PRD-4567", name: "Refreshed", page: 1, total: 1)
        ListStub.handler.withLock { handler in
            handler = { request in
                if Self.page(in: request) == 2 {
                    pageTwo.holdBlocking()
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
            descriptor: EntityCatalog[.product], client: try makeClient(), pageSize: 1, progressive: false)
        await model.loadInitial()

        let loadMore = Task { await model.loadNextPage() }
        await pageTwo.arrivals(1)
        await model.refresh()
        pageTwo.open()
        await loadMore.value

        #expect(model.rows.map(\.id) == ["PRD-4567"])
        #expect(model.page == 1)
        #expect(model.hasMore == false)
    }

    /// A filter change while a query's request is in flight replays the query against the new
    /// scope; the older scope's late response must never become the visible result.
    @Test func filterChangeWhileQueryIsPendingReplaysItInTheNewScope() async throws {
        defer { ListStub.handler.withLock { $0 = nil } }
        let search = try #require(EntityCatalog[.product].primarySearch)
        let staleGate = Gate()
        let base = try productPage(id: "PRD-2345", name: "Base", page: 1, total: 1)
        let stale = try productPage(id: "PRD-3456", name: "Unscoped", page: 1, total: 1)
        let scoped = try productPage(id: "PRD-4567", name: "Scoped", page: 1, total: 1)
        ListStub.handler.withLock { handler in
            handler = { request in
                let items =
                    URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems ?? []
                guard items.contains(where: { $0.name == search.key && $0.value == "sample" }) else {
                    return (200, base)
                }
                if items.contains(where: { $0.name == "upcFilter" }) { return (200, scoped) }
                staleGate.holdBlocking()
                return (200, stale)
            }
        }
        let model = GenericEntityListModel(
            descriptor: EntityCatalog[.product], client: try makeClient(), progressive: false,
            searchDebounceNanoseconds: 0)
        await model.loadInitial()
        let searchModel = try #require(model.searchModel)

        model.setSearchQuery("sample")
        await staleGate.arrivals(1)
        await model.apply(filters: EntityFilterState(["upcFilter": .single("000000000000")]))
        await observe { searchModel.phase == .loaded }
        // The replay cancelled the unscoped request, so its answer, released now, never lands.
        staleGate.open()

        #expect(searchModel.query == "sample")
        #expect(searchModel.rows.map(\.id) == ["PRD-4567"])
        #expect(model.rows.map(\.id) == ["PRD-2345"])
    }

    /// The picker/photo-lane shape: a scoped source replaced while the old scope still shows
    /// search rows and has a request in flight. The old rows disappear the moment the scope
    /// changes, the replayed query lands in the new scope, and the old scope's late response —
    /// released only after the new one — never becomes visible.
    @Test func sourceChangeWhileQueryIsPendingReplaysItInTheNewScope() async throws {
        let oldCalls = Mutex(0)
        let oldGate = Gate()
        let newGate = Gate()
        let old = EntityListPageSource(
            id: "old",
            loadPage: { page in Self.page([Self.row("old-base")], page: page, total: 1) },
            searchPage: { query, page in
                let call = oldCalls.withLock { value in
                    value += 1
                    return value
                }
                guard call > 1 else {
                    return Self.page([Self.row("old-\(query)")], page: page, total: 1)
                }
                await oldGate.hold()
                return Self.page([Self.row("old-late")], page: page, total: 1)
            })
        let new = EntityListPageSource(
            id: "new",
            loadPage: { page in Self.page([Self.row("new-base")], page: page, total: 1) },
            searchPage: { query, page in
                await newGate.hold()
                return Self.page([Self.row("new-\(query)")], page: page, total: 1)
            })
        let model = GenericEntityListModel(
            descriptor: EntityCatalog[.product], client: try makeClient(), source: old,
            searchDebounceNanoseconds: 1)
        await model.loadInitial()
        let searchModel = try #require(model.searchModel)
        model.setSearchQuery("sample")
        await observe { searchModel.phase == .loaded }
        #expect(searchModel.rows.map(\.title) == ["old-sample"])

        let oldRefresh = Task { await searchModel.refresh() }
        await oldGate.arrivals(1)
        #expect(searchModel.rows.map(\.title) == ["old-sample"])

        await model.setSource(new)
        #expect(model.rows.map(\.title) == ["new-base"])
        #expect(searchModel.rows.isEmpty)
        await newGate.arrivals(1)
        #expect(searchModel.rows.isEmpty)
        #expect(searchModel.phase == .loading)

        newGate.open()
        await observe { searchModel.phase == .loaded }
        #expect(searchModel.rows.map(\.title) == ["new-sample"])

        oldGate.open()
        await oldRefresh.value
        #expect(model.searchModel === searchModel)
        #expect(searchModel.query == "sample")
        #expect(searchModel.rows.map(\.title) == ["new-sample"])
        #expect(searchModel.phase == .loaded)
    }

    /// A source that builds its own rows opts out of deferred enrichment: deferred work carried on
    /// its pages never starts (the enabled control proves the same page would start it).
    @Test func sourceWithoutEnrichmentNeverRunsDeferredWork() async throws {
        for enrichesRows in [false, true] {
            let calls = Mutex<[String]>([])
            let deferred = EntityListDeferred(
                groups: [.init(id: "detail", fields: ["name"])],
                enrich: { ids, _ in
                    calls.withLock { $0.append("enrich:\(ids.joined(separator: ","))") }
                    return []
                },
                summary: {
                    calls.withLock { $0.append("summary") }
                    return ["price": 1]
                })
            let source = EntityListPageSource(id: "shelf", enrichesRows: enrichesRows) { page in
                ListPage(
                    items: [Self.row("row-\(page)")],
                    meta: ListPageMeta(pageIndex: page, pageSize: 1, totalCount: 2),
                    deferred: deferred)
            }
            let model = GenericEntityListModel(
                descriptor: EntityCatalog[.product], client: try makeClient(), source: source)
            await model.loadInitial()
            await model.loadNextPage()
            await model.enrichment.waitForBackground()

            #expect(model.rows.map(\.id) == ["PRD-row-1", "PRD-row-2"])
            let recorded = calls.withLock { $0 }
            if enrichesRows {
                #expect(recorded.contains("summary"))
                #expect(recorded.contains("enrich:PRD-row-2"))
            } else {
                #expect(recorded.isEmpty)
                #expect(model.enrichment.sums == nil)
                #expect(model.enrichment.isLoadingSummary == false)
            }
        }
    }

    /// Swapping in a source drops a loaded declared timeline, and a declared timeline response
    /// still in flight at the swap never populates the newly scoped model.
    @Test func sourceChangeDropsTheDeclaredTimelineAndItsLateResponse() async throws {
        defer { ListStub.handler.withLock { $0 = nil } }
        let timelineCalls = Mutex(0)
        let lateTimeline = Gate()
        let list = try productPage(id: "PRD-2345", name: "Base", page: 1, total: 1)
        let timeline = Data(
            (#"{"groups":[],"stats":[],"notes":[],"#
                + #""meta":{"totalCount":0,"pageIndex":0,"pageSize":200}}"#).utf8)
        ListStub.handler.withLock { handler in
            handler = { request in
                guard request.url!.path.hasSuffix("/timeline") else { return (200, list) }
                let call = timelineCalls.withLock { value in
                    value += 1
                    return value
                }
                if call > 1 { lateTimeline.holdBlocking() }
                return (200, timeline)
            }
        }
        let model = GenericEntityListModel(
            descriptor: EntityCatalog[.product], client: try makeClient(), progressive: false)
        await model.loadInitial()
        await model.select(view: .timeline)
        #expect(model.timeline != nil)

        let late = Task { await model.loadTimeline() }
        await lateTimeline.arrivals(1)
        await model.setSource(
            EntityListPageSource(id: "scope") { page in
                Self.page([Self.row("scoped")], page: page, total: 1)
            })
        #expect(model.timeline == nil)
        #expect(model.isLoadingTimeline == false)

        lateTimeline.open()
        await late.value
        #expect(model.timeline == nil)
        #expect(model.timelineError == nil)
        #expect(model.isLoadingTimeline == false)
        #expect(model.rows.map(\.title) == ["scoped"])
    }

    /// Injected rows are presented as the source built them (no descriptor re-projection), and a
    /// duplicate-only page still advances paging so the next page stays reachable.
    @Test func injectedSourcePagesThroughADuplicateOnlyPage() async throws {
        let calls = Mutex<[Int]>([])
        let source = EntityListPageSource(id: "shelf") { page in
            calls.withLock { $0.append(page) }
            let title = page == 3 ? "third" : "first"
            let raw: [String: JSONValue] = ["id": .string("PRD-\(title)"), "name": .string("Declared")]
            return Self.page([Self.row(title, raw: raw)], page: page, total: 3)
        }
        let model = GenericEntityListModel(
            descriptor: EntityCatalog[.product], client: try makeClient(), source: source)

        await model.loadInitial()
        #expect(model.searchModel == nil)
        await model.loadNextPage()
        #expect(model.rows.map(\.title) == ["first"])
        #expect(model.page == 2)
        #expect(model.hasMore)
        await model.loadNextPage()

        #expect(model.rows.map(\.title) == ["first", "third"])
        #expect(model.rows.map(\.id) == ["PRD-first", "PRD-third"])
        #expect(model.hasMore == false)
        #expect(calls.withLock { $0 } == [1, 2, 3])
    }

    /// Re-setting the same source identity is a no-op (SwiftUI re-runs tasks); a new identity
    /// supersedes an in-flight next page of the old source, even one released after the swap.
    @Test func sourceIdentityGatesReloadsAndSupersedesALateNextPage() async throws {
        let calls = Mutex<[String]>([])
        let oldPageTwo = Gate()
        func source(_ scope: String) -> EntityListPageSource {
            EntityListPageSource(id: scope) { page in
                calls.withLock { $0.append("\(scope):\(page)") }
                if scope == "old", page == 2 { await oldPageTwo.hold() }
                return Self.page([Self.row("\(scope)-\(page)")], page: page, total: 2)
            }
        }
        let model = GenericEntityListModel(
            descriptor: EntityCatalog[.product], client: try makeClient(), source: source("old"))
        await model.loadInitial()
        await model.setSource(source("old"))
        #expect(calls.withLock { $0 } == ["old:1"])

        let loadMore = Task { await model.loadNextPage() }
        await oldPageTwo.arrivals(1)
        await model.setSource(source("new"))
        #expect(model.rows.map(\.title) == ["new-1"])

        oldPageTwo.open()
        await loadMore.value
        #expect(model.rows.map(\.title) == ["new-1"])
        #expect(model.page == 1)
        #expect(model.hasMore)
        #expect(model.activity == .idle)
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

    nonisolated private static func row(_ title: String, raw: [String: JSONValue]? = nil) -> EntityRow {
        EntityRow(
            id: "PRD-\(title)", title: title, subtitle: nil, imageURL: nil,
            raw: .object(raw ?? ["id": .string("PRD-\(title)"), "name": .string(title)]))
    }

    nonisolated private static func page(_ items: [EntityRow], page: Int, total: Int)
        -> ListPage<EntityRow>
    {
        ListPage(items: items, meta: ListPageMeta(pageIndex: page, pageSize: 1, totalCount: total))
    }

    nonisolated private static func page(in request: URLRequest) -> Int {
        URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?
            .first(where: { $0.name == "page" })?.value.flatMap(Int.init) ?? 1
    }

    private func productPage(
        id: String, name: String, page: Int, total: Int, sums: [String: Double]? = nil
    ) throws -> Data {
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
        if let sums { meta["sums"] = sums }
        object["meta"] = meta
        return try JSONSerialization.data(withJSONObject: object)
    }
}
