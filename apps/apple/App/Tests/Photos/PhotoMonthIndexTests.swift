import Foundation
import Testing

@testable import Cubby

private struct FakeAsset: PhotoMonthAsset, Equatable {
    let localIdentifier: String
    let creationDate: Date?
}

/// `PhotoMonthIndex`'s month grouping (`PhotoMonthIndex.swift`), exercised with a fake asset since
/// `PHAsset` cannot be constructed outside PhotoKit.
@Suite("PhotoMonthIndex")
struct PhotoMonthIndexTests {
    private static let calendar: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar
    }()

    private static func date(_ year: Int, _ month: Int, _ day: Int) -> Date {
        calendar.date(from: DateComponents(year: year, month: month, day: day))!
    }

    private func makeIndex() -> PhotoMonthIndex<FakeAsset> { PhotoMonthIndex(calendar: Self.calendar) }

    @Test func appendingBatchesOutOfMonthOrderGroupsByMonth() {
        var index = makeIndex()
        // February batch arrives before January — the index must not assume batches arrive in
        // month order, only that each individual batch is internally newest-first (as PhotoKit's
        // fetch result guarantees).
        index.append([
            FakeAsset(localIdentifier: "feb-2", creationDate: Self.date(2024, 2, 20)),
            FakeAsset(localIdentifier: "feb-1", creationDate: Self.date(2024, 2, 5)),
        ])
        index.append([
            FakeAsset(localIdentifier: "jan-1", creationDate: Self.date(2024, 1, 10))
        ])
        #expect(index.count == 3)
        let months = index.months
        #expect(months.map(\.id) == [Self.date(2024, 2, 1), Self.date(2024, 1, 1)])
        #expect(months[0].assets.map(\.localIdentifier) == ["feb-2", "feb-1"])
        #expect(months[1].assets.map(\.localIdentifier) == ["jan-1"])
    }

    @Test func removingTheLastAssetInAMonthDropsThatMonth() {
        var index = makeIndex()
        let lonely = FakeAsset(localIdentifier: "solo", creationDate: Self.date(2024, 3, 1))
        index.append([lonely])
        #expect(index.months.map(\.id) == [Self.date(2024, 3, 1)])
        index.apply(removed: [lonely], inserted: [], changed: [])
        #expect(index.months.isEmpty)
        #expect(index.count == 0)
        #expect(index.asset(for: "solo") == nil)
    }

    @Test func changedAssetMovesMonthsWhenItsCreationDateChanged() {
        var index = makeIndex()
        let original = FakeAsset(localIdentifier: "moved", creationDate: Self.date(2024, 1, 15))
        index.append([original])
        #expect(index.months.map(\.id) == [Self.date(2024, 1, 1)])
        let moved = FakeAsset(localIdentifier: "moved", creationDate: Self.date(2024, 5, 1))
        index.apply(removed: [], inserted: [], changed: [moved])
        #expect(index.months.map(\.id) == [Self.date(2024, 5, 1)])
        #expect(index.asset(for: "moved") == moved)
        #expect(index.count == 1)
    }

    @Test func monthsAreSortedNewestFirstAndAssetsWithinAMonthAreNewestFirst() {
        var index = makeIndex()
        index.append([
            FakeAsset(localIdentifier: "jan-old", creationDate: Self.date(2024, 1, 1)),
            FakeAsset(localIdentifier: "jan-new", creationDate: Self.date(2024, 1, 30)),
            FakeAsset(localIdentifier: "mar", creationDate: Self.date(2024, 3, 1)),
            FakeAsset(localIdentifier: "feb", creationDate: Self.date(2024, 2, 1)),
        ])
        let months = index.months
        #expect(months.map(\.id) == [Self.date(2024, 3, 1), Self.date(2024, 2, 1), Self.date(2024, 1, 1)])
        #expect(months.last?.assets.map(\.localIdentifier) == ["jan-new", "jan-old"])
    }

    @Test func insertedAssetsAreAddedAndAppearInTheirMonth() {
        var index = makeIndex()
        let existing = FakeAsset(localIdentifier: "existing", creationDate: Self.date(2024, 1, 1))
        index.append([existing])
        let inserted = FakeAsset(localIdentifier: "new", creationDate: Self.date(2024, 1, 20))
        index.apply(removed: [], inserted: [inserted], changed: [])
        #expect(index.count == 2)
        #expect(index.months.first?.assets.map(\.localIdentifier) == ["new", "existing"])
    }
}
