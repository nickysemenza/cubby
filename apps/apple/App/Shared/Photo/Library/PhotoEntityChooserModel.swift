import CubbyKit
import Foundation
import Observation

/// Photo-destination policy around two generic entity lists. Date matches and recent records are
/// independent `GenericEntityListModel` lanes with their own pages and errors, so one unavailable
/// lane never hides the other; this owner keeps only the policy between them: the capture-date
/// scope, recents skipping capture-day rows, and the photo search on the recent lane.
///
/// Only the date lane is scoped by the capture date. Recents page the unscoped list and drop the
/// capture day as they are read, so a scope change rebinds one lane synchronously (inside
/// `setSource`, before its load suspends) and the two lanes can never disagree about the day.
@MainActor
@Observable
final class PhotoEntityChooserModel {
    typealias Loader =
        @Sendable (
            _ filters: EntityFilterState, _ query: String?, _ page: Int, _ sort: String?
        ) async throws -> ListPage<EntityRow>

    let descriptor: EntityDescriptor
    private(set) var captureDate: Date?
    /// The current device Gregorian day used by callers that need the photo workflow's day
    /// boundary; keeping it on the policy model makes timezone behavior injectable in tests.
    let currentGregorianDay: Date
    private let dateLane: GenericEntityListModel
    private let recentLane: GenericEntityListModel
    /// The one owner of recent next-page requests; see `drainRecents`.
    private(set) var drainTask: Task<Void, Never>?
    private var drainGeneration = 0
    private var recentTarget = 0
    private var isDrainingRecents: Bool { drainTask != nil }
    /// Bumped by every `setScope`; a continuation from an older scope stops at its next await.
    private var scopeGeneration = 0
    /// Dismissal invalidates pending lane continuations, including unstructured refresh tasks.
    private var lifecycleGeneration = 0

    private let loader: Loader
    private let calendar: Calendar
    private let semanticDateKey: String?

    var hasDateMatches: Bool { captureDate != nil && semanticDateKey != nil }
    var search: EntityListSearchModel? { recentLane.searchModel }
    var isSearching: Bool { recentLane.isSearching }
    var searchRows: [EntityRow] { search?.rows ?? [] }
    var dateMatches: [EntityRow] { hasDateMatches ? dateLane.rows : [] }
    var recentRows: [EntityRow] {
        recentLane.rows.filter {
            !Self.isSameSemanticDay($0, key: semanticDateKey, captureDate: captureDate, calendar: calendar)
        }
    }
    var hasMoreDateMatches: Bool { hasDateMatches && dateLane.hasMore }
    var hasMoreRecents: Bool { recentLane.hasMore }
    var dateError: String? { hasDateMatches ? Self.error(in: dateLane) : nil }
    var recentError: String? { Self.error(in: recentLane) }
    var isLoadingDateNextPage: Bool { dateLane.activity == .loadingNextPage }
    var isLoadingRecentNextPage: Bool { recentLane.activity == .loadingNextPage || isDrainingRecents }
    var isLoading: Bool {
        recentLane.phase == .idle || isDrainingRecents
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
            source: Self.recentSource(descriptor: descriptor, loader: loader),
            searchDebounceNanoseconds: searchDebounceNanoseconds)
    }

    func loadInitial() async {
        let lifecycle = lifecycleGeneration
        await dateLane.loadInitial()
        guard lifecycle == lifecycleGeneration else { return }
        await recentLane.loadInitial()
        guard lifecycle == lifecycleGeneration else { return }
        await drainRecents(toVisible: 1, .join)
    }

    /// A refresh supersedes the lane's in-flight page, so it also replaces the drain: the old
    /// owner may still be suspended on that obsolete page and must not hold recents hostage.
    func refresh() async {
        stopPaging()
        let lifecycle = lifecycleGeneration
        await dateLane.refresh()
        guard lifecycle == lifecycleGeneration else { return }
        await recentLane.refresh()
        guard lifecycle == lifecycleGeneration else { return }
        await drainRecents(toVisible: 1, .restart)
    }

    /// Stops recent draining (the chooser was dismissed). A page already in flight still
    /// completes inside the list model, whose request task does not observe this cancellation;
    /// its rows land in the cached model, and no further page is requested. Reappearance joins
    /// that surviving page before its replacement drain decides whether to request another.
    /// Returns once the recent-lane drain, including any drain that replaced it, has ended.
    func drained() async {
        while let drainTask { await drainTask.value }
    }

    func stopPaging() {
        lifecycleGeneration += 1
        drainTask?.cancel()
        drainTask = nil
        drainGeneration += 1
        recentTarget = 0
    }

    /// Re-scopes to a changed photo selection. The capture date and the date lane's source change
    /// together before anything suspends, so no row from the old capture date stays tappable and
    /// recents immediately exclude the new day. A superseded scope's continuation is a no-op.
    func setScope(captureDates: [Date?]) async {
        let newDate = captureDates.compactMap { $0 }.min()
        guard newDate != captureDate else { return }
        captureDate = newDate
        scopeGeneration += 1
        let generation = scopeGeneration
        let lifecycle = lifecycleGeneration
        await dateLane.setSource(
            Self.dateSource(
                descriptor: descriptor, key: semanticDateKey, captureDate: newDate,
                calendar: calendar, loader: loader))
        guard generation == scopeGeneration, lifecycle == lifecycleGeneration else { return }
        await drainRecents(toVisible: 1, .retarget)
    }

    func setSearchQuery(_ query: String) {
        recentLane.setSearchQuery(query)
    }

    func loadMoreDateMatches() async {
        guard hasMoreDateMatches else { return }
        await dateLane.loadNextPage()
    }

    func loadMoreRecents() async {
        await drainRecents(toVisible: recentRows.count + 1, .join)
    }

    private enum DrainStart {
        /// Raise a running drain's target and wait for it (load more, first load).
        case join
        /// Replace a running drain's target and return; its in-flight page is still wanted
        /// because recents are unscoped (scope change). Starts a drain when none runs.
        case retarget
        /// A load-more may start while refresh awaits either lane. Replace that owner as well.
        case restart
    }

    /// Pages recents until `target` rows are visible, advancing over pages that add nothing
    /// visible (capture-day-only pages); the server's total stays authoritative, so records
    /// beyond a photo's capture day remain reachable. Exactly one `drainTask` issues recent
    /// next-page requests. Scope-task cancellation never cancels this model-owned work; only
    /// dismissal or refresh stops it through `stopPaging`.
    private func drainRecents(toVisible target: Int, _ start: DrainStart) async {
        if let running = drainTask, start != .restart {
            recentTarget = start == .retarget ? target : max(recentTarget, target)
            if start == .retarget { return }
            await running.value
            return
        }
        drainTask?.cancel()
        drainGeneration += 1
        let generation = drainGeneration
        recentTarget = target
        let task = Task { await self.drain(generation: generation) }
        drainTask = task
        await task.value
    }

    private func drain(generation: Int) async {
        defer {
            // A replaced or stopped drain finishing late leaves the current owner's state alone.
            if generation == drainGeneration {
                drainTask = nil
                recentTarget = 0
            }
        }
        while !Task.isCancelled, recentRows.count < recentTarget, recentLane.hasMore {
            let page = recentLane.page
            await recentLane.loadNextPage()
            // Cancelled, replaced, failed or blocked: stop, never spin. A failure's error (with
            // its retry) or the replacing drain takes over.
            guard !Task.isCancelled, generation == drainGeneration, recentLane.page > page else { return }
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
        return EntityListPageSource(id: captureDate) { page in
            guard let filters, key != nil else {
                return ListPage(items: [], meta: ListPageMeta(pageIndex: page, pageSize: 25, totalCount: 0))
            }
            return try await loader(filters, nil, page, "-updatedAt")
        }
    }

    /// Recently edited records, unscoped; `recentRows` drops the capture day's. The photo search
    /// sits on this lane's source.
    private static func recentSource(
        descriptor: EntityDescriptor, loader: @escaping Loader
    ) -> EntityListPageSource {
        let loadPage: EntityListPageSource.PageLoader = { page in
            try await loader(EntityFilterState(), nil, page, "-updatedAt")
        }
        let searchPage: EntityListSearchModel.PageLoader = { query, page in
            try await loader(EntityFilterState(), query, page, nil)
        }
        return EntityListPageSource(
            id: "recent", loadPage: loadPage,
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
