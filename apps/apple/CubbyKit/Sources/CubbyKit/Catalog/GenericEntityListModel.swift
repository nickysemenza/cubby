import Observation

/// Drives a generic Browse list screen for one `EntityDescriptor`. The model owns the complete
/// accumulated result so pagination cannot be lost when a view is recreated or adapted.
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
    public private(set) var meta: PageMeta?
    public private(set) var phase: Phase = .idle
    public private(set) var activity: Activity = .idle
    public private(set) var page = 1
    public private(set) var initialError: String?
    public private(set) var refreshError: String?
    public private(set) var nextPageError: String?

    public var hasMore: Bool {
        guard let meta else { return false }
        return page * meta.pageSize < meta.totalCount
    }

    private let client: CubbyClient
    private let pageSize: Int
    private var requestGeneration = 0
    private var requestTask: Task<ListPage<EntityRow>, Error>?
    private var hasLoaded = false

    public init(descriptor: EntityDescriptor, client: CubbyClient, pageSize: Int = 50) {
        self.descriptor = descriptor
        self.client = client
        self.pageSize = pageSize
    }

    /// Loads the first page once. A failed initial request can be retried, while a successfully
    /// loaded model remains stable when SwiftUI starts the same task again.
    public func loadInitial() async {
        guard !hasLoaded, activity != .loadingInitial else { return }
        await loadFirstPage(as: .loadingInitial)
    }

    /// Replaces the accumulated result with a fresh first page. Existing rows remain visible
    /// while the request is running and if it fails.
    public func refresh() async {
        await loadFirstPage(as: rows.isEmpty && !hasLoaded ? .loadingInitial : .refreshing)
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
        requestTask = Task {
            try Task.checkCancellation()
            return try await client.list(descriptor, page: page, pageSize: pageSize)
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

    static func describe(_ error: Error) -> String {
        if let apiError = error as? CubbyAPIError {
            let code = apiError.detail?.code ?? "HTTP_\(apiError.status)"
            let message = apiError.detail?.message ?? "Request failed"
            return "\(code): \(message)"
        }
        return String(describing: error)
    }
}
