import CubbyKit
import Foundation
import Synchronization
import Testing

@testable import Cubby

@MainActor
@Suite("Photo entity chooser")
struct PhotoEntityChooserModelTests {
    @Test func recentPagesAdvancePastSameDayRowsAndDateMatchesStayIndependent() async throws {
        let captureDate = Self.day("2026-09-10")
        let today = Self.day("2026-09-17")
        let descriptor = EntityCatalog[.meal]
        let model = PhotoEntityChooserModel(
            descriptor: descriptor, client: try makeClient(),
            captureDates: [captureDate, nil],
            calendar: Self.utcCalendar,
            now: today,
            loader: { filters, _, page, _ in
                if filters["from"] != nil {
                    return Self.page([Self.row("MEA-match", date: "2026-09-10")], page: page, total: 1)
                }
                switch page {
                case 1: return Self.page([Self.row("MEA-capture", date: "2026-09-10")], page: 1, total: 3)
                case 2: return Self.page([Self.row("MEA-capture-2", date: "2026-09-10")], page: 2, total: 3)
                default: return Self.page([Self.row("MEA-recent", date: "2026-09-01")], page: 3, total: 3)
                }
            })

        await model.loadInitial()

        #expect(model.dateMatches.map { $0.id } == ["MEA-match"])
        #expect(model.recentRows.map { $0.id } == ["MEA-recent"])
        #expect(model.dateError == nil)
        #expect(model.recentError == nil)
    }

    /// A query still in flight neither empties nor merges the lanes: both lanes page on (recents
    /// over a capture-day-only page) and keep their own rows, and the query lands only in search.
    /// Capture-date scopes changed A→B→C while a query is pending, with C's date page resolving
    /// before B's, leave both lanes on C: B's late continuation never re-scopes either lane.
    @Test func scopeChangeWhileQueryIsPendingKeepsDateAndRecentLanesApart() async throws {
        let searchCalls = Mutex(0)
        let firstQuery = Gate()
        let secondQuery = Gate()
        let dateStarted = Mutex<Set<String>>([])
        let scopeB = Gate()
        let scopeC = Gate()
        let model = PhotoEntityChooserModel(
            descriptor: EntityCatalog[.meal], client: try makeClient(),
            captureDates: [Self.day("2026-09-10")],
            calendar: Self.utcCalendar,
            now: Self.day("2026-09-17"),
            searchDebounceNanoseconds: 1_000,
            loader: { filters, query, page, _ in
                if let query {
                    let call = searchCalls.withLock { value in
                        value += 1
                        return value
                    }
                    await (call == 1 ? firstQuery : secondQuery).wait()
                    return Self.page([Self.row("MEA-\(query)", date: "2026-08-01")], page: page, total: 1)
                }
                if let day = filters["from"]?.strings.first {
                    dateStarted.withLock { _ = $0.insert(day) }
                    if page == 1, day == "2026-09-05" { await scopeB.wait() }
                    if page == 1, day == "2026-09-01" { await scopeC.wait() }
                    return Self.page([Self.row("MEA-\(day)-\(page)", date: day)], page: page, total: 2)
                }
                let date = ["2026-09-01", "2026-09-10", "2026-09-05", "2026-09-03"][page - 1]
                return Self.page([Self.row("MEA-recent-\(date)", date: date)], page: page, total: 4)
            })

        await model.loadInitial()
        model.setSearchQuery("plum")
        #expect(await waitUntil { searchCalls.withLock { $0 } == 1 })
        #expect(model.isSearching)
        #expect(model.searchRows.isEmpty)

        await model.loadMoreDateMatches()
        await model.loadMoreRecents()
        #expect(model.dateMatches.map(\.id) == ["MEA-2026-09-10-1", "MEA-2026-09-10-2"])
        #expect(model.recentRows.map(\.id) == ["MEA-recent-2026-09-01", "MEA-recent-2026-09-05"])
        #expect(!model.hasMoreDateMatches)

        firstQuery.open()
        #expect(await waitUntil { model.searchRows.map(\.id) == ["MEA-plum"] })
        #expect(model.dateMatches.map(\.id) == ["MEA-2026-09-10-1", "MEA-2026-09-10-2"])

        model.setSearchQuery("fig")
        #expect(await waitUntil { searchCalls.withLock { $0 } == 2 })
        let toB = Task { await model.setScope(captureDates: [Self.day("2026-09-05")]) }
        #expect(await waitUntil { dateStarted.withLock { $0.contains("2026-09-05") } })
        let toC = Task { await model.setScope(captureDates: [Self.day("2026-09-01"), nil]) }
        #expect(await waitUntil { dateStarted.withLock { $0.contains("2026-09-01") } })
        // Both lanes describe C while its date page is in flight: C's day leaves recents and
        // B's and A's days stay in them.
        #expect(model.dateMatches.isEmpty)
        #expect(model.recentRows.map(\.id) == ["MEA-recent-2026-09-10", "MEA-recent-2026-09-05"])

        scopeC.open()
        await toC.value
        scopeB.open()
        await toB.value
        #expect(model.dateMatches.map(\.id) == ["MEA-2026-09-01-1"])
        #expect(model.recentRows.map(\.id) == ["MEA-recent-2026-09-10", "MEA-recent-2026-09-05"])

        secondQuery.open()
        #expect(await waitUntil { model.searchRows.map(\.id) == ["MEA-fig"] })

        await model.loadMoreDateMatches()
        await model.loadMoreRecents()
        #expect(model.dateMatches.map(\.id) == ["MEA-2026-09-01-1", "MEA-2026-09-01-2"])
        #expect(
            model.recentRows.map(\.id) == [
                "MEA-recent-2026-09-10", "MEA-recent-2026-09-05", "MEA-recent-2026-09-03",
            ])
        #expect(!model.hasMoreRecents)
    }

    @Test func noCaptureDateLoadsOnlyRecentLane() async throws {
        let descriptor = EntityCatalog[.product]
        let model = PhotoEntityChooserModel(
            descriptor: descriptor, client: try makeClient(),
            captureDates: [nil],
            now: Self.day("2026-09-17"),
            loader: { filters, _, _, _ in
                #expect(filters.isEmpty)
                return Self.page([Self.row("PRD-recent", date: nil)], page: 1, total: 1)
            })

        await model.loadInitial()

        #expect(model.dateMatches.isEmpty)
        #expect(model.recentRows.map { $0.id } == ["PRD-recent"])
    }

    @Test func unsupportedDescriptorDoesNotExposePhotoSearch() async throws {
        let descriptor = EntityCatalog[.ledgerParty]
        let recorder = FilterRecorder()
        let model = PhotoEntityChooserModel(
            descriptor: descriptor, client: try makeClient(),
            captureDates: [nil],
            now: Self.day("2026-09-17"),
            loader: { filters, query, page, sort in
                recorder.append(filters: filters, query: query, page: page, sort: sort)
                return Self.page([Self.row("LED-recent", date: nil)], page: page, total: 1)
            })

        #expect(model.search == nil)
        model.setSearchQuery("LED-1")
        #expect(model.isSearching == false)
        await model.loadInitial()
        #expect(recorder.snapshot().contains { $0.query == nil })
    }

    @Test(arguments: ["purchase", "gardenEntry", "meal", "inventory"])
    func dateLaneUsesGeneratedEntityDateRange(rawKey: String) async throws {
        let key = try #require(EntityKey(rawValue: rawKey))
        let expectedNames: Set<String> =
            switch rawKey {
            case "purchase": ["dateFrom", "dateTo"]
            case "gardenEntry": ["observedOnFrom", "observedOnTo"]
            case "inventory": ["verifiedFrom", "verifiedTo"]
            default: ["from", "to"]
            }
        let captureDate = Self.day("2026-09-10")
        let recorder = FilterRecorder()
        let model = PhotoEntityChooserModel(
            descriptor: EntityCatalog[key], client: try makeClient(),
            captureDates: [captureDate],
            now: Self.day("2026-09-17"),
            loader: { filters, query, page, sort in
                recorder.append(filters: filters, query: query, page: page, sort: sort)
                return Self.page([Self.row("match-\(key.rawValue)", date: nil)], page: page, total: 1)
            })

        await model.loadInitial()

        #expect(recorder.snapshot().first?.filters.names == expectedNames.sorted())
    }

    /// `inventory.verifiedAt` is a `.timestamp` field (unlike `purchase`/`gardenEntry`/`meal`'s
    /// `.date` fields above), so its range must be a ±1 hour window around the capture instant,
    /// not a day boundary — this was the divergent behavior the shared helper needed to preserve.
    @Test func timestampFieldUsesAnISOPlusMinusOneHourWindow() throws {
        let descriptor = EntityCatalog[.inventory]
        let key = try #require(PhotoEntityChooserModel.semanticDateKey(for: descriptor))
        #expect(key == "verifiedAt")
        let captureDate = Self.instant("2026-09-10T12:00:00Z")

        let filters = PhotoEntityChooserModel.captureDateFilters(
            descriptor: descriptor, key: key, captureDate: captureDate)

        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        #expect(
            filters["verifiedFrom"]?.strings.first
                == formatter.string(from: captureDate.addingTimeInterval(-3_600)))
        #expect(
            filters["verifiedTo"]?.strings.first
                == formatter.string(from: captureDate.addingTimeInterval(3_600)))
    }

    @Test func dateLaneFailureDoesNotHideRecentLane() async throws {
        enum LaneFailure: Error { case date }
        let descriptor = EntityCatalog[.meal]
        let model = PhotoEntityChooserModel(
            descriptor: descriptor, client: try makeClient(),
            captureDates: [Self.day("2026-09-10")],
            now: Self.day("2026-09-17"),
            loader: { filters, _, page, _ in
                if filters["from"] != nil { throw LaneFailure.date }
                return Self.page([Self.row("MEA-recent", date: "2026-09-01")], page: page, total: 1)
            })

        await model.loadInitial()

        #expect(model.dateError != nil)
        #expect(model.recentError == nil)
        #expect(model.recentRows.map(\.id) == ["MEA-recent"])
    }

    @Test func currentGregorianDayHonorsInjectedTimezone() async throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: -8 * 60 * 60)!
        let now = Self.day("2026-09-17").addingTimeInterval(6 * 60 * 60)
        let model = PhotoEntityChooserModel(
            descriptor: EntityCatalog[.product], client: try makeClient(), captureDates: [nil],
            calendar: calendar, now: now,
            loader: { _, _, _, _ in
                Self.page([Self.row("PRD-recent", date: nil)], page: 1, total: 1)
            })

        #expect(model.currentGregorianDay == calendar.startOfDay(for: now))
    }

    @Test func semanticDateMatchingUsesThePhotoDevicesLocalDay() async throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: -7 * 60 * 60)!
        let captureDate = Self.instant("2026-09-10T06:30:00Z")
        let model = PhotoEntityChooserModel(
            descriptor: EntityCatalog[.meal], client: try makeClient(), captureDates: [captureDate],
            calendar: calendar,
            now: captureDate,
            loader: { filters, _, _, _ in
                if filters["from"] != nil {
                    return Self.page([], page: 1, total: 0)
                }
                // 06:30Z is 23:30 on the prior local day. This row must remain in the
                // date-matched lane rather than being shown as a recent record.
                return Self.page([Self.row("MEA-local-day", date: "2026-09-09")], page: 1, total: 1)
            })

        await model.loadInitial()

        #expect(model.recentRows.isEmpty)
    }

    private func makeClient() throws -> CubbyClient {
        let store = InMemorySessionTokenStore()
        try store.save(.bearer("tok"), for: "localhost:3000")
        return CubbyClient(
            baseURL: URL(string: "http://localhost:3000")!,
            credentials: CredentialProvider(host: "localhost:3000", store: store))
    }

    private func waitUntil(_ condition: @MainActor () -> Bool) async -> Bool {
        for _ in 0..<2_000 {
            if condition() { return true }
            try? await Task.sleep(nanoseconds: 1_000_000)
        }
        return condition()
    }

    private nonisolated static func day(_ value: String) -> Date {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.date(from: value)!
    }

    private nonisolated static var utcCalendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        return calendar
    }

    private nonisolated static func instant(_ value: String) -> Date {
        ISO8601DateFormatter().date(from: value)!
    }

    private nonisolated static func row(_ id: String, date: String?) -> EntityRow {
        var raw: [String: JSONValue] = ["id": .string(id), "name": .string(id)]
        if let date { raw["date"] = .string(date) }
        return EntityRow(id: id, title: id, subtitle: nil, imageURL: nil, raw: .object(raw))
    }

    private nonisolated static func page(
        _ rows: [EntityRow], page: Int, total: Int
    ) -> ListPage<EntityRow> {
        ListPage(items: rows, meta: ListPageMeta(pageIndex: page, pageSize: 1, totalCount: total))
    }
}

private nonisolated final class FilterRecorder: @unchecked Sendable {
    struct Call: Sendable {
        let filters: EntityFilterState
        let query: String?
        let page: Int
        let sort: String?
    }

    private let lock = NSLock()
    private var calls: [Call] = []

    nonisolated func append(filters: EntityFilterState, query: String?, page: Int, sort: String?) {
        lock.lock()
        calls.append(Call(filters: filters, query: query, page: page, sort: sort))
        lock.unlock()
    }

    nonisolated func snapshot() -> [Call] {
        lock.lock()
        defer { lock.unlock() }
        return calls
    }
}

/// A one-shot release for a test loader; waiting ignores cancellation so a superseded request
/// completes only when the test releases it.
private final class Gate: Sendable {
    private let state = Mutex<(isOpen: Bool, waiters: [CheckedContinuation<Void, Never>])>(
        (false, []))

    func wait() async {
        await withCheckedContinuation { continuation in
            let isOpen = state.withLock { state in
                if !state.isOpen { state.waiters.append(continuation) }
                return state.isOpen
            }
            if isOpen { continuation.resume() }
        }
    }

    func open() {
        let waiters = state.withLock { state in
            state.isOpen = true
            defer { state.waiters = [] }
            return state.waiters
        }
        for waiter in waiters { waiter.resume() }
    }
}
