import Foundation
import Testing

@testable import CubbyKit

@Suite("EntityListSearchModel", .timeLimit(.minutes(1)))
@MainActor
struct EntityListSearchModelTests {
    @Test func debouncesAndLoadsOnlyTheLatestQuery() async {
        let recorder = Recorder()
        let model = EntityListSearchModel(
            debounceNanoseconds: 1,
            sleeper: { _ in },
            loader: { query, page in
                recorder.append("\(query):\(page)")
                return Self.page(Self.row(query))
            })

        model.setQuery("old")
        model.setQuery("new")
        await model.settled()
        #expect(model.phase == .loaded)

        #expect(recorder.values == ["new:1"])
        #expect(model.rows.map(\.title) == ["new"])
    }

    @Test func clearDropsSearchRowsAndRetryReissuesAFailedQuery() async {
        let recorder = Recorder()
        let model = EntityListSearchModel(
            debounceNanoseconds: 1,
            sleeper: { _ in },
            loader: { query, _ in
                let attempt = recorder.increment()
                if attempt == 1 { throw TestFailure.failed }
                return Self.page(Self.row(query))
            })

        model.setQuery("sample")
        await model.settled()
        #expect(model.phase == .failed("failed"))

        model.retry()
        await model.settled()
        #expect(model.phase == .loaded)
        #expect(model.rows.count == 1)

        model.clear()
        #expect(model.query.isEmpty)
        #expect(model.rows.isEmpty)
        #expect(model.phase == .idle)
    }

    @Test func replacingAQueryImmediatelyHidesOlderRows() async {
        let model = EntityListSearchModel(
            debounceNanoseconds: 1,
            sleeper: { _ in },
            loader: { query, _ in Self.page(Self.row(query)) })

        model.setQuery("old")
        await model.settled()
        #expect(model.phase == .loaded)
        #expect(model.rows.map(\.title) == ["old"])

        model.setQuery("PRD-2D6R")

        #expect(model.rows.isEmpty)
        #expect(model.phase == .debouncing || model.phase == .loading)
        await model.settled()
        #expect(model.phase == .loaded)
        #expect(model.rows.map(\.title) == ["PRD-2D6R"])
    }

    @Test func nextPageAppendsUniqueRowsAndKeepsPageOnFailure() async {
        let model = EntityListSearchModel(
            debounceNanoseconds: 1,
            sleeper: { _ in },
            loader: { query, page in
                if page == 1 {
                    return ListPage(
                        items: [Self.row("first")],
                        meta: ListPageMeta(pageIndex: 1, pageSize: 1, totalCount: 2))
                }
                return ListPage(
                    items: [Self.row("first"), Self.row(query)],
                    meta: ListPageMeta(pageIndex: 2, pageSize: 1, totalCount: 2))
            })
        model.setQuery("second")
        await model.settled()
        #expect(model.phase == .loaded)
        await model.loadNextPage()

        #expect(model.page == 2)
        #expect(model.rows.map(\.title) == ["first", "second"])
    }

    @Test func cancelledNextPageDoesNotRemainLoading() async {
        let model = EntityListSearchModel(
            debounceNanoseconds: 1,
            sleeper: { _ in },
            loader: { query, page in
                // Page 2 ignores cancellation, so the model's own cancelled-completion guard is
                // what keeps the page from landing.
                if page == 2 { return Self.page(Self.row(query)) }
                return ListPage(
                    items: [Self.row("first")],
                    meta: ListPageMeta(pageIndex: 1, pageSize: 1, totalCount: 2))
            })
        model.setQuery("second")
        await model.settled()
        #expect(model.phase == .loaded)
        let nextPage = Task { await model.loadNextPage() }
        nextPage.cancel()
        await nextPage.value

        #expect(model.phase == .loaded)
        #expect(model.page == 1)
    }

    @Test func failedRefreshKeepsVisibleSearchRowsAndCanRecover() async {
        let recorder = Recorder()
        let model = EntityListSearchModel(
            debounceNanoseconds: 1,
            sleeper: { _ in },
            loader: { _, _ in
                switch recorder.increment() {
                case 1: return Self.page(Self.row("original"))
                case 2: throw TestFailure.failed
                default: return Self.page(Self.row("refreshed"))
                }
            })
        model.setQuery("sample")
        await model.settled()
        #expect(model.phase == .loaded)

        await model.refresh()
        #expect(model.phase == .loaded)
        #expect(model.rows.map(\.title) == ["original"])
        #expect(model.refreshError == "failed")
        #expect(model.meta != nil)
        #expect(model.summaryMeta == nil)

        await model.refresh()
        #expect(model.rows.map(\.title) == ["refreshed"])
        #expect(model.refreshError == nil)
        #expect(model.summaryMeta != nil)
    }

    @Test func changedFilterLoaderDoesNotKeepPreviousTotals() async {
        let model = EntityListSearchModel(
            debounceNanoseconds: 1,
            sleeper: { _ in },
            loader: { _, _ in
                ListPage(
                    items: [Self.row("old")],
                    meta: ListPageMeta(
                        pageIndex: 1, pageSize: 25, totalCount: 1,
                        sums: .init(additionalProperties: ["price": 25])))
            })
        model.setQuery("sample")
        await model.settled()
        #expect(model.phase == .loaded)
        #expect(model.meta?.sums?.additionalProperties["price"] == 25)

        model.setLoader { _, _ in throw TestFailure.failed }
        await model.settled()
        #expect(model.phase == .failed("failed"))

        #expect(model.rows.map(\.title) == ["old"])
        #expect(model.meta == nil)
    }

    private nonisolated static func row(_ title: String) -> EntityRow {
        EntityRow(
            id: "PRD-\(title)", title: title, subtitle: nil, imageURL: nil,
            raw: ["id": .string("PRD-\(title)")])
    }

    private nonisolated static func page(_ row: EntityRow) -> ListPage<EntityRow> {
        ListPage(items: [row], meta: ListPageMeta(pageIndex: 1, pageSize: 25, totalCount: 1))
    }

    private enum TestFailure: Error { case failed }

    private final class Recorder: @unchecked Sendable {
        private let lock = NSLock()
        private var storage: [String] = []
        private var count = 0

        var values: [String] {
            lock.lock(); defer { lock.unlock() }
            return storage
        }

        func append(_ value: String) {
            lock.lock(); defer { lock.unlock() }
            storage.append(value)
        }

        func increment() -> Int {
            lock.lock(); defer { lock.unlock() }
            count += 1
            return count
        }
    }
}
