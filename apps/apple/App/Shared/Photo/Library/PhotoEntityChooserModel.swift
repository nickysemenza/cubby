import CubbyKit
import Foundation
import Observation

/// Photo-destination policy around two generic entity lists. Date matches and recent records are
/// independent `GenericEntityListModel` lanes with their own pages and errors, so one unavailable
/// lane never hides the other; this owner keeps only the policy between them: the capture-date
/// scope, recents skipping capture-day rows, and the photo search on the recent lane.
@MainActor
@Observable
final class PhotoEntityChooserModel {
    typealias Loader =
        @Sendable (
            _ filters: EntityFilterState, _ query: String?, _ page: Int, _ sort: String?
        ) async throws -> ListPage<EntityRow>

    /// A lane's scope identity: a new capture date re-scopes both lanes (recents exclude the
    /// capture day) through `setSource`, which drops the old scope's rows.
    private nonisolated struct LaneScope: Hashable, Sendable {
        let lane: String
        let captureDate: Date?
    }

    let descriptor: EntityDescriptor
    private(set) var captureDate: Date?
    /// The current device Gregorian day used by callers that need the photo workflow's day
    /// boundary; keeping it on the policy model makes timezone behavior injectable in tests.
    let currentGregorianDay: Date
    private let dateLane: GenericEntityListModel
    private let recentLane: GenericEntityListModel
    private var isAdvancingRecents = false

    private let loader: Loader
    private let calendar: Calendar
    private let semanticDateKey: String?

    var hasDateMatches: Bool { captureDate != nil && semanticDateKey != nil }
    var search: EntityListSearchModel? { recentLane.searchModel }
    var isSearching: Bool { recentLane.isSearching }
    var searchRows: [EntityRow] { search?.rows ?? [] }
    var dateMatches: [EntityRow] { hasDateMatches ? dateLane.rows : [] }
    var recentRows: [EntityRow] { recentLane.rows }
    var hasMoreDateMatches: Bool { hasDateMatches && dateLane.hasMore }
    var hasMoreRecents: Bool { recentLane.hasMore }
    var dateError: String? { hasDateMatches ? Self.error(in: dateLane) : nil }
    var recentError: String? { Self.error(in: recentLane) }
    var isLoadingDateNextPage: Bool { dateLane.activity == .loadingNextPage }
    var isLoadingRecentNextPage: Bool { recentLane.activity == .loadingNextPage || isAdvancingRecents }
    var isLoading: Bool {
        recentLane.phase == .idle || isAdvancingRecents
            || [dateLane, recentLane].contains { $0.activity == .loadingInitial }
    }

    init(
        descriptor: EntityDescriptor,
        client: CubbyClient,
        captureDates: [Date?],
        calendar: Calendar = Calendar(identifier: .gregorian),
        now: Date = .now,
        searchDebounceNanoseconds: UInt64 = 250_000_000,
        loader: @escaping Loader
    ) {
        self.descriptor = descriptor
        let captureDate = captureDates.compactMap { $0 }.min()
        self.captureDate = captureDate
        var calendar = calendar
        calendar.locale = .current
        // Keep the caller's timezone: tests and device-local photo boundaries both depend on
        // the Gregorian calendar being evaluated in the supplied local context.
        self.calendar = calendar
        self.currentGregorianDay = calendar.startOfDay(for: now)
        self.loader = loader
        let semanticDateKey = Self.semanticDateKey(for: descriptor)
        self.semanticDateKey = semanticDateKey
        self.dateLane = GenericEntityListModel(
            descriptor: descriptor, client: client,
            source: Self.dateSource(
                descriptor: descriptor, key: semanticDateKey, captureDate: captureDate,
                calendar: calendar, loader: loader))
        self.recentLane = GenericEntityListModel(
            descriptor: descriptor, client: client,
            source: Self.recentSource(
                descriptor: descriptor, key: semanticDateKey, captureDate: captureDate,
                calendar: calendar, loader: loader),
            searchDebounceNanoseconds: searchDebounceNanoseconds)
    }

    func loadInitial() async {
        await dateLane.loadInitial()
        await recentLane.loadInitial()
        await advanceRecents(whileCountIs: 0)
    }

    func refresh() async {
        await dateLane.refresh()
        await recentLane.refresh()
        await advanceRecents(whileCountIs: 0)
    }

    /// Re-scopes both lanes to a changed photo selection. An active query is replayed against
    /// the new scope, and no row from the old capture date stays tappable.
    func setScope(captureDates: [Date?]) async {
        let newDate = captureDates.compactMap { $0 }.min()
        guard newDate != captureDate else { return }
        captureDate = newDate
        await dateLane.setSource(
            Self.dateSource(
                descriptor: descriptor, key: semanticDateKey, captureDate: newDate,
                calendar: calendar, loader: loader))
        await recentLane.setSource(
            Self.recentSource(
                descriptor: descriptor, key: semanticDateKey, captureDate: newDate,
                calendar: calendar, loader: loader))
        await advanceRecents(whileCountIs: 0)
    }

    func setSearchQuery(_ query: String) {
        recentLane.setSearchQuery(query)
    }

    func loadMoreDateMatches() async {
        guard hasMoreDateMatches else { return }
        await dateLane.loadNextPage()
    }

    func loadMoreRecents() async {
        let count = recentLane.rows.count
        await recentLane.loadNextPage()
        await advanceRecents(whileCountIs: count)
    }

    /// Recent pages advance over pages that add nothing (capture-day-only pages). The server's
    /// total remains authoritative, so a caller can still reach records beyond a photo's
    /// capture day.
    private func advanceRecents(whileCountIs count: Int) async {
        isAdvancingRecents = true
        defer { isAdvancingRecents = false }
        while recentLane.rows.count == count, recentLane.hasMore {
            let page = recentLane.page
            await recentLane.loadNextPage()
            // A failed, superseded or already-running page does not advance: stop, never spin.
            guard recentLane.page > page else { return }
        }
    }

    private static func error(in lane: GenericEntityListModel) -> String? {
        lane.initialError ?? lane.refreshError ?? lane.nextPageError
    }

    private static func dateSource(
        descriptor: EntityDescriptor, key: String?, captureDate: Date?, calendar: Calendar,
        loader: @escaping Loader
    ) -> EntityListPageSource {
        let filters = captureDate.map {
            captureDateFilters(descriptor: descriptor, key: key, captureDate: $0, calendar: calendar)
        }
        return EntityListPageSource(id: LaneScope(lane: "date", captureDate: captureDate)) { page in
            guard let filters, key != nil else {
                return ListPage(items: [], meta: ListPageMeta(pageIndex: page, pageSize: 25, totalCount: 0))
            }
            return try await loader(filters, nil, page, "-updatedAt")
        }
    }

    /// Recently edited records minus the capture day's, which belong to the date lane. The photo
    /// search sits on this lane's source, so a scope change replays a pending query.
    private static func recentSource(
        descriptor: EntityDescriptor, key: String?, captureDate: Date?, calendar: Calendar,
        loader: @escaping Loader
    ) -> EntityListPageSource {
        let loadPage: EntityListPageSource.PageLoader = { page in
            let result = try await loader(EntityFilterState(), nil, page, "-updatedAt")
            let eligible = result.items.filter { row in
                !isSameSemanticDay(row, key: key, captureDate: captureDate, calendar: calendar)
            }
            return ListPage(items: eligible, meta: result.meta)
        }
        let searchPage: EntityListSearchModel.PageLoader = { query, page in
            try await loader(EntityFilterState(), query, page, nil)
        }
        return EntityListPageSource(
            id: LaneScope(lane: "recent", captureDate: captureDate), loadPage: loadPage,
            searchPage: descriptor.primarySearch == nil ? nil : searchPage)
    }

    private nonisolated static func isSameSemanticDay(
        _ row: EntityRow, key: String?, captureDate: Date?, calendar: Calendar
    ) -> Bool {
        guard let captureDate, let key, let raw = row.raw[key]?.stringValue else { return false }
        if raw.count >= 10 {
            return String(raw.prefix(10)) == plainDate(captureDate, calendar: calendar)
        }
        guard let parsed = ISO8601DateFormatter().date(from: raw) else { return false }
        return calendar.isDate(parsed, inSameDayAs: captureDate)
    }

    /// The routing policy's first temporal field the descriptor can actually filter by (a
    /// declared `.date`/`.timestamp` field with a `.range` list filter). Shared by
    /// `PhotoEntityChooserModel`'s own date lane and `PhotoRelatedDestinationChooser`'s related
    /// list filters — the two other places a photo's capture date narrows an entity list.
    static func semanticDateKey(for descriptor: EntityDescriptor) -> String? {
        PhotoImportCatalog.routingPolicies[descriptor.key]?.temporalFields.first { key in
            guard let field = descriptor.field(key), let filter = descriptor.filter(key),
                case .range = filter.wire
            else { return false }
            return field.kind == .date || field.kind == .timestamp
        }
    }

    /// A capture-date range filter for `key` (from `semanticDateKey(for:)`): same-day for a
    /// `.date` field, ±1 hour for a `.timestamp` field (an inventory entry's `verifiedAt`, say, is
    /// rarely stamped exactly at the photo's capture instant). Empty when `key` is `nil` or the
    /// descriptor has no matching `.range` filter.
    static func captureDateFilters(
        descriptor: EntityDescriptor, key: String?, captureDate: Date, calendar: Calendar = .current
    ) -> EntityFilterState {
        guard let key, let dateFilter = descriptor.filter(key),
            case .range(let from, let to, _) = dateFilter.wire
        else { return EntityFilterState() }
        var result = EntityFilterState()
        if descriptor.field(key)?.kind == .timestamp {
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            result.set(.single(formatter.string(from: captureDate.addingTimeInterval(-3_600))), for: from)
            result.set(.single(formatter.string(from: captureDate.addingTimeInterval(3_600))), for: to)
        } else {
            let day = plainDate(captureDate, calendar: calendar)
            result.set(.single(day), for: from)
            result.set(.single(day), for: to)
        }
        return result
    }

    /// `yyyy-MM-dd` in the supplied calendar's time zone. `PlainDate` always uses the device zone,
    /// which is wrong whenever a caller (or a test) evaluates capture days in another zone.
    private nonisolated static func plainDate(_ date: Date, calendar: Calendar) -> String {
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
    }
}
