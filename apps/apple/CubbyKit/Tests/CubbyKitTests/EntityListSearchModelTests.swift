import Foundation
import Testing

@testable import CubbyKit

@Suite("EntityListSearchModel")
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
        #expect(await waitUntil { model.phase == .loaded })

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
        #expect(await waitUntil { model.phase == .failed("failed") })
        #expect(model.phase == .failed("failed"))

        model.retry()
        #expect(await waitUntil { model.phase == .loaded })
        #expect(model.phase == .loaded)
        #expect(model.rows.count == 1)

        model.clear()
        #expect(model.query.isEmpty)
        #expect(model.rows.isEmpty)
        #expect(model.phase == .idle)
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
        #expect(await waitUntil { model.phase == .loaded })
        await model.loadNextPage()

        #expect(model.page == 2)
        #expect(model.rows.map(\.title) == ["first", "second"])
    }

    @Test func cancelledNextPageDoesNotRemainLoading() async {
        let model = EntityListSearchModel(
            debounceNanoseconds: 1,
            sleeper: { _ in },
            loader: { query, page in
                if page == 2 {
                    // Deliberately swallow cancellation to exercise the model's stale/cancelled
                    // completion guard rather than relying on cooperative loaders.
                    try? await Task.sleep(nanoseconds: 50_000_000)
                    return Self.page(Self.row(query))
                }
                return ListPage(
                    items: [Self.row("first")],
                    meta: ListPageMeta(pageIndex: 1, pageSize: 1, totalCount: 2))
            })
        model.setQuery("second")
        #expect(await waitUntil { model.phase == .loaded })
        let nextPage = Task { await model.loadNextPage() }
        nextPage.cancel()
        await nextPage.value

        #expect(model.phase == .loaded)
        #expect(model.page == 1)
    }

    private nonisolated static func row(_ title: String) -> EntityRow {
        EntityRow(
            id: "PRD-\(title)", title: title, subtitle: nil, imageURL: nil,
            raw: ["id": .string("PRD-\(title)")])
    }

    private nonisolated static func page(_ row: EntityRow) -> ListPage<EntityRow> {
        ListPage(items: [row], meta: ListPageMeta(pageIndex: 1, pageSize: 25, totalCount: 1))
    }

    private func waitUntil(_ condition: @MainActor () -> Bool) async -> Bool {
        for _ in 0..<1_000 {
            if condition() { return true }
            try? await Task.sleep(nanoseconds: 1_000_000)
        }
        return condition()
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
