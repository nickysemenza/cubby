import Observation

/// Drives a generic Browse list screen for one `EntityDescriptor`. The model owns the complete
/// accumulated result so pagination cannot be lost when a view is recreated or adapted, the
/// active filters (keyed by wire name), the selected declared view, and — when that view is the
/// timeline — the timeline payload for the same filters.
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
    public private(set) var rows: [EntityRow] = []
    public private(set) var meta: ListPageMeta?
    public private(set) var phase: Phase = .idle
    public private(set) var activity: Activity = .idle
    public private(set) var page = 1
    public private(set) var initialError: String?
    public private(set) var refreshError: String?
    public private(set) var nextPageError: String?
    /// The active filters; `apply(filters:)` replaces them and restarts from page 1.
    public private(set) var filters: EntityFilterState
    /// The selected declared view; `select(view:)` loads the timeline when it is `.timeline`.
    public private(set) var view: ListView
    public private(set) var timeline: EntityTimelineOut?
    public private(set) var timelineError: String?
    public private(set) var isLoadingTimeline = false

    /// Optional rich search state supplied by the host when the entity's generated list route
    /// supports `searchQuery`. Keeping it separate from the base list preserves loaded pages,
    /// selection, and a shelf/timeline view while a query is active.
    public let searchModel: EntityListSearchModel?

    public var isSearching: Bool { !(searchModel?.query.isEmpty ?? true) }

    public var hasMore: Bool {
        guard let meta else { return false }
        return page * meta.pageSize < meta.totalCount
    }

    public var views: [ListView] { descriptor.presentation.listViews }

    private let client: CubbyClient
    private let pageSize: Int
    private let sort: String?
    private var requestGeneration = 0
    private var requestTask: Task<ListPage<EntityRow>, Error>?
    private var hasLoaded = false
    private var timelineGeneration = 0

    public init(
        descriptor: EntityDescriptor,
        client: CubbyClient,
        pageSize: Int = 50,
        sort: String? = nil,
        filters: EntityFilterState = EntityFilterState(),
        view: ListView? = nil,
        searchLoader: EntityListSearchModel.PageLoader? = nil
    ) {
        self.descriptor = descriptor
        self.client = client
        self.pageSize = pageSize
        self.sort = sort
        self.filters = filters
        self.view = view ?? descriptor.presentation.listViews.first ?? .table
        self.searchModel =
            searchLoader.map { EntityListSearchModel(loader: $0) }
            ?? descriptor.primarySearch.map { _ in
                EntityListSearchModel(
                    loader: Self.searchLoader(
                        descriptor: descriptor, client: client, filters: filters, pageSize: pageSize))
            }
    }

    /// Loads the first page once. A failed initial request can be retried, while a successfully
    /// loaded model remains stable when SwiftUI starts the same task again.
    public func loadInitial() async {
        guard !hasLoaded, activity != .loadingInitial else { return }
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
        searchModel?.setLoader(
            Self.searchLoader(
                descriptor: descriptor, client: client, filters: newFilters, pageSize: pageSize))
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
        view = newView
        if newView == .timeline, timeline == nil, !isLoadingTimeline { await loadTimeline() }
    }

    /// `resources.<entity>.timeline` for the active filters. No-op for an entity without one.
    public func loadTimeline() async {
        guard descriptor.key.nativeActions.contains(.timeline) else {
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
            timelineError = Self.describe(error)
        }
        isLoadingTimeline = false
    }

    /// Appends the next page. Duplicate triggers collapse into the one in-flight request, and a
    /// failed request leaves both the accumulated rows and page number unchanged for Retry.
    public func loadNextPage() async {
        guard hasLoaded, hasMore, activity == .idle else { return }
        let nextPage = page + 1
        nextPageError = nil
        activity = .loadingNextPage
        let generation = beginRequest(page: nextPage)

        do {
            let result = try await requestTask!.value
            guard generation == requestGeneration else { return }
            var ids = Set(rows.map(\.id))
            rows.append(contentsOf: result.items.filter { ids.insert($0.id).inserted })
            page = nextPage
            meta = result.meta
            phase = .loaded
        } catch is CancellationError {
            // A refresh or newer request owns the state now.
        } catch {
            guard generation == requestGeneration else { return }
            nextPageError = Self.describe(error)
        }
        finishRequest(generation)
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
        guard descriptor.key.httpActions.contains(.list) else {
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
        let generation = beginRequest(page: 1)

        do {
            let result = try await requestTask!.value
            guard generation == requestGeneration else { return }
            rows = result.items
            page = 1
            meta = result.meta
            hasLoaded = true
            phase = .loaded
        } catch is CancellationError {
            // A newer request owns the state now.
        } catch {
            guard generation == requestGeneration else { return }
            let message = Self.describe(error)
            if rows.isEmpty && !hasLoaded {
                initialError = message
                phase = .failed(message)
            } else {
                refreshError = message
                phase = .loaded
            }
        }
        finishRequest(generation)
    }

    private func beginRequest(page: Int) -> Int {
        requestTask?.cancel()
        requestGeneration += 1
        let generation = requestGeneration
        let client = client
        let descriptor = descriptor
        let pageSize = pageSize
        let sort = sort
        let filters = filters
        requestTask = Task {
            try Task.checkCancellation()
            return try await client.list(
                descriptor, page: page, pageSize: pageSize, sort: sort, filters: filters)
        }
        return generation
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
        descriptor: EntityDescriptor, client: CubbyClient, filters: EntityFilterState, pageSize: Int
    ) -> EntityListSearchModel.PageLoader {
        { query, page in
            var scopedFilters = filters
            scopedFilters.set(.single(query), for: "searchQuery")
            return try await client.list(
                descriptor, page: page, pageSize: pageSize, sort: nil, filters: scopedFilters)
        }
    }

    static func describe(_ error: Error) -> String {
        if let apiError = error as? CubbyAPIError {
            let code = apiError.detail?.code ?? "HTTP_\(apiError.status)"
            let message = apiError.detail?.message ?? "Request failed"
            return "\(code): \(message)"
        }
        return String(describing: error)
    }
}
