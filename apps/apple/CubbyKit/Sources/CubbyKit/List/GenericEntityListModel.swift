import Observation

/// An injected page source for `GenericEntityListModel`, for surfaces whose rows come from
/// something other than the descriptor's declared list (scoped pickers, photo destination lanes,
/// relationship cursors). The model keeps one paginator — request generation,
/// cancellation, ID de-duplication, retry and error state — and the source only answers "page N".
///
/// Contract for `loadPage` / `searchPage`:
/// - `page` is 1-based. Return `ListPage.meta` with the page's `pageSize` and the source's total so
///   `hasMore` (`page * pageSize < totalCount`) is right. A cursor source (relationship pages)
///   maps page N to its offset and reports a total that keeps `hasMore` true until its cursor ends.
/// - Items already shown are dropped by `id`; a page that adds nothing still advances `page`, so a
///   lane policy above the model (photo recents skipping same-day rows) can call `loadNextPage()`
///   again while `hasMore` holds.
/// - A loader may ignore cancellation; a superseded result is discarded by generation.
/// - Eligibility, ranking and lane exclusion stay in the source or its owner, never the model.
///
/// `id` is the scope identity: `setSource(_:)` with an equal `id` is a no-op, so SwiftUI may
/// re-run a `.task` freely; a new `id` drops the old scope's rows and replays an active query.
public struct EntityListPageSource: Sendable {
    public typealias PageLoader = @Sendable (_ page: Int) async throws -> ListPage<EntityRow>

    public let id: any Hashable & Sendable
    public let loadPage: PageLoader
    /// Server-side search inside the same scope; nil when the surface has no query field.
    public let searchPage: EntityListSearchModel.PageLoader?

    public init(
        id: some Hashable & Sendable,
        loadPage: @escaping PageLoader,
        searchPage: EntityListSearchModel.PageLoader? = nil
    ) {
        self.id = id
        self.loadPage = loadPage
        self.searchPage = searchPage
    }
}

/// Drives a generic entity list for one `EntityDescriptor`. The model owns the complete
/// accumulated result so pagination cannot be lost when a view is recreated or adapted, the
/// active filters (keyed by wire name), the selected declared view, and — when that view is the
/// timeline — the timeline payload for the same filters. Pages come from the descriptor's
/// declared list route unless the host injects an `EntityListPageSource`.
@MainActor
@Observable
public final class GenericEntityListModel {
    public enum Phase: Equatable {
        case idle
        case loading
        case loaded
        case unavailable(String)
        case failed(String)
    }

    public enum Activity: Equatable {
        case idle
        case loadingInitial
        case refreshing
        case loadingNextPage
    }

    public let descriptor: EntityDescriptor
    private var coreRows: [EntityRow] = []
    public var rows: [EntityRow] { coreRows }
    public private(set) var meta: ListPageMeta?
    public private(set) var phase: Phase = .idle
    public private(set) var activity: Activity = .idle
    public private(set) var page = 1
    public private(set) var initialError: String?
    public private(set) var refreshError: String?
    public private(set) var nextPageError: String?
    /// The active filters; `apply(filters:)` replaces them and restarts from page 1.
    public private(set) var filters: EntityFilterState
    /// Server order for the complete result, shared by base and search pagination.
    public private(set) var sort: String?
    public private(set) var resultMembership: ListResultMembership = .known

    public var canSelectResultMembership: Bool {
        guard source == nil, view == .table || view == .shelf else { return false }
        switch descriptor.key.nativeReadKind {
        case .kernel: return true
        default: return false
        }
    }
    /// The selected declared view; `select(view:)` loads the timeline when it is `.timeline`.
    public private(set) var view: ListView
    public private(set) var groupDimensions: [ListGroupDimension] = []
    /// The existing native menu edits the opening dimension; supplied views retain the full path.
    public var groupBy: String? { groupDimensions.first?.key }
    public var groupLevel: Int? { groupDimensions.first?.level }
    private var memberships: [(id: String, path: [String])] = []
    public private(set) var timeline: EntityTimelineOut?
    public private(set) var timelineError: String?
    public private(set) var isLoadingTimeline = false

    /// Optional rich search state supplied by the host when the entity declares a primary search
    /// wire. Keeping it separate from the base list preserves loaded pages, selection, and the
    /// selected cards/timeline view while a query is active.
    public private(set) var searchModel: EntityListSearchModel?

    public var isSearching: Bool { !(searchModel?.query.isEmpty ?? true) }

    public var hasMore: Bool {
        guard let meta else { return false }
        return page * meta.pageSize < (meta.membershipCount ?? meta.totalCount)
    }

    /// Metadata is only presented as current while its last refresh succeeded.
    public var summaryMeta: ListPageMeta? {
        guard activity == .idle, refreshError == nil else { return nil }
        return meta
    }

    public var views: [ListView] { descriptor.presentation.listViews }

    /// Why the list cannot group right now, shown on every Group by choice: Timeline is already
    /// arranged by date, and search results are ranked by match. `groupBy` is kept and returns
    /// when the reason clears.
    public var groupByUnavailableReason: String? {
        if view == .timeline { return "Timeline is already arranged by date." }
        if isSearching { return "Search results are ordered by match." }
        return nil
    }

    /// The active Group by choice, nil while `groupByUnavailableReason` applies.
    public var groupChoice: GroupChoice? {
        groupByUnavailableReason == nil ? descriptor.groupChoice(groupBy) : nil
    }

    /// The level the request groups at: `groupLevel` when the active choice offers it.
    public var activeGroupLevel: Int? {
        guard let choice = groupChoice, let groupLevel, groupLevel <= choice.levels else { return nil }
        return groupLevel
    }

    /// Why the list cannot group at a level right now, shown under the level choices: the
    /// reason Group by is unavailable, no Group by choice, or the choice's declared reason.
    public var groupLevelUnavailableReason: String? {
        if let reason = groupByUnavailableReason { return reason }
        guard let choice = groupChoice else { return "Group by a field first." }
        return choice.levelReason
    }

    /// The loaded base rows in the server's sections, or nil when the list is not grouped.
    public var sections: [EntityListSection]? {
        guard groupChoice != nil, let groups = meta?.groups else { return nil }
        return EntityListSection.sections(
            rows: rows,
            groups: groups.map {
                (key: $0.key, path: $0.path, label: $0.label, count: $0.count, subtree: $0.subtree ?? false)
            }, memberships: memberships)
    }

    public var activeSavedView: SavedView? {
        descriptor.presentation.savedViews.first { savedView in
            filters == savedView.filterState && sort == savedView.sortParameter
        }
    }

    private let client: CubbyClient
    private let pageSize: Int
    private let searchDebounceNanoseconds: UInt64
    private var source: EntityListPageSource?
    private var requestGeneration = 0
    /// Owns both the load and response application, so joiners resume only after rows and page
    /// state have advanced. A caller's cancellation never cancels a still-wanted page.
    private var requestTask: Task<Void, Never>?
    private var hasLoaded = false
    private var timelineGeneration = 0

    public init(
        descriptor: EntityDescriptor,
        client: CubbyClient,
        pageSize: Int = 50,
        sort: String? = nil,
        filters: EntityFilterState = EntityFilterState(),
        view: ListView? = nil,
        groupBy: String? = nil,
        groupLevel: Int? = nil,
        groupDimensions: [ListGroupDimension]? = nil,
        searchLoader: EntityListSearchModel.PageLoader? = nil,
        searchDebounceNanoseconds: UInt64 = 250_000_000
    ) {
        self.descriptor = descriptor
        self.client = client
        self.pageSize = pageSize
        self.sort = sort
        self.searchDebounceNanoseconds = searchDebounceNanoseconds
        self.filters = filters
        let selectedView = view ?? descriptor.presentation.listViews.first ?? .table
        self.view = selectedView
        if let groupDimensions {
            self.groupDimensions = groupDimensions
        } else if let key = descriptor.groupChoice(groupBy)?.id {
            self.groupDimensions = [.init(key: key, level: groupLevel)]
        }
        self.searchModel =
            searchLoader.map {
                EntityListSearchModel(
                    debounceNanoseconds: searchDebounceNanoseconds, loader: $0)
            }
            ?? descriptor.primarySearch.map { _ in
                EntityListSearchModel(
                    debounceNanoseconds: searchDebounceNanoseconds,
                    loader: Self.searchLoader(
                        descriptor: descriptor, client: client, filters: filters,
                        pageSize: pageSize, sort: sort, resultMembership: resultMembership))
            }
    }

    /// A list whose pages come from `source`; see `EntityListPageSource` for the contract. The
    /// declared filters, sort, page size and timeline do not apply to an injected source.
    public init(
        descriptor: EntityDescriptor,
        client: CubbyClient,
        source: EntityListPageSource,
        view: ListView = .table,
        searchDebounceNanoseconds: UInt64 = 250_000_000
    ) {
        self.descriptor = descriptor
        self.client = client
        self.pageSize = 50
        self.sort = nil
        self.searchDebounceNanoseconds = searchDebounceNanoseconds
        self.filters = EntityFilterState()
        self.view = view
        self.source = source
        self.searchModel = source.searchPage.map {
            EntityListSearchModel(debounceNanoseconds: searchDebounceNanoseconds, loader: $0)
        }
    }

    /// Replaces the injected source when its scope identity changes. The old scope's rows,
    /// totals and in-flight pages are discarded (a chooser tap must never land on a row from the
    /// previous scope); an active query is kept and replayed against the new source.
    public func setSource(_ newSource: EntityListPageSource) async {
        guard source.map({ AnyHashable($0.id) != AnyHashable(newSource.id) }) ?? true else { return }
        source = newSource
        cancelRequest()
        coreRows = []
        meta = nil
        page = 1
        hasLoaded = false
        // A timeline describes the declared filters, never an injected scope: drop a loaded one
        // and let a pending response fail its generation check.
        timelineGeneration += 1
        timeline = nil
        timelineError = nil
        isLoadingTimeline = false
        if let searchPage = newSource.searchPage, let searchModel {
            searchModel.setLoader(searchPage, discardingRows: true)
        } else {
            let query = searchModel?.query ?? ""
            searchModel?.clear()
            searchModel = newSource.searchPage.map {
                EntityListSearchModel(debounceNanoseconds: searchDebounceNanoseconds, loader: $0)
            }
            searchModel?.setQuery(query)
        }
        await loadFirstPage(as: .loadingInitial)
    }

    /// Loads the first page once. A failed initial request can be retried, while a successfully
    /// loaded model remains stable when SwiftUI starts the same task again. An in-flight refresh
    /// is joined before returning, so callers evaluate its replacement rows rather than the cache.
    public func loadInitial() async {
        if activity == .loadingInitial || activity == .refreshing, let requestTask {
            await requestTask.value
            return
        }
        guard !hasLoaded else { return }
        await loadFirstPage(as: .loadingInitial)
        if view == .timeline { await loadTimeline() }
    }

    /// Replaces the accumulated result with a fresh first page. Existing rows remain visible
    /// while the request is running and if it fails.
    public func refresh() async {
        await loadFirstPage(as: rows.isEmpty && !hasLoaded ? .loadingInitial : .refreshing)
        if view == .timeline { await loadTimeline() }
    }

    /// Replaces the filters and restarts from page 1 (and reloads the timeline when shown).
    public func apply(filters newFilters: EntityFilterState) async {
        guard newFilters != filters else { return }
        filters = newFilters
        await refreshQuery()
    }

    /// Keeps filters intact while selecting known matches or unresolved candidates.
    public func apply(resultMembership newMembership: ListResultMembership) async {
        guard canSelectResultMembership, newMembership != resultMembership,
            newMembership == .known || newMembership == .unresolved
        else { return }
        resultMembership = newMembership
        await refreshQuery()
    }

    /// Apply filters, ordering and grouping together so a saved view never sends an
    /// intermediate scope. An empty supplied grouping restores an ungrouped list.
    public func apply(savedView: SavedView) async {
        guard source == nil else { return }
        let newFilters = savedView.filterState
        let newSort = savedView.sortParameter
        let newDimensions = savedView.groupBy
        // The view mode is not part of active-view matching (`activeSavedView`): switching it
        // never changes the query, so it must not depend on whether the query changed.
        if let newView = savedView.listView(in: descriptor) { await select(view: newView) }
        guard
            filters != newFilters || sort != newSort || groupDimensions != newDimensions
        else { return }
        filters = newFilters
        sort = newSort
        groupDimensions = newDimensions
        await refreshQuery()
    }

    /// Groups the declared list by a `model.grouping` choice, or flattens it with nil. A choice
    /// with a reason it cannot group is ignored.
    public func apply(groupBy newGroupBy: String?) async {
        guard source == nil else { return }
        let resolved = descriptor.groupChoice(newGroupBy)?.id
        guard resolved == newGroupBy, resolved != groupBy || groupDimensions.count > 1 else { return }
        groupDimensions = resolved.map { [.init(key: $0)] } ?? []
        await refreshQuery()
    }

    /// Groups each row under its ancestor at `level` (1 = top), or by the exact value with nil.
    /// A level the active choice does not offer is ignored.
    public func apply(groupLevel level: Int?) async {
        guard source == nil, let choice = groupChoice, level != groupLevel else { return }
        if let level, !(1...max(1, choice.levels)).contains(level) || choice.levels == 0 { return }
        if let first = groupDimensions.first {
            groupDimensions[0] = .init(key: first.key, level: level, bucket: first.bucket)
        }
        await refreshQuery()
    }

    /// "Filter to this" on a section header; see `EntityDescriptor.filtering(_:to:of:)`.
    public func filter(to section: EntityListSection) async {
        guard groupChoice != nil else { return }
        var next = filters
        for (dimension, value) in zip(groupDimensions, section.path) {
            guard let choice = descriptor.groupChoice(dimension.key),
                let filtered = descriptor.filtering(
                    next,
                    to: .init(
                        id: value, label: section.label,
                        count: section.count, subtree: dimension.level != nil, rows: []), of: choice)
            else { return }
            next = filtered
        }
        await apply(filters: next)
    }

    /// "Hide" on a section header; see `EntityDescriptor.hiding(_:section:of:)`.
    public func hide(_ section: EntityListSection) async {
        guard groupDimensions.count == 1, let choice = groupChoice,
            let next = descriptor.hiding(filters, section: section, of: choice)
        else { return }
        await apply(filters: next)
    }

    /// Sortable fields come from the same declaration the server validates. Injected page
    /// sources own their ordering and cannot be reordered through the declared list route.
    public func apply(sort newSort: String?) async {
        guard source == nil, newSort != sort else { return }
        if let newSort {
            let field = newSort.hasPrefix("-") ? String(newSort.dropFirst()) : newSort
            guard descriptor.sortFields.contains(field) else { return }
        }
        sort = newSort
        await refreshQuery()
    }

    private func refreshQuery() async {
        meta = nil
        coreRows = rows
        if source == nil {
            searchModel?.setLoader(
                Self.searchLoader(
                    descriptor: descriptor, client: client, filters: filters,
                    pageSize: pageSize, sort: sort, resultMembership: resultMembership))
        }
        await refresh()
    }

    /// Updates the optional rich-search adapter. The base list remains intact while searching;
    /// views can render `searchModel.rows` and fall back to `rows` after `clearSearch()`.
    public func setSearchQuery(_ query: String) {
        searchModel?.setQuery(query)
    }

    public func clearSearch() {
        searchModel?.clear()
    }

    /// Switches the declared view; the timeline loads on first selection and after filter changes.
    public func select(view newView: ListView) async {
        let resetsMembership = resultMembership != .known && newView != .table && newView != .shelf
        view = newView
        if resetsMembership {
            resultMembership = .known
            await refreshQuery()
            return
        }
        if source == nil {
            searchModel?.setLoader(
                Self.searchLoader(
                    descriptor: descriptor, client: client, filters: filters, pageSize: pageSize,
                    sort: sort, resultMembership: resultMembership))
        }
        if newView == .timeline, timeline == nil, !isLoadingTimeline { await loadTimeline() }
    }

    /// `resources.<entity>.timeline` for the active filters. No-op for an entity without one or
    /// a list fed by an injected source, whose scope the declared filters do not describe.
    public func loadTimeline() async {
        guard source == nil, descriptor.key.nativeActions.contains(.timeline) else {
            timelineError = "No timeline for \(descriptor.plural)"
            return
        }
        timelineGeneration += 1
        let generation = timelineGeneration
        isLoadingTimeline = true
        timelineError = nil
        do {
            let result = try await client.timeline(descriptor, filters: filters)
            guard generation == timelineGeneration else { return }
            timeline = result
        } catch {
            guard generation == timelineGeneration else { return }
            timelineError = error.userMessage
        }
        isLoadingTimeline = false
    }

    /// Appends the next page. Duplicate triggers wait for the same in-flight request to apply its
    /// rows; a failed request leaves the accumulated rows and page number unchanged for Retry.
    public func loadNextPage() async {
        if activity == .loadingNextPage, let requestTask {
            await requestTask.value
            return
        }
        guard hasLoaded, hasMore, activity == .idle else { return }
        let nextPage = page + 1
        nextPageError = nil
        activity = .loadingNextPage
        await beginRequest(page: nextPage, as: .loadingNextPage).value
    }

    /// Compatibility for callers migrating from page-driven ownership. New code should use the
    /// three intent-named operations above.
    public func load(page requestedPage: Int = 1) async {
        if requestedPage <= 1 {
            if hasLoaded {
                await refresh()
            } else {
                await loadInitial()
            }
        } else if requestedPage == page + 1 {
            await loadNextPage()
        }
    }

    private func loadFirstPage(as requestedActivity: Activity) async {
        guard source != nil || descriptor.key.nativeActions.contains(.list) else {
            cancelRequest()
            let message = "No list route for \(descriptor.plural)"
            initialError = message
            phase = .unavailable(message)
            return
        }

        initialError = nil
        refreshError = nil
        nextPageError = nil
        activity = requestedActivity
        if requestedActivity == .loadingInitial { phase = .loading }
        coreRows = rows
        await beginRequest(page: 1, as: requestedActivity).value
    }

    private func beginRequest(page requestedPage: Int, as requestedActivity: Activity) -> Task<Void, Never> {
        requestTask?.cancel()
        requestGeneration += 1
        let generation = requestGeneration
        let loadPage = source?.loadPage ?? declaredListLoader()
        let task = Task {
            do {
                try Task.checkCancellation()
                let result = try await loadPage(requestedPage)
                guard generation == requestGeneration else { return }
                let replacing = requestedActivity != .loadingNextPage
                if replacing {
                    coreRows = result.items
                    hasLoaded = true
                } else {
                    var ids = Set(rows.map(\.id))
                    coreRows.append(contentsOf: result.items.filter { ids.insert($0.id).inserted })
                }
                page = requestedPage
                if replacing { memberships = [] }
                memberships.append(
                    contentsOf: (result.meta.memberships ?? []).map { (id: $0.id, path: $0.path) })
                meta = result.meta
                phase = .loaded
            } catch is CancellationError {
                // A refresh or newer request owns the state now.
            } catch {
                guard generation == requestGeneration else { return }
                let message = error.userMessage
                if requestedActivity == .loadingNextPage {
                    nextPageError = message
                } else if rows.isEmpty && !hasLoaded {
                    initialError = message
                    phase = .failed(message)
                } else {
                    refreshError = message
                    phase = .loaded
                }
            }
            finishRequest(generation)
        }
        requestTask = task
        return task
    }

    /// The descriptor's list route for the current filters, sort and view.
    private func declaredListLoader() -> EntityListPageSource.PageLoader {
        let client = client
        let descriptor = descriptor
        let pageSize = pageSize
        let sort = sort
        let filters = filters
        let resultMembership = resultMembership
        let dimensions = groupByUnavailableReason == nil ? groupDimensions : []
        return { page in
            return try await client.list(
                descriptor, page: page, pageSize: pageSize, sort: sort, filters: filters,
                groupBy: dimensions, resultMembership: resultMembership)
        }
    }

    private func finishRequest(_ generation: Int) {
        guard generation == requestGeneration else { return }
        requestTask = nil
        activity = .idle
    }

    private func cancelRequest() {
        requestTask?.cancel()
        requestTask = nil
        requestGeneration += 1
        activity = .idle
    }

    private static func searchLoader(
        descriptor: EntityDescriptor, client: CubbyClient, filters: EntityFilterState, pageSize: Int,
        sort: String?, resultMembership: ListResultMembership = .known
    ) -> EntityListSearchModel.PageLoader {
        { query, page in
            guard let primarySearch = descriptor.primarySearch else {
                throw EntityOperationError.unsupported(descriptor.key, .search)
            }
            var scopedFilters = filters
            scopedFilters.set([query], for: primarySearch.key)
            return try await client.list(
                descriptor, page: page, pageSize: pageSize, sort: sort, filters: scopedFilters,
                resultMembership: resultMembership)
        }
    }
}
