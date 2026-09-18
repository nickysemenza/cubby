import CubbyKit
import Foundation
import Observation

/// Photo-destination policy around the generic entity-list search state. Date matches and recent
/// records intentionally have independent pages and errors; one unavailable lane must not hide
/// the other lane or turn photo selection into a second search implementation.
@MainActor
@Observable
final class PhotoEntityChooserModel {
    typealias Loader =
        @Sendable (
            _ filters: EntityFilterState, _ query: String?, _ page: Int, _ sort: String?
        ) async throws -> ListPage<EntityRow>

    let descriptor: EntityDescriptor
    let captureDate: Date?
    /// The current device Gregorian day used by callers that need the photo workflow's day
    /// boundary; keeping it on the policy model makes timezone behavior injectable in tests.
    let currentGregorianDay: Date
    let search: EntityListSearchModel?

    private(set) var dateMatches: [EntityRow] = []
    private(set) var recentRows: [EntityRow] = []
    private(set) var dateMeta: ListPageMeta?
    private(set) var recentMeta: ListPageMeta?
    private(set) var datePage = 1
    private(set) var recentPage = 1
    private(set) var dateError: String?
    private(set) var recentError: String?
    private(set) var isLoading = false
    private(set) var isLoadingDateNextPage = false
    private(set) var isLoadingRecentNextPage = false

    private let loader: Loader
    private let calendar: Calendar
    private let semanticDateKey: String?
    private let pageSize: Int
    private var didLoad = false

    var hasSemanticDate: Bool { semanticDateKey != nil }
    var hasDateMatches: Bool { captureDate != nil && hasSemanticDate }
    var isSearching: Bool { !(search?.query.isEmpty ?? true) }
    var searchRows: [EntityRow] { search?.rows ?? [] }

    var hasMoreDateMatches: Bool {
        guard let dateMeta else { return false }
        return datePage * dateMeta.pageSize < dateMeta.totalCount
    }

    var hasMoreRecents: Bool {
        guard let recentMeta else { return false }
        return recentPage * recentMeta.pageSize < recentMeta.totalCount
    }

    init(
        descriptor: EntityDescriptor,
        captureDates: [Date?],
        pageSize: Int = 25,
        calendar: Calendar = Calendar(identifier: .gregorian),
        now: Date = .now,
        loader: @escaping Loader
    ) {
        self.descriptor = descriptor
        self.captureDate = captureDates.compactMap { $0 }.min()
        self.pageSize = pageSize
        var calendar = calendar
        calendar.locale = .current
        // Keep the caller's timezone: tests and device-local photo boundaries both depend on
        // the Gregorian calendar being evaluated in the supplied local context.
        self.calendar = calendar
        self.currentGregorianDay = calendar.startOfDay(for: now)
        self.loader = loader
        self.semanticDateKey = Self.semanticDateKey(for: descriptor)
        self.search = descriptor.primarySearch.map { _ in
            EntityListSearchModel { query, page in
                try await loader(EntityFilterState(), query, page, nil)
            }
        }
    }

    func loadInitial() async {
        guard !didLoad, !isLoading else { return }
        didLoad = true
        isLoading = true
        dateError = nil
        recentError = nil
        if hasDateMatches {
            do { try await loadDatePage(1, replace: true) } catch { dateError = Self.describe(error) }
        }
        do { try await loadRecentPage(1, replace: true) } catch { recentError = Self.describe(error) }
        isLoading = false
    }

    func refresh() async {
        didLoad = true
        dateMatches = []
        recentRows = []
        dateMeta = nil
        recentMeta = nil
        datePage = 1
        recentPage = 1
        isLoading = true
        dateError = nil
        recentError = nil
        if hasDateMatches {
            do { try await loadDatePage(1, replace: true) } catch { dateError = Self.describe(error) }
        }
        do { try await loadRecentPage(1, replace: true) } catch { recentError = Self.describe(error) }
        isLoading = false
    }

    func setSearchQuery(_ query: String) {
        search?.setQuery(query)
    }

    func clearSearch() {
        search?.clear()
    }

    func loadMoreDateMatches() async {
        guard hasDateMatches, hasMoreDateMatches, !isLoadingDateNextPage else { return }
        isLoadingDateNextPage = true
        defer { isLoadingDateNextPage = false }
        do { try await loadDatePage(datePage + 1, replace: false) } catch { dateError = Self.describe(error) }
    }

    func loadMoreRecents() async {
        guard hasMoreRecents, !isLoadingRecentNextPage else { return }
        isLoadingRecentNextPage = true
        defer { isLoadingRecentNextPage = false }
        do { try await loadRecentPage(recentPage + 1, replace: false) } catch {
            recentError = Self.describe(error)
        }
    }

    private func loadDatePage(_ page: Int, replace: Bool) async throws {
        let filters =
            captureDate.map {
                Self.captureDateFilters(
                    descriptor: descriptor, key: semanticDateKey, captureDate: $0, calendar: calendar)
            } ?? EntityFilterState()
        let result = try await loader(filters, nil, page, "-updatedAt")
        if replace { dateMatches = result.items } else { appendUnique(result.items, to: &dateMatches) }
        dateMeta = result.meta
        datePage = page
        dateError = nil
    }

    /// Recent pages are advanced over duplicate-only same-day pages. The server's total remains
    /// authoritative, so a caller can still reach records beyond a photo's capture day.
    private func loadRecentPage(_ page: Int, replace: Bool) async throws {
        var requestedPage = page
        var first = replace
        repeat {
            let result = try await loader(EntityFilterState(), nil, requestedPage, "-updatedAt")
            let eligible = result.items.filter { !isSameSemanticDayAsCapture($0) }
            if first {
                recentRows = eligible
                first = false
            } else {
                appendUnique(eligible, to: &recentRows)
            }
            recentMeta = result.meta
            recentPage = requestedPage
            recentError = nil
            let canAdvance = eligible.isEmpty && requestedPage * result.meta.pageSize < result.meta.totalCount
            if !canAdvance { return }
            requestedPage += 1
        } while true
    }

    private func isSameSemanticDayAsCapture(_ row: EntityRow) -> Bool {
        guard let captureDate else { return false }
        guard let semanticDateKey, let raw = row.raw[semanticDateKey]?.stringValue else { return false }
        if raw.count >= 10 {
            return String(raw.prefix(10)) == Self.plainDate(captureDate, calendar: calendar)
        }
        guard let parsed = ISO8601DateFormatter().date(from: raw) else { return false }
        return calendar.isDate(parsed, inSameDayAs: captureDate)
    }

    private func appendUnique(_ newRows: [EntityRow], to rows: inout [EntityRow]) {
        var ids = Set(rows.map(\.id))
        rows.append(contentsOf: newRows.filter { ids.insert($0.id).inserted })
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
    private static func plainDate(_ date: Date, calendar: Calendar) -> String {
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
    }

    private static func describe(_ error: Error) -> String {
        if let apiError = error as? CubbyAPIError {
            let code = apiError.detail?.code ?? "HTTP_\(apiError.status)"
            let message = apiError.detail?.message ?? "Request failed"
            return "\(code): \(message)"
        }
        return String(describing: error)
    }
}
