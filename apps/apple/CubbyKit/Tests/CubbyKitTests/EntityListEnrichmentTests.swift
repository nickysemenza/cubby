import Foundation
import Synchronization
import Testing

@testable import CubbyKit

// Native async failure modes: core waits for background work; a removed optional survives a
// patch; stale query/page work writes into a new context; one group failure loses other groups;
// summary failure hides exact pagination; a retry discards ready data.
@Suite("EntityListEnrichment")
@MainActor
struct EntityListEnrichmentTests {
    @Test func coreIsVisibleBeforeGroupsAndRemovedOptionalIsCleared() async throws {
        let gate = Reply<[EntityListGroupResult]>()
        let model = EntityListEnrichmentModel(descriptor: EntityCatalog[.product])
        let page = Self.page(enrich: { _, _ in await gate.wait() })
        model.accept(page, replacing: true)

        let core = try #require(model.project(page.items).first)
        #expect(core.title == "Sample")
        #expect(core.pendingFields.contains("displayImages"))
        #expect(core.raw["displayImages"] != nil)

        gate.resolve([.ready(id: "media", rows: [["id": "PRD-2345"]])])
        await model.waitForBackground()
        let resolved = try #require(model.project(page.items).first)
        #expect(resolved.raw["displayImages"] == nil)
        #expect(resolved.imageURL == nil)
        #expect(resolved.pendingFields.isEmpty)
    }

    @Test func lateGroupAndSummaryCannotCrossARefresh() async {
        let groups = Reply<[EntityListGroupResult]>()
        let summary = Reply<[String: Double]?>()
        let model = EntityListEnrichmentModel(descriptor: EntityCatalog[.product])
        let old = Self.page(
            enrich: { _, _ in await groups.wait() }, summary: { await summary.wait() })
        model.accept(old, replacing: true)
        await groups.gate.arrivals(1)
        await summary.gate.arrivals(1)
        let stale = model.tasks + [model.summaryTask].compactMap { $0 }
        model.invalidate()
        let fresh = Self.page(enrich: { _, _ in [] }, summary: { ["price": 3] })
        model.accept(fresh, replacing: true)
        await model.waitForBackground()
        groups.resolve([.ready(id: "media", rows: [["id": "PRD-2345", "displayImages": []]])])
        summary.resolve(["price": 99])
        for task in stale { await task.value }

        #expect(model.sums?["price"] == 3)
        #expect(model.project(fresh.items).first?.raw["displayImages"] != .array([]))
    }

    @Test func groupFailurePreservesCoreAndReadyFieldsThenRetryRecovers() async throws {
        let attempts = Attempts()
        let model = EntityListEnrichmentModel(descriptor: EntityCatalog[.product])
        let deferred = EntityListDeferred(
            groups: [
                .init(id: "media", fields: ["displayImages"]),
                .init(id: "relations", fields: ["manufacturer"]),
            ],
            enrich: { _, requested in
                let attempt = await attempts.next()
                if attempt == 1 {
                    return [
                        .ready(id: "relations", rows: [["id": "PRD-2345", "manufacturer": "Sample maker"]]),
                        .failed(id: "media", message: "MEDIA_FAILURE: Retry"),
                    ]
                }
                #expect(requested == ["media"])
                return [.ready(id: "media", rows: [["id": "PRD-2345", "displayImages": []]])]
            }, summary: { throw Failure.summary })
        let page = ListPage(items: Self.page().items, meta: Self.page().meta, deferred: deferred)
        model.accept(page, replacing: true)
        await model.waitForBackground()

        let partial = try #require(model.project(page.items).first)
        #expect(partial.title == "Sample")
        #expect(partial.raw["manufacturer"] == .string("Sample maker"))
        #expect(partial.failedFields.contains("displayImages"))
        #expect(model.summaryError != nil)
        #expect(page.meta.totalCount == 2)

        model.retry()
        await model.waitForBackground()
        let retried = try #require(model.project(page.items).first)
        #expect(retried.failedFields.isEmpty)
        #expect(retried.raw["manufacturer"] == .string("Sample maker"))
    }

    private nonisolated static func page(
        enrich: @escaping EntityListDeferred.Enricher = { _, _ in [] },
        summary: @escaping EntityListDeferred.SummaryLoader = { nil }
    ) -> ListPage<EntityRow> {
        let row = EntityCatalog[.product].row(from: [
            "id": "PRD-2345", "name": "Sample",
            "displayImages": [["url": "https://example.com/previous.jpg"]],
        ])!
        return ListPage(
            items: [row], meta: ListPageMeta(pageIndex: 1, pageSize: 1, totalCount: 2),
            deferred: .init(
                groups: [.init(id: "media", fields: ["displayImages"])], enrich: enrich, summary: summary))
    }

    private enum Failure: Error { case summary }
    private actor Attempts {
        private var count = 0
        func next() -> Int { count += 1; return count }
    }
    /// A late answer: the double parks until the test resolves it with a value.
    private final class Reply<T: Sendable>: Sendable {
        let gate = Gate()
        private let value = Mutex<T?>(nil)
        func wait() async -> T {
            await gate.hold()
            return value.withLock { $0! }
        }
        func resolve(_ value: T) {
            self.value.withLock { $0 = value }
            gate.open()
        }
    }
}
