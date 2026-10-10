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
                    await (call == 1 ? firstQuery : secondQuery).hold()
                    return Self.page([Self.row("MEA-\(query)", date: "2026-08-01")], page: page, total: 1)
                }
                if let day = filters["from"]?.strings.first {
                    if page == 1, day == "2026-09-05" { await scopeB.hold() }
                    if page == 1, day == "2026-09-01" { await scopeC.hold() }
                    return Self.page([Self.row("MEA-\(day)-\(page)", date: day)], page: page, total: 2)
                }
                let date = ["2026-09-01", "2026-09-10", "2026-09-05", "2026-09-03"][page - 1]
                return Self.page([Self.row("MEA-recent-\(date)", date: date)], page: page, total: 4)
            })

        await model.loadInitial()
        model.setSearchQuery("plum")
        await firstQuery.arrivals(1)
        #expect(model.isSearching)
        #expect(model.searchRows.isEmpty)

        await model.loadMoreDateMatches()
        await model.loadMoreRecents()
        #expect(model.dateMatches.map(\.id) == ["MEA-2026-09-10-1", "MEA-2026-09-10-2"])
        #expect(model.recentRows.map(\.id) == ["MEA-recent-2026-09-01", "MEA-recent-2026-09-05"])
        #expect(!model.hasMoreDateMatches)

        firstQuery.open()
        await observe { model.searchRows.map(\.id) == ["MEA-plum"] }
        #expect(model.dateMatches.map(\.id) == ["MEA-2026-09-10-1", "MEA-2026-09-10-2"])

        model.setSearchQuery("fig")
        await secondQuery.arrivals(1)
        let toB = Task { await model.setScope(captureDates: [Self.day("2026-09-05")]) }
        await scopeB.arrivals(1)
        let toC = Task { await model.setScope(captureDates: [Self.day("2026-09-01"), nil]) }
        await scopeC.arrivals(1)
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
        await observe { model.searchRows.map(\.id) == ["MEA-fig"] }

        await model.loadMoreDateMatches()
        await model.loadMoreRecents()
        #expect(model.dateMatches.map(\.id) == ["MEA-2026-09-01-1", "MEA-2026-09-01-2"])
        #expect(
            model.recentRows.map(\.id) == [
                "MEA-recent-2026-09-10", "MEA-recent-2026-09-05", "MEA-recent-2026-09-03",
            ])
        #expect(!model.hasMoreRecents)
    }

    /// Scope A shows one B-day recent; page 2 (B-day rows only) is held while the scope moves to
    /// B and B's date page finishes. When page 2 lands, recents keep draining to page 3 instead
    /// of stopping on a baseline taken under scope A.
    @Test func scopeChangeDuringARecentPageKeepsDrainingUnderTheNewScope() async throws {
        let pageTwo = Gate()
        let requested = Mutex<[Int]>([])
        let model = PhotoEntityChooserModel(
            descriptor: EntityCatalog[.meal], client: try makeClient(),
            captureDates: [Self.day("2026-09-10")],
            calendar: Self.utcCalendar,
            now: Self.day("2026-09-17"),
            loader: { filters, _, page, _ in
                if let day = filters["from"]?.strings.first {
                    return Self.page([Self.row("MEA-\(day)", date: day)], page: page, total: 1)
                }
                requested.withLock { $0.append(page) }
                if page == 2 { await pageTwo.hold() }
                let date = ["2026-09-05", "2026-09-05", "2026-09-03"][page - 1]
                return Self.page([Self.row("MEA-recent-\(page)", date: date)], page: page, total: 3)
            })

        await model.loadInitial()
        #expect(model.recentRows.map(\.id) == ["MEA-recent-1"])

        let loadMore = Task { await model.loadMoreRecents() }
        await pageTwo.arrivals(1)
        await model.setScope(captureDates: [Self.day("2026-09-05")])
        #expect(model.dateMatches.map(\.id) == ["MEA-2026-09-05"])
        #expect(model.recentRows.isEmpty)
        #expect(model.isLoading)

        pageTwo.open()
        await loadMore.value
        #expect(requested.withLock { $0 } == [1, 2, 3])
        #expect(model.recentRows.map(\.id) == ["MEA-recent-3"])
        #expect(!model.hasMoreRecents)
        #expect(!model.isLoading)
    }

    /// A drain stuck on a recent page whose loader ignores cancellation must not hold a refresh
    /// hostage: the refresh replaces it, drains past an empty first page, and finishes while
    /// the obsolete page is still outstanding; that page's late rows never appear.
    @Test func refreshReplacesADrainStuckOnAnObsoletePage() async throws {
        let calls = Mutex<[Int]>([])
        let stuck = Gate()
        let model = PhotoEntityChooserModel(
            descriptor: EntityCatalog[.meal], client: try makeClient(),
            captureDates: [Self.day("2026-09-10")],
            calendar: Self.utcCalendar,
            now: Self.day("2026-09-17"),
            loader: { filters, _, page, _ in
                if let day = filters["from"]?.strings.first {
                    return Self.page([Self.row("MEA-\(day)", date: day)], page: page, total: 1)
                }
                let call = calls.withLock { calls in
                    calls.append(page)
                    return calls.filter { $0 == page }.count
                }
                if page == 2, call == 1 { await stuck.hold() }
                let row: EntityRow =
                    switch (page, call) {
                    case (1, 1): Self.row("MEA-recent-first", date: "2026-09-01")
                    case (1, _): Self.row("MEA-capture-day", date: "2026-09-10")
                    case (2, 1): Self.row("MEA-obsolete", date: "2026-09-04")
                    case (2, _): Self.row("MEA-recent-2", date: "2026-09-05")
                    default: Self.row("MEA-recent-3", date: "2026-09-03")
                    }
                return Self.page([row], page: page, total: 3)
            })

        await model.loadInitial()
        #expect(model.recentRows.map(\.id) == ["MEA-recent-first"])
        let loadMore = Task { await model.loadMoreRecents() }
        await stuck.arrivals(1)

        await model.refresh()
        #expect(model.recentRows.map(\.id) == ["MEA-recent-2"])
        #expect(!model.isLoading)
        #expect(calls.withLock { $0 } == [1, 2, 1, 2])

        stuck.open()
        await loadMore.value
        #expect(model.recentRows.map(\.id) == ["MEA-recent-2"])
        #expect(!model.isLoading)
    }

    /// A load-more can start while refresh awaits its independent date lane. The completed
    /// refresh must replace that drain too, even if its obsolete recent page ignores cancellation.
    // A refresh that waited on the held page would hang; the limit turns that into a failure.
    @Test(.timeLimit(.minutes(1))) func refreshReplacesADrainStartedDuringItsDateRequest() async throws {
        let calls = Mutex<[Int]>([])
        let dateCalls = Mutex(0)
        let dateRefresh = Gate()
        let stalePage = Gate()
        let model = PhotoEntityChooserModel(
            descriptor: EntityCatalog[.meal], client: try makeClient(),
            captureDates: [Self.day("2026-09-10")], calendar: Self.utcCalendar,
            loader: { filters, _, page, _ in
                if filters["from"] != nil {
                    let count = dateCalls.withLock {
                        $0 += 1; return $0
                    }
                    if count == 2 { await dateRefresh.hold() }
                    return Self.page([], page: page, total: 0)
                }
                let attempt = calls.withLock {
                    $0.append(page); return $0.filter { $0 == page }.count
                }
                if page == 2, attempt == 1 { await stalePage.hold() }
                let date = page == 1 && attempt > 1 ? "2026-09-10" : "2026-09-01"
                return Self.page(
                    [Self.row("MEA-recent-\(page)-\(attempt)", date: date)], page: page, total: 2)
            })

        await model.loadInitial()
        let refreshing = Task { await model.refresh() }
        await dateRefresh.arrivals(1)
        let more = Task { await model.loadMoreRecents() }
        await stalePage.arrivals(1)
        dateRefresh.open()

        // The refresh finishes while the obsolete page is still held.
        await refreshing.value
        #expect(calls.withLock { $0 } == [1, 2, 1, 2])
        #expect(model.recentRows.map(\.id) == ["MEA-recent-2-2"])
        stalePage.open()
        await more.value
        #expect(model.recentRows.map(\.id) == ["MEA-recent-2-2"])
    }

    /// Dismissal cancels SwiftUI's waiter and explicitly stops model-owned paging: the page
    /// in flight completes, and no later page is requested.
    @Test func dismissalStopsTheDrainEvenWhenItsPageIgnoresCancellation() async throws {
        let calls = Mutex<[Int]>([])
        let pageTwo = Gate()
        let model = PhotoEntityChooserModel(
            descriptor: EntityCatalog[.meal], client: try makeClient(),
            captureDates: [Self.day("2026-09-10")],
            calendar: Self.utcCalendar,
            now: Self.day("2026-09-17"),
            loader: { filters, _, page, _ in
                if filters["from"] != nil { return Self.page([], page: page, total: 0) }
                calls.withLock { $0.append(page) }
                if page == 2 { await pageTwo.hold() }
                // Every recent is on the capture day, so the drain would page to the end.
                return Self.page([Self.row("MEA-same-\(page)", date: "2026-09-10")], page: page, total: 4)
            })

        let initial = Task { await model.loadInitial() }
        await pageTwo.arrivals(1)
        let drain = model.drainTask
        initial.cancel()
        model.stopPaging()
        pageTwo.open()
        await initial.value
        await drain?.value

        #expect(calls.withLock { $0 } == [1, 2])
        #expect(model.hasMoreRecents)
        #expect(!model.isLoading)
    }

    /// A returning chooser must join the surviving page before deciding whether its replacement
    /// drain made progress; otherwise two capture-day pages strand the first visible third page.
    @Test func immediateReappearanceJoinsThePageSurvivingDismissal() async throws {
        let calls = Mutex<[Int]>([])
        let pageTwo = Gate()
        let model = PhotoEntityChooserModel(
            descriptor: EntityCatalog[.meal], client: try makeClient(),
            captureDates: [Self.day("2026-09-10")], calendar: Self.utcCalendar,
            loader: { filters, _, page, _ in
                if filters["from"] != nil { return Self.page([], page: page, total: 0) }
                calls.withLock { $0.append(page) }
                if page == 2 { await pageTwo.hold() }
                let date = page < 3 ? "2026-09-10" : "2026-09-01"
                return Self.page([Self.row("MEA-recent-\(page)", date: date)], page: page, total: 3)
            })

        let initial = Task { await model.loadInitial() }
        await pageTwo.arrivals(1)
        initial.cancel()
        model.stopPaging()
        // The chooser reappears before the surviving page lands.
        let returning = Task.immediate { await model.loadInitial() }
        pageTwo.open()
        await initial.value
        await returning.value

        #expect(calls.withLock { $0 } == [1, 2, 3])
        #expect(model.recentRows.map(\.id) == ["MEA-recent-3"])
        #expect(!model.isLoading)
    }

    /// A surviving refresh replaces cached visible rows with capture-day rows. Reappearance
    /// must join that replacement before deciding whether its visible-row target is satisfied.
    @Test func reappearanceJoinsTheRefreshBeforeEvaluatingCachedRecents() async throws {
        let calls = Mutex<[Int]>([])
        let recentRefresh = Gate()
        let model = PhotoEntityChooserModel(
            descriptor: EntityCatalog[.meal], client: try makeClient(),
            captureDates: [Self.day("2026-09-10")], calendar: Self.utcCalendar,
            loader: { filters, _, page, _ in
                if filters["from"] != nil { return Self.page([], page: page, total: 0) }
                let attempt = calls.withLock {
                    $0.append(page); return $0.filter { $0 == page }.count
                }
                if page == 1, attempt == 2 { await recentRefresh.hold() }
                let date = page == 1 && attempt == 2 ? "2026-09-10" : "2026-09-01"
                return Self.page(
                    [Self.row("MEA-recent-\(page)-\(attempt)", date: date)], page: page, total: 2)
            })

        await model.loadInitial()
        #expect(model.recentRows.map(\.id) == ["MEA-recent-1-1"])
        let refreshing = Task { await model.refresh() }
        await recentRefresh.arrivals(1)
        model.stopPaging()
        // Reappearance joins the held refresh; deciding on the cached rows instead would never
        // request page 2.
        let returning = Task.immediate { await model.loadInitial() }
        recentRefresh.open()
        await refreshing.value
        await returning.value

        #expect(calls.withLock { $0 } == [1, 1, 2])
        #expect(model.recentRows.map(\.id) == ["MEA-recent-2-1"])
        #expect(!model.isLoading)
    }

    /// SwiftUI replaces its capture-date task even for a timestamp change within the same day.
    /// Cancelling that caller cannot cancel the unscoped recent page still needed by the new scope.
    @Test func sameDayScopeTaskReplacementKeepsTheRetargetedDrainAlive() async throws {
        let calls = Mutex<[Int]>([])
        let pageTwo = Gate()
        let model = PhotoEntityChooserModel(
            descriptor: EntityCatalog[.meal], client: try makeClient(),
            captureDates: [Self.day("2026-09-10")], calendar: Self.utcCalendar,
            loader: { filters, _, page, _ in
                if filters["from"] != nil { return Self.page([], page: page, total: 0) }
                calls.withLock { $0.append(page) }
                if page == 2 { await pageTwo.hold() }
                let date = page < 3 ? "2026-09-05" : "2026-09-01"
                return Self.page([Self.row("MEA-recent-\(page)", date: date)], page: page, total: 3)
            })

        await model.loadInitial()
        let toB = Task { await model.setScope(captureDates: [Self.day("2026-09-05")]) }
        await pageTwo.arrivals(1)
        toB.cancel()
        await model.setScope(captureDates: [Self.day("2026-09-05").addingTimeInterval(60)])
        pageTwo.open()
        await toB.value
        await model.drained()
        #expect(!model.isLoading)

        #expect(calls.withLock { $0 } == [1, 2, 3])
        #expect(model.recentRows.map(\.id) == ["MEA-recent-3"])
    }

    /// Refresh is launched by an unstructured button task. Dismissal while the date request is
    /// held must invalidate its continuation so it never starts the recent lane offscreen.
    @Test func dismissedRefreshDoesNotStartRecentsAfterTheDateRequestCompletes() async throws {
        let calls = Mutex<[Int]>([])
        let dateCalls = Mutex(0)
        let dateRefresh = Gate()
        let model = PhotoEntityChooserModel(
            descriptor: EntityCatalog[.meal], client: try makeClient(),
            captureDates: [Self.day("2026-09-10")], calendar: Self.utcCalendar,
            loader: { filters, _, page, _ in
                if filters["from"] != nil {
                    let count = dateCalls.withLock {
                        $0 += 1; return $0
                    }
                    if count == 2 { await dateRefresh.hold() }
                    return Self.page([], page: page, total: 0)
                }
                let count = calls.withLock {
                    $0.append(page); return $0.count
                }
                let date = count == 1 || page == 3 ? "2026-09-01" : "2026-09-10"
                return Self.page([Self.row("MEA-recent-\(page)", date: date)], page: page, total: 3)
            })

        await model.loadInitial()
        let refreshing = Task { await model.refresh() }
        await dateRefresh.arrivals(1)
        model.stopPaging()
        dateRefresh.open()
        await refreshing.value

        #expect(calls.withLock { $0 } == [1])
        #expect(model.recentRows.map(\.id) == ["MEA-recent-1"])
        #expect(!model.isLoading)
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
