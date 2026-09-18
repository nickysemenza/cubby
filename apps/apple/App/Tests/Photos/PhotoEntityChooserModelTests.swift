import CubbyKit
import Foundation
import Testing

@testable import Cubby

@MainActor
@Suite("Photo entity chooser")
struct PhotoEntityChooserModelTests {
    @Test func recentPagesAdvancePastSameDayRowsAndDateMatchesStayIndependent() async {
        let captureDate = Self.day("2026-09-10")
        let today = Self.day("2026-09-17")
        let descriptor = EntityCatalog[.meal]
        let model = PhotoEntityChooserModel(
            descriptor: descriptor,
            captureDates: [captureDate, nil],
            pageSize: 1,
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

    @Test func noCaptureDateLoadsOnlyRecentLane() async {
        let descriptor = EntityCatalog[.product]
        let model = PhotoEntityChooserModel(
            descriptor: descriptor,
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

    @Test func unsupportedDescriptorDoesNotExposePhotoSearch() async {
        let descriptor = EntityCatalog[.ledgerParty]
        let recorder = FilterRecorder()
        let model = PhotoEntityChooserModel(
            descriptor: descriptor,
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
            descriptor: EntityCatalog[key],
            captureDates: [captureDate],
            pageSize: 1,
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

    @Test func dateLaneFailureDoesNotHideRecentLane() async {
        enum LaneFailure: Error { case date }
        let descriptor = EntityCatalog[.meal]
        let model = PhotoEntityChooserModel(
            descriptor: descriptor,
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

    @Test func currentGregorianDayHonorsInjectedTimezone() async {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: -8 * 60 * 60)!
        let now = Self.day("2026-09-17").addingTimeInterval(6 * 60 * 60)
        let model = PhotoEntityChooserModel(
            descriptor: EntityCatalog[.product], captureDates: [nil], calendar: calendar, now: now,
            loader: { _, _, _, _ in
                Self.page([Self.row("PRD-recent", date: nil)], page: 1, total: 1)
            })

        #expect(model.currentGregorianDay == calendar.startOfDay(for: now))
    }

    @Test func semanticDateMatchingUsesThePhotoDevicesLocalDay() async {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: -7 * 60 * 60)!
        let captureDate = Self.instant("2026-09-10T06:30:00Z")
        let model = PhotoEntityChooserModel(
            descriptor: EntityCatalog[.meal], captureDates: [captureDate], calendar: calendar,
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
